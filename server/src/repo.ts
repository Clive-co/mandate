import type { Address, Hash } from 'viem';
import type { Queryable, Row } from './db';
import type { MandateRecord, MandateTerms, ReasonCode, ReconStatus, Verdict } from './types';

/**
 * Data access. Every function takes a `Queryable` so it can run inside a transaction or not.
 * Numeric columns are always cast `::text` and read back with BigInt(), so money never passes
 * through a JavaScript float.
 */

const MANDATE_COLS = `m.id, m.agent_id, m.version, m.per_tx_limit::text AS per_tx_limit,
  m.daily_limit::text AS daily_limit, m.currency, m.categories, m.allowed_recipients, m.payer_address,
  m.expires_at, m.created_at, r.revoked_at, r.reason AS revoke_reason, r.replaced_by`;
const MANDATE_FROM = `FROM mandates m LEFT JOIN mandate_revocations r ON r.mandate_id = m.id`;

export function toMandate(r: Row): MandateRecord {
  return {
    id: r.id as string,
    agentId: r.agent_id as string,
    version: r.version as number,
    perTxLimit: BigInt(r.per_tx_limit as string),
    dailyLimit: BigInt(r.daily_limit as string),
    currency: r.currency as 'USDC',
    categories: r.categories as string[],
    allowedRecipients: (r.allowed_recipients as Address[] | null) ?? null,
    payerAddress: (r.payer_address as Address | null) ?? null,
    expiresAt: new Date(r.expires_at as string | Date),
    createdAt: new Date(r.created_at as string | Date),
    revokedAt: r.revoked_at ? new Date(r.revoked_at as string | Date) : null,
    revokeReason: (r.revoke_reason as string | null) ?? null,
    replacedBy: (r.replaced_by as string | null) ?? null,
  };
}

export async function insertMandate(
  q: Queryable,
  m: { id: string; agentId: string; version: number; createdAt: Date } & MandateTerms,
): Promise<void> {
  await q.query(
    `INSERT INTO mandates (id, agent_id, version, per_tx_limit, daily_limit, currency, categories,
                           allowed_recipients, payer_address, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      m.id,
      m.agentId,
      m.version,
      m.perTxLimit.toString(),
      m.dailyLimit.toString(),
      m.currency,
      m.categories,
      m.allowedRecipients,
      m.payerAddress,
      m.expiresAt.toISOString(),
      m.createdAt.toISOString(),
    ],
  );
}

export async function insertRevocation(
  q: Queryable,
  v: { mandateId: string; revokedAt: Date; reason: string; replacedBy: string | null },
): Promise<void> {
  await q.query(
    `INSERT INTO mandate_revocations (mandate_id, revoked_at, reason, replaced_by) VALUES ($1, $2, $3, $4)`,
    [v.mandateId, v.revokedAt.toISOString(), v.reason, v.replacedBy],
  );
}

export async function getMandate(q: Queryable, id: string, lock = false): Promise<MandateRecord | null> {
  const rows = await q.query(
    `SELECT ${MANDATE_COLS} ${MANDATE_FROM} WHERE m.id = $1 ${lock ? 'FOR UPDATE OF m' : ''}`,
    [id],
  );
  return rows[0] ? toMandate(rows[0]) : null;
}

/** The agent's current mandate: its highest version. `lock` serialises concurrent authorizations. */
export async function currentMandate(q: Queryable, agentId: string, lock = false): Promise<MandateRecord | null> {
  const rows = await q.query(
    `SELECT ${MANDATE_COLS} ${MANDATE_FROM} WHERE m.agent_id = $1
     ORDER BY m.version DESC LIMIT 1 ${lock ? 'FOR UPDATE OF m' : ''}`,
    [agentId],
  );
  return rows[0] ? toMandate(rows[0]) : null;
}

export async function listMandates(q: Queryable, agentId?: string): Promise<MandateRecord[]> {
  const rows = await q.query(
    `SELECT ${MANDATE_COLS} ${MANDATE_FROM} ${agentId ? 'WHERE m.agent_id = $1' : ''}
     ORDER BY m.agent_id, m.version DESC`,
    agentId ? [agentId] : [],
  );
  return rows.map(toMandate);
}

/** Sum of amounts ALLOWED to an agent since `since` (all mandate versions). */
export async function allowedSpendSince(q: Queryable, agentId: string, since: Date): Promise<bigint> {
  const rows = await q.query<{ total: string }>(
    `SELECT COALESCE(SUM(amount), 0)::text AS total FROM decision_log
     WHERE agent_id = $1 AND verdict = 'allow' AND created_at >= $2`,
    [agentId, since.toISOString()],
  );
  return BigInt(rows[0]!.total);
}

// ---------------------------------------------------------------- decision log

export interface DecisionRow {
  seq: number;
  id: string;
  agentId: string;
  mandateId: string | null;
  mandateVersion: number | null;
  amount: bigint;
  currency: string;
  recipient: Address;
  category: string;
  verdict: Verdict;
  reasonCode: ReasonCode | null;
  reason: string;
  nonce: string;
  token: string;
  claims: Record<string, unknown>;
  issuedAt: Date;
  expiresAt: Date;
  createdAt: Date;
}

export interface ReconRow {
  id: number;
  decisionId: string;
  txHash: Hash;
  status: ReconStatus;
  reason: string | null;
  detail: string | null;
  blockNumber: bigint | null;
  actualFrom: Address | null;
  actualRecipient: Address | null;
  actualAmount: bigint | null;
  createdAt: Date;
}

export type DecisionWithPayment = DecisionRow & { payment: ReconRow | null };

const DECISION_COLS = `d.seq::text AS seq, d.id, d.agent_id, d.mandate_id, d.mandate_version, d.amount::text AS amount,
  d.currency, d.recipient, d.category, d.verdict, d.reason_code, d.reason, d.nonce, d.token, d.claims,
  d.issued_at, d.expires_at, d.created_at`;
const RECON_COLS = `id::text AS id, decision_id, tx_hash, status, reason, detail, block_number::text AS block_number,
  actual_from, actual_recipient, actual_amount::text AS actual_amount, created_at`;

function toDecision(r: Row): DecisionRow {
  return {
    seq: Number(r.seq),
    id: r.id as string,
    agentId: r.agent_id as string,
    mandateId: (r.mandate_id as string | null) ?? null,
    mandateVersion: (r.mandate_version as number | null) ?? null,
    amount: BigInt(r.amount as string),
    currency: r.currency as string,
    recipient: r.recipient as Address,
    category: r.category as string,
    verdict: r.verdict as Verdict,
    reasonCode: (r.reason_code as ReasonCode | null) ?? null,
    reason: r.reason as string,
    nonce: r.nonce as string,
    token: r.token as string,
    claims: r.claims as Record<string, unknown>,
    issuedAt: new Date(r.issued_at as string | Date),
    expiresAt: new Date(r.expires_at as string | Date),
    createdAt: new Date(r.created_at as string | Date),
  };
}

function toRecon(r: Row): ReconRow {
  return {
    id: Number(r.id),
    decisionId: r.decision_id as string,
    txHash: r.tx_hash as Hash,
    status: r.status as ReconStatus,
    reason: (r.reason as string | null) ?? null,
    detail: (r.detail as string | null) ?? null,
    blockNumber: r.block_number === null || r.block_number === undefined ? null : BigInt(r.block_number as string),
    actualFrom: (r.actual_from as Address | null) ?? null,
    actualRecipient: (r.actual_recipient as Address | null) ?? null,
    actualAmount: r.actual_amount === null || r.actual_amount === undefined ? null : BigInt(r.actual_amount as string),
    createdAt: new Date(r.created_at as string | Date),
  };
}

export async function insertDecision(q: Queryable, d: Omit<DecisionRow, 'seq'>): Promise<void> {
  await q.query(
    `INSERT INTO decision_log (id, agent_id, mandate_id, mandate_version, amount, currency, recipient, category,
                               verdict, reason_code, reason, nonce, token, claims, issued_at, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17)`,
    [
      d.id,
      d.agentId,
      d.mandateId,
      d.mandateVersion,
      d.amount.toString(),
      d.currency,
      d.recipient,
      d.category,
      d.verdict,
      d.reasonCode,
      d.reason,
      d.nonce,
      d.token,
      JSON.stringify(d.claims),
      d.issuedAt.toISOString(),
      d.expiresAt.toISOString(),
      d.createdAt.toISOString(),
    ],
  );
}

export async function getDecision(q: Queryable, id: string): Promise<DecisionRow | null> {
  const rows = await q.query(`SELECT ${DECISION_COLS} FROM decision_log d WHERE d.id = $1`, [id]);
  return rows[0] ? toDecision(rows[0]) : null;
}

/** Newest first, each with its latest reconciliation (the payment's current status). */
export async function listDecisions(
  q: Queryable,
  f: { verdict?: Verdict; agentId?: string; limit?: number } = {},
): Promise<DecisionWithPayment[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.verdict) where.push(`d.verdict = $${params.push(f.verdict)}`);
  if (f.agentId) where.push(`d.agent_id = $${params.push(f.agentId)}`);
  const limit = params.push(Math.min(f.limit ?? 100, 500));
  const rows = await q.query(
    `SELECT ${DECISION_COLS},
            r.id::text AS r_id, r.tx_hash AS r_tx_hash, r.status AS r_status, r.reason AS r_reason, r.detail AS r_detail,
            r.block_number::text AS r_block_number, r.actual_from AS r_actual_from,
            r.actual_recipient AS r_actual_recipient, r.actual_amount::text AS r_actual_amount, r.created_at AS r_created_at
     FROM decision_log d
     LEFT JOIN LATERAL (SELECT * FROM reconciliations x WHERE x.decision_id = d.id ORDER BY x.id DESC LIMIT 1) r ON true
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY d.seq DESC LIMIT $${limit}`,
    params,
  );
  return rows.map((row) => ({
    ...toDecision(row),
    payment:
      row.r_id === null
        ? null
        : toRecon({
            id: row.r_id,
            decision_id: row.id,
            tx_hash: row.r_tx_hash,
            status: row.r_status,
            reason: row.r_reason,
            detail: row.r_detail,
            block_number: row.r_block_number,
            actual_from: row.r_actual_from,
            actual_recipient: row.r_actual_recipient,
            actual_amount: row.r_actual_amount,
            created_at: row.r_created_at,
          }),
  }));
}

// ---------------------------------------------------------------- reconciliations

export async function insertRecon(q: Queryable, r: Omit<ReconRow, 'id'>): Promise<void> {
  await q.query(
    `INSERT INTO reconciliations (decision_id, tx_hash, status, reason, detail, block_number,
                                  actual_from, actual_recipient, actual_amount, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      r.decisionId,
      r.txHash,
      r.status,
      r.reason,
      r.detail,
      r.blockNumber === null ? null : r.blockNumber.toString(),
      r.actualFrom,
      r.actualRecipient,
      r.actualAmount === null ? null : r.actualAmount.toString(),
      r.createdAt.toISOString(),
    ],
  );
}

export async function listRecons(q: Queryable, decisionId: string): Promise<ReconRow[]> {
  const rows = await q.query(`SELECT ${RECON_COLS} FROM reconciliations WHERE decision_id = $1 ORDER BY id`, [decisionId]);
  return rows.map(toRecon);
}

/** The decision (if any) whose payment this transaction has already been matched to. */
export async function matchedDecisionForTx(q: Queryable, txHash: string): Promise<string | null> {
  const rows = await q.query<{ decision_id: string }>(
    `SELECT decision_id FROM reconciliations WHERE tx_hash = $1 AND status = 'matched'`,
    [txHash],
  );
  return rows[0]?.decision_id ?? null;
}

// ---------------------------------------------------------------- dashboard

export interface AgentStats {
  agentId: string;
  allowedToday: bigint;
  allowCount: number;
  denyCount: number;
  matchedAmount: bigint;
  matchedCount: number;
  mismatchCount: number;
  pendingCount: number;
  awaitingPaymentCount: number;
}

export async function agentStats(q: Queryable, since: Date): Promise<AgentStats[]> {
  const rows = await q.query(
    `WITH latest AS (
       SELECT DISTINCT ON (decision_id) decision_id, status FROM reconciliations ORDER BY decision_id, id DESC
     )
     SELECT d.agent_id,
       COALESCE(SUM(d.amount) FILTER (WHERE d.verdict = 'allow' AND d.created_at >= $1), 0)::text AS allowed_today,
       COUNT(*) FILTER (WHERE d.verdict = 'allow')::int AS allow_count,
       COUNT(*) FILTER (WHERE d.verdict = 'deny')::int AS deny_count,
       COALESCE(SUM(d.amount) FILTER (WHERE l.status = 'matched'), 0)::text AS matched_amount,
       COUNT(*) FILTER (WHERE l.status = 'matched')::int AS matched_count,
       COUNT(*) FILTER (WHERE l.status = 'mismatch')::int AS mismatch_count,
       COUNT(*) FILTER (WHERE l.status = 'pending')::int AS pending_count,
       COUNT(*) FILTER (WHERE d.verdict = 'allow' AND l.status IS NULL)::int AS awaiting_payment_count
     FROM decision_log d LEFT JOIN latest l ON l.decision_id = d.id
     GROUP BY d.agent_id`,
    [since.toISOString()],
  );
  return rows.map((r) => ({
    agentId: r.agent_id as string,
    allowedToday: BigInt(r.allowed_today as string),
    allowCount: r.allow_count as number,
    denyCount: r.deny_count as number,
    matchedAmount: BigInt(r.matched_amount as string),
    matchedCount: r.matched_count as number,
    mismatchCount: r.mismatch_count as number,
    pendingCount: r.pending_count as number,
    awaitingPaymentCount: r.awaiting_payment_count as number,
  }));
}
