import { randomUUID } from 'node:crypto';
import { getAddress, type Address, type Hash } from 'viem';
import { sqlState, type Db, type Queryable } from './db';
import { evaluatePolicy } from './policy';
import { reconcileTransfer, type ReceiptClient, type ReconcileResult } from './reconcile';
import * as repo from './repo';
import type { AgentStats, DecisionRow, DecisionWithPayment, ReconRow } from './repo';
import type { KeyRing } from './keys';
import { mandateStatus, type AuthorizeInput, type MandateRecord, type MandateStatus, type MandateTerms, type Verdict } from './types';
import { signVerdict } from './verdict';
import { utcDayStart } from './units';

/** An error that maps cleanly onto an HTTP response. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ServiceDeps {
  db: Db;
  keys: KeyRing;
  chain: ReceiptClient;
  /** USDC contract address on the target chain. */
  token: Address;
  chainId: number;
  /** The `iss` claim, and the base URL of the JWKS. */
  issuer: string;
  /** Injectable clock, so tests control "now". */
  now?: () => Date;
}

export interface TrailEvent {
  at: Date;
  type: 'authorization_requested' | 'verdict_issued' | 'reconciliation_pending' | 'reconciliation_matched' | 'reconciliation_mismatch';
  detail: Record<string, unknown>;
}

export interface DecisionDetail {
  decision: DecisionRow;
  mandate: MandateRecord | null;
  reconciliations: ReconRow[];
  trail: TrailEvent[];
}

export interface AgentSummary {
  mandate: MandateRecord;
  status: MandateStatus;
  allowedToday: bigint;
  stats: AgentStats | null;
}

export class MandateService {
  private readonly db: Db;
  private readonly keys: KeyRing;
  private readonly chain: ReceiptClient;
  readonly token: Address;
  readonly chainId: number;
  readonly issuer: string;
  private readonly now: () => Date;

  constructor(deps: ServiceDeps) {
    this.db = deps.db;
    this.keys = deps.keys;
    this.chain = deps.chain;
    this.token = deps.token;
    this.chainId = deps.chainId;
    this.issuer = deps.issuer;
    this.now = deps.now ?? (() => new Date());
  }

  /** The public keys served at /.well-known/jwks.json. */
  jwks() {
    return this.keys.jwks();
  }

  // ================================================================ mandates

  /** The first mandate for an agent (or a fresh one after the last was revoked or expired). */
  async createMandate(agentId: string, terms: MandateTerms): Promise<MandateRecord> {
    const now = this.now();
    this.assertTerms(terms, now);
    const id = randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        const current = await repo.currentMandate(tx, agentId, true);
        if (current && mandateStatus(current, now) === 'active') {
          throw new AppError(409, 'mandate_exists', `Agent already has an active mandate (v${current.version}); replace it instead`, {
            mandateId: current.id,
          });
        }
        await repo.insertMandate(tx, { id, agentId, version: (current?.version ?? 0) + 1, createdAt: now, ...terms });
      });
    } catch (err) {
      throw conflict(err);
    }
    return (await this.requireMandate(id))!;
  }

  /**
   * Revoke-and-replace. Mandates are never edited: this inserts the next version, and records a
   * revocation of the old one that points at it, in ONE transaction. There is no moment where the
   * agent has no mandate, or two.
   */
  async replaceMandate(id: string, terms: MandateTerms, reason: string): Promise<MandateRecord> {
    const now = this.now();
    this.assertTerms(terms, now);
    const newId = randomUUID();
    try {
      await this.db.transaction(async (tx) => {
        const old = await repo.getMandate(tx, id, true);
        if (!old) throw new AppError(404, 'mandate_not_found', 'No such mandate');
        if (old.revokedAt) throw new AppError(409, 'already_revoked', 'This mandate has already been revoked');
        const current = await repo.currentMandate(tx, old.agentId);
        if (current && current.id !== old.id) {
          throw new AppError(409, 'not_current', `Only the current mandate (v${current.version}) can be replaced`);
        }
        await repo.insertMandate(tx, { id: newId, agentId: old.agentId, version: old.version + 1, createdAt: now, ...terms });
        await repo.insertRevocation(tx, { mandateId: old.id, revokedAt: now, reason, replacedBy: newId });
      });
    } catch (err) {
      throw conflict(err);
    }
    return (await this.requireMandate(newId))!;
  }

  /** Revoke without a replacement. The agent is denied (mandate_revoked) until a new mandate is created. */
  async revokeMandate(id: string, reason: string): Promise<MandateRecord> {
    const now = this.now();
    try {
      await this.db.transaction(async (tx) => {
        const m = await repo.getMandate(tx, id, true);
        if (!m) throw new AppError(404, 'mandate_not_found', 'No such mandate');
        if (m.revokedAt) throw new AppError(409, 'already_revoked', 'This mandate has already been revoked');
        await repo.insertRevocation(tx, { mandateId: id, revokedAt: now, reason, replacedBy: null });
      });
    } catch (err) {
      throw conflict(err);
    }
    return (await this.requireMandate(id))!;
  }

  async getMandate(id: string): Promise<MandateRecord> {
    return this.requireMandate(id);
  }

  listMandates(agentId?: string): Promise<MandateRecord[]> {
    return repo.listMandates(this.db, agentId);
  }

  private async requireMandate(id: string): Promise<MandateRecord> {
    const m = await repo.getMandate(this.db, id);
    if (!m) throw new AppError(404, 'mandate_not_found', 'No such mandate');
    return m;
  }

  private assertTerms(t: MandateTerms, now: Date): void {
    if (t.perTxLimit > t.dailyLimit) throw new AppError(400, 'invalid_mandate', 'perTxLimit cannot exceed dailyLimit');
    if (t.expiresAt.getTime() <= now.getTime()) throw new AppError(400, 'invalid_mandate', 'expiresAt must be in the future');
  }

  // ================================================================ authorization

  /**
   * Answer a spend request: evaluate it against the agent's current mandate, sign the verdict,
   * and append it to the decision log, all in one transaction.
   *
   * Why that makes the daily limit race-proof: the agent's mandate row is locked (FOR UPDATE) for
   * the whole transaction, so concurrent authorizations for one agent run one after another. Each
   * then reads "spent today" AFTER the previous one committed, and the check and the insert can't
   * be split by another request.
   *
   * Both outcomes are logged and both are signed: a deny verdict is evidence too. A verifier will
   * refuse a deny verdict (`verdict_denied`).
   */
  async authorize(input: AuthorizeInput): Promise<DecisionRow> {
    const now = this.now();
    const id = randomUUID();

    return this.db.transaction(async (tx) => {
      const mandate = await repo.currentMandate(tx, input.agentId, true);
      const spentToday = mandate ? await repo.allowedSpendSince(tx, input.agentId, new Date(utcDayStart(now))) : 0n;
      const result = evaluatePolicy(input, mandate, spentToday, now);

      const signed = await signVerdict(
        this.keys,
        this.issuer,
        {
          id,
          agentId: input.agentId,
          verdict: result.verdict,
          reasonCode: result.code,
          amount: input.amount,
          currency: input.currency,
          recipient: input.recipient,
          category: input.category,
          chainId: this.chainId,
          token: this.token,
          mandateId: mandate?.id ?? null,
          mandateVersion: mandate?.version ?? null,
        },
        now,
      );

      const row: Omit<DecisionRow, 'seq'> = {
        id,
        agentId: input.agentId,
        mandateId: mandate?.id ?? null,
        mandateVersion: mandate?.version ?? null,
        amount: input.amount,
        currency: input.currency,
        recipient: input.recipient,
        category: input.category,
        verdict: result.verdict,
        reasonCode: result.code,
        reason: result.reason,
        nonce: signed.claims.nonce,
        token: signed.token,
        claims: signed.claims as unknown as Record<string, unknown>,
        issuedAt: signed.issuedAt,
        expiresAt: signed.expiresAt,
        createdAt: now,
      };
      await repo.insertDecision(tx, row);
      return { ...row, seq: 0 };
    });
  }

  listDecisions(filter: { verdict?: Verdict; agentId?: string; limit?: number } = {}): Promise<DecisionWithPayment[]> {
    return repo.listDecisions(this.db, filter);
  }

  /** One decision with its mandate, every reconciliation attempt, and a request-to-transaction trail. */
  async getDecisionDetail(id: string): Promise<DecisionDetail> {
    const decision = await this.requireDecision(id);
    const [mandate, reconciliations] = await Promise.all([
      decision.mandateId ? repo.getMandate(this.db, decision.mandateId) : Promise.resolve(null),
      repo.listRecons(this.db, id),
    ]);

    const trail: TrailEvent[] = [
      {
        at: decision.createdAt,
        type: 'authorization_requested',
        detail: {
          agentId: decision.agentId,
          amount: decision.amount.toString(),
          currency: decision.currency,
          recipient: decision.recipient,
          category: decision.category,
        },
      },
      {
        at: decision.createdAt,
        type: 'verdict_issued',
        detail: {
          verdict: decision.verdict,
          reasonCode: decision.reasonCode,
          reason: decision.reason,
          mandateVersion: decision.mandateVersion,
          expiresAt: decision.expiresAt.toISOString(),
        },
      },
      ...reconciliations.map(
        (r): TrailEvent => ({
          at: r.createdAt,
          type: `reconciliation_${r.status}`,
          detail: { txHash: r.txHash, reason: r.reason, detail: r.detail, blockNumber: r.blockNumber?.toString() ?? null },
        }),
      ),
    ];
    return { decision, mandate, reconciliations, trail };
  }

  private async requireDecision(id: string): Promise<DecisionRow> {
    const d = await repo.getDecision(this.db, id);
    if (!d) throw new AppError(404, 'decision_not_found', 'No such decision');
    return d;
  }

  // ================================================================ onchain reconciliation

  /** Attach a Base Sepolia transaction hash to an ALLOWED decision and compare it to the verdict. */
  async attachPayment(decisionId: string, txHash: Hash): Promise<ReconRow> {
    return this.reconcile(decisionId, txHash.toLowerCase() as Hash);
  }

  /** Run the check again against the transaction already attached (e.g. it was still pending). */
  async recheckPayment(decisionId: string): Promise<ReconRow> {
    await this.requireDecision(decisionId);
    const latest = (await repo.listRecons(this.db, decisionId)).at(-1);
    if (!latest) throw new AppError(404, 'no_payment', 'No transaction has been attached to this decision');
    if (latest.status === 'matched') return latest;
    return this.reconcile(decisionId, latest.txHash);
  }

  private async reconcile(decisionId: string, txHash: Hash): Promise<ReconRow> {
    const decision = await this.requireDecision(decisionId);
    if (decision.verdict !== 'allow') {
      throw new AppError(409, 'not_allowed', 'Only allowed decisions can be paid, so there is nothing to reconcile');
    }
    await this.assertPayable(decisionId, txHash);

    const mandate = decision.mandateId ? await repo.getMandate(this.db, decision.mandateId) : null;
    let result: ReconcileResult;
    try {
      // The VERDICT is the source of truth: its token, recipient and amount, not whatever the mandate says now.
      result = await reconcileTransfer(this.chain, txHash, {
        token: decision.claims.token as Address,
        recipient: decision.recipient,
        amount: decision.amount,
        from: mandate?.payerAddress ?? null,
      });
    } catch (err) {
      throw new AppError(502, 'rpc_error', `Could not read the chain: ${(err as Error).message}`);
    }

    try {
      await this.db.transaction(async (tx) => {
        // The chain read took a while: re-check inside the transaction that nobody matched meanwhile.
        await this.assertPayable(decisionId, txHash, tx);
        await repo.insertRecon(tx, {
          decisionId,
          txHash,
          status: result.status,
          reason: result.reason,
          detail: result.detail,
          blockNumber: result.blockNumber,
          actualFrom: result.actual?.from ?? null,
          actualRecipient: result.actual?.to ?? null,
          actualAmount: result.actual?.amount ?? null,
          createdAt: this.now(),
        });
      });
    } catch (err) {
      // The partial unique indexes are the backstop if two requests race past the checks above.
      if (sqlState(err) === '23505') {
        throw new AppError(409, 'tx_already_used', 'That transaction has already been matched to a payment');
      }
      throw err;
    }
    return (await repo.listRecons(this.db, decisionId)).at(-1)!;
  }

  private async assertPayable(decisionId: string, txHash: Hash, q: Queryable = this.db): Promise<void> {
    const recons = await repo.listRecons(q, decisionId);
    if (recons.some((r) => r.status === 'matched')) {
      throw new AppError(409, 'already_matched', 'This decision already has a matched payment');
    }
    const owner = await repo.matchedDecisionForTx(q, txHash);
    if (owner && owner !== decisionId) {
      throw new AppError(409, 'tx_already_used', `That transaction is already matched to decision ${owner}`);
    }
  }

  // ================================================================ dashboard

  async summary(): Promise<AgentSummary[]> {
    const now = this.now();
    const since = new Date(utcDayStart(now));
    const [mandates, stats] = await Promise.all([repo.listMandates(this.db), repo.agentStats(this.db, since)]);
    const byAgent = new Map(stats.map((s) => [s.agentId, s]));

    const current = new Map<string, MandateRecord>();
    for (const m of mandates) {
      const seen = current.get(m.agentId);
      if (!seen || m.version > seen.version) current.set(m.agentId, m);
    }
    return [...current.values()].map((mandate) => ({
      mandate,
      status: mandateStatus(mandate, now),
      allowedToday: byAgent.get(mandate.agentId)?.allowedToday ?? 0n,
      stats: byAgent.get(mandate.agentId) ?? null,
    }));
  }
}

/** Turn a unique-constraint violation (two writers raced) into a clean 409. */
function conflict(err: unknown): unknown {
  if (err instanceof AppError) return err;
  if (sqlState(err) === '23505') {
    return new AppError(409, 'conflict', 'The mandate was changed by someone else at the same time; reload and try again');
  }
  return err;
}

/** Normalise user-supplied addresses to EIP-55 checksum form. Throws on invalid input. */
export function normalizeAddress(value: string): Address {
  return getAddress(value);
}
