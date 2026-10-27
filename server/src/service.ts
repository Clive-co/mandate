import { randomUUID } from 'node:crypto';
import { getAddress, type Address, type Hash } from 'viem';
import { checkHardRules, evaluatePolicy } from './policy';
import { DecisionSigner, type DecisionMessage } from './signing';
import type { DecisionRow, PaymentRow, RequestRow, Store } from './store';
import { traceTransfer, type ReceiptClient, type TraceResult } from './tracing';
import type { Mandate, Outcome, Reason } from './types';
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
  store: Store;
  signer: DecisionSigner;
  chain: ReceiptClient;
  /** USDC contract address on the target chain. */
  token: Address;
  /** Injectable clock, so tests control "today". */
  now?: () => Date;
}

export interface SubmitInput {
  agentId: string;
  recipient: Address;
  amount: bigint;
  memo?: string | null;
}

export interface RequestDetail {
  request: RequestRow;
  mandate: Mandate | null;
  decisions: DecisionRow[];
  payment: PaymentRow | null;
  events: ReturnType<Store['listEvents']>;
}

export interface AgentSummary {
  mandate: Mandate;
  spentToday: bigint;
  pendingApprovals: number;
  counts: Record<Outcome, number>;
  confirmedOnchain: bigint;
  mismatches: number;
  pendingPayments: number;
}

export class MandateService {
  private readonly store: Store;
  private readonly signer: DecisionSigner;
  private readonly chain: ReceiptClient;
  private readonly token: Address;
  private readonly now: () => Date;

  constructor(deps: ServiceDeps) {
    this.store = deps.store;
    this.signer = deps.signer;
    this.chain = deps.chain;
    this.token = deps.token;
    this.now = deps.now ?? (() => new Date());
  }

  get signerAddress(): Address {
    return this.signer.address;
  }

  // ---------------------------------------------------------------- mandates

  upsertMandate(m: Mandate): Mandate {
    this.store.upsertMandate(m);
    return m;
  }

  // ---------------------------------------------------------------- requests

  /**
   * An agent asks to spend. The policy check, the "spent today" read and the insert happen in
   * ONE synchronous transaction, so two concurrent requests can't both slip under the daily
   * limit. Signing is async, so it happens after: the request row (and its status) is already
   * durable, and the signed decision is attached right after.
   */
  async submitRequest(input: SubmitInput): Promise<{ request: RequestRow; decision: DecisionRow }> {
    const now = this.now();
    const id = randomUUID();

    const { request, reasons } = this.store.transaction(() => {
      const mandate = this.store.getMandate(input.agentId);
      const spentToday = mandate ? this.store.approvedSpendSince(input.agentId, utcDayStart(now)) : 0n;
      const result = evaluatePolicy({ amount: input.amount, recipient: input.recipient }, mandate, spentToday);

      const row: RequestRow = {
        id,
        agentId: input.agentId,
        recipient: input.recipient,
        amount: input.amount,
        memo: input.memo ?? null,
        status: result.outcome,
        createdAt: now.getTime(),
        decidedAt: result.outcome === 'needs_approval' ? null : now.getTime(),
      };
      this.store.insertRequest(row);
      this.store.addEvent(
        id,
        'request_submitted',
        { agentId: input.agentId, recipient: input.recipient, amount: input.amount.toString(), memo: row.memo },
        now.getTime(),
      );
      return { request: row, reasons: result.reasons };
    });

    const decision = await this.signAndRecord(request, request.status, 'policy', reasons);
    return { request, decision };
  }

  /**
   * A human approves or rejects a queued request.
   * Approving re-checks the HARD rules against today's spend: a human can approve an unknown
   * recipient, but cannot approve their way past a per-payment or daily limit.
   */
  async resolveRequest(
    requestId: string,
    action: 'approve' | 'reject',
    actor: string,
  ): Promise<{ request: RequestRow; decision: DecisionRow }> {
    const now = this.now();

    const { request, reasons } = this.store.transaction(() => {
      const existing = this.store.getRequest(requestId);
      if (!existing) throw new AppError(404, 'request_not_found', 'No such request');
      if (existing.status !== 'needs_approval') {
        throw new AppError(409, 'not_pending', `Request is already ${existing.status}`);
      }

      let outcome: Outcome = 'denied';
      let reasons: Reason[] = [{ code: 'rejected_by_human', message: `Rejected by ${actor}` }];

      if (action === 'approve') {
        const mandate = this.store.getMandate(existing.agentId);
        const spentToday = this.store.approvedSpendSince(existing.agentId, utcDayStart(now));
        const violations = checkHardRules(
          { amount: existing.amount, recipient: existing.recipient },
          mandate,
          spentToday,
        );
        if (violations.length > 0) {
          throw new AppError(
            409,
            'hard_rule_violation',
            'This request now breaks a hard limit and cannot be approved. You can still reject it.',
            violations,
          );
        }
        outcome = 'approved';
        reasons = [];
      }

      this.store.setRequestStatus(requestId, outcome, now.getTime());
      this.store.addEvent(requestId, 'human_resolved', { action, actor }, now.getTime());
      return { request: { ...existing, status: outcome, decidedAt: now.getTime() }, reasons };
    });

    const decision = await this.signAndRecord(request, request.status, `human:${actor}`, reasons);
    return { request, decision };
  }

  private async signAndRecord(
    request: RequestRow,
    outcome: Outcome,
    decidedBy: string,
    reasons: Reason[],
  ): Promise<DecisionRow> {
    const now = this.now();
    const message: DecisionMessage = {
      requestId: request.id,
      agentId: request.agentId,
      token: this.token,
      recipient: request.recipient,
      amount: request.amount,
      outcome,
      decidedBy,
      issuedAt: BigInt(Math.floor(now.getTime() / 1000)),
    };
    const signed = await this.signer.sign(message);

    const row: Omit<DecisionRow, 'id'> = {
      requestId: request.id,
      outcome,
      decidedBy,
      reasons,
      message: signed.message,
      signature: signed.signature,
      signer: signed.signer,
      createdAt: now.getTime(),
    };
    this.store.transaction(() => {
      this.store.insertDecision(row);
      this.store.addEvent(request.id, 'decision_signed', { outcome, decidedBy, reasons }, now.getTime());
    });
    const saved = this.store.listDecisions(request.id).at(-1);
    if (!saved) throw new Error('decision was not persisted');
    return saved;
  }

  listRequests(filter: { status?: Outcome; agentId?: string } = {}): Array<{
    request: RequestRow;
    payment: PaymentRow | null;
  }> {
    return this.store.listRequests(filter).map((request) => ({
      request,
      payment: this.store.getPayment(request.id),
    }));
  }

  getRequestDetail(id: string): RequestDetail {
    const request = this.store.getRequest(id);
    if (!request) throw new AppError(404, 'request_not_found', 'No such request');
    return {
      request,
      mandate: this.store.getMandate(request.agentId),
      decisions: this.store.listDecisions(id),
      payment: this.store.getPayment(id),
      events: this.store.listEvents(id),
    };
  }

  recentDecisions(limit = 50): DecisionRow[] {
    return this.store.listRecentDecisions(limit);
  }

  // ---------------------------------------------------------------- onchain tracing

  /** Attach a transaction hash to an approved request and check it against the chain. */
  async attachPayment(requestId: string, txHash: Hash): Promise<PaymentRow> {
    const request = this.requireApproved(requestId);
    const normalized = txHash.toLowerCase() as Hash;

    const existing = this.store.getPayment(requestId);
    if (existing?.status === 'confirmed') {
      throw new AppError(409, 'already_confirmed', 'This request already has a confirmed payment');
    }
    this.assertTxUnused(normalized, requestId);

    const trace = await this.trace(request, normalized);

    return this.store.transaction(() => {
      // Re-check inside the transaction: another request may have claimed the hash while we awaited RPC.
      this.assertTxUnused(normalized, requestId);
      const now = this.now().getTime();
      const payment = toPayment(requestId, normalized, trace, existing?.createdAt ?? now, now);
      this.store.savePayment(payment);
      this.store.addEvent(requestId, 'payment_submitted', { txHash: normalized }, now);
      this.store.addEvent(requestId, `payment_${trace.status}`, eventDetail(trace), now);
      return payment;
    });
  }

  /** Re-run the onchain check for a payment that is still pending (or mismatched, e.g. after a reorg). */
  async recheckPayment(requestId: string): Promise<PaymentRow> {
    const request = this.requireApproved(requestId);
    const existing = this.store.getPayment(requestId);
    if (!existing) throw new AppError(404, 'no_payment', 'No transaction has been attached to this request');
    if (existing.status === 'confirmed') return existing;

    const trace = await this.trace(request, existing.txHash);
    const now = this.now().getTime();
    const payment = toPayment(requestId, existing.txHash, trace, existing.createdAt, now);
    this.store.transaction(() => {
      this.store.savePayment(payment);
      if (trace.status !== existing.status) {
        this.store.addEvent(requestId, `payment_${trace.status}`, eventDetail(trace), now);
      }
    });
    return payment;
  }

  private requireApproved(requestId: string): RequestRow {
    const request = this.store.getRequest(requestId);
    if (!request) throw new AppError(404, 'request_not_found', 'No such request');
    if (request.status !== 'approved') {
      throw new AppError(409, 'not_approved', `Only approved requests can be paid (this one is ${request.status})`);
    }
    return request;
  }

  private assertTxUnused(txHash: Hash, requestId: string): void {
    const owner = this.store.getPaymentByTx(txHash);
    if (owner && owner.requestId !== requestId) {
      throw new AppError(409, 'tx_already_used', `That transaction is already attached to request ${owner.requestId}`);
    }
  }

  private async trace(request: RequestRow, txHash: Hash): Promise<TraceResult> {
    const mandate = this.store.getMandate(request.agentId);
    try {
      return await traceTransfer(this.chain, txHash, {
        token: this.token,
        recipient: request.recipient,
        amount: request.amount,
        from: mandate?.walletAddress ?? null,
      });
    } catch (err) {
      throw new AppError(502, 'rpc_error', `Could not read the chain: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- dashboard

  agentSummaries(): AgentSummary[] {
    const since = utcDayStart(this.now());
    const payments = new Map(this.store.listPayments().map((p) => [p.requestId, p]));
    const all = this.store.listRequests();

    return this.store.listMandates().map((mandate) => {
      const mine = all.filter((r) => r.agentId === mandate.agentId);
      const counts: Record<Outcome, number> = { approved: 0, denied: 0, needs_approval: 0 };
      let confirmedOnchain = 0n;
      let mismatches = 0;
      let pendingPayments = 0;
      for (const r of mine) {
        counts[r.status] += 1;
        const p = payments.get(r.id);
        if (p?.status === 'confirmed') confirmedOnchain += r.amount;
        if (p?.status === 'mismatch') mismatches += 1;
        if (p?.status === 'pending') pendingPayments += 1;
      }
      return {
        mandate,
        spentToday: this.store.approvedSpendSince(mandate.agentId, since),
        pendingApprovals: counts.needs_approval,
        counts,
        confirmedOnchain,
        mismatches,
        pendingPayments,
      };
    });
  }
}

function toPayment(
  requestId: string,
  txHash: Hash,
  trace: TraceResult,
  createdAt: number,
  checkedAt: number,
): PaymentRow {
  return {
    requestId,
    txHash,
    status: trace.status,
    blockNumber: trace.blockNumber === null ? null : trace.blockNumber.toString(),
    reason: trace.reason,
    detail: trace.detail,
    actualFrom: trace.actual?.from ?? null,
    actualRecipient: trace.actual?.to ?? null,
    actualAmount: trace.actual?.amount ?? null,
    createdAt,
    checkedAt,
  };
}

function eventDetail(trace: TraceResult) {
  return {
    status: trace.status,
    reason: trace.reason,
    detail: trace.detail,
    blockNumber: trace.blockNumber === null ? null : trace.blockNumber.toString(),
  };
}

/** Normalise user-supplied addresses to EIP-55 checksum form. Throws on invalid input. */
export function normalizeAddress(value: string): Address {
  return getAddress(value);
}
