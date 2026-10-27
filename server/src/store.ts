import type { Address, Hash, Hex } from 'viem';
import type { Db } from './db';
import type { WireDecision } from './signing';
import type { Mandate, Outcome, PaymentStatus, Reason } from './types';

export interface RequestRow {
  id: string;
  agentId: string;
  recipient: Address;
  amount: bigint;
  memo: string | null;
  status: Outcome;
  createdAt: number;
  decidedAt: number | null;
}

export interface DecisionRow {
  id: number;
  requestId: string;
  outcome: Outcome;
  decidedBy: string;
  reasons: Reason[];
  message: WireDecision;
  signature: Hex;
  signer: Address;
  createdAt: number;
}

export interface PaymentRow {
  requestId: string;
  txHash: Hash;
  status: PaymentStatus;
  blockNumber: string | null;
  reason: string | null;
  detail: string | null;
  actualFrom: Address | null;
  actualRecipient: Address | null;
  actualAmount: bigint | null;
  createdAt: number;
  checkedAt: number | null;
}

export interface AuditEventRow {
  id: number;
  requestId: string;
  type: string;
  detail: unknown;
  at: number;
}

type Row = Record<string, unknown>;

/** Thin, synchronous data-access layer. All money is stored as base-unit strings, read as bigint. */
export class Store {
  constructor(private readonly db: Db) {}

  /** Run `fn` atomically. node:sqlite is synchronous, so there are no await points inside. */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ---- mandates ----

  upsertMandate(m: Mandate): void {
    this.db
      .prepare(
        `INSERT INTO mandates (agent_id, name, per_payment_limit, daily_limit, approval_threshold,
                               allowed_recipients, wallet_address, active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           name = excluded.name,
           per_payment_limit = excluded.per_payment_limit,
           daily_limit = excluded.daily_limit,
           approval_threshold = excluded.approval_threshold,
           allowed_recipients = excluded.allowed_recipients,
           wallet_address = excluded.wallet_address,
           active = excluded.active`,
      )
      .run(
        m.agentId,
        m.name,
        m.perPaymentLimit.toString(),
        m.dailyLimit.toString(),
        m.approvalThreshold === null ? null : m.approvalThreshold.toString(),
        JSON.stringify(m.allowedRecipients),
        m.walletAddress,
        m.active ? 1 : 0,
      );
  }

  getMandate(agentId: string): Mandate | null {
    const row = this.db.prepare('SELECT * FROM mandates WHERE agent_id = ?').get(agentId) as Row | undefined;
    return row ? toMandate(row) : null;
  }

  listMandates(): Mandate[] {
    const rows = this.db.prepare('SELECT * FROM mandates ORDER BY agent_id').all() as Row[];
    return rows.map(toMandate);
  }

  // ---- requests ----

  insertRequest(r: RequestRow): void {
    this.db
      .prepare(
        `INSERT INTO requests (id, agent_id, recipient, amount, memo, status, created_at, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.agentId, r.recipient, r.amount.toString(), r.memo, r.status, r.createdAt, r.decidedAt);
  }

  getRequest(id: string): RequestRow | null {
    const row = this.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as Row | undefined;
    return row ? toRequest(row) : null;
  }

  listRequests(filter: { status?: Outcome; agentId?: string } = {}): RequestRow[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.status) {
      where.push('status = ?');
      params.push(filter.status);
    }
    if (filter.agentId) {
      where.push('agent_id = ?');
      params.push(filter.agentId);
    }
    const sql = `SELECT * FROM requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at DESC, rowid DESC`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(toRequest);
  }

  setRequestStatus(id: string, status: Outcome, decidedAt: number | null): void {
    this.db.prepare('UPDATE requests SET status = ?, decided_at = ? WHERE id = ?').run(status, decidedAt, id);
  }

  /** Sum of approved amounts for an agent decided at or after `sinceMs`. Summed as bigint in JS. */
  approvedSpendSince(agentId: string, sinceMs: number): bigint {
    const rows = this.db
      .prepare(`SELECT amount FROM requests WHERE agent_id = ? AND status = 'approved' AND decided_at >= ?`)
      .all(agentId, sinceMs) as Row[];
    return rows.reduce((sum, r) => sum + BigInt(r.amount as string), 0n);
  }

  // ---- decisions ----

  insertDecision(d: Omit<DecisionRow, 'id'>): void {
    this.db
      .prepare(
        `INSERT INTO decisions (request_id, outcome, decided_by, reasons, message, signature, signer, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.requestId,
        d.outcome,
        d.decidedBy,
        JSON.stringify(d.reasons),
        JSON.stringify(d.message),
        d.signature,
        d.signer,
        d.createdAt,
      );
  }

  listDecisions(requestId: string): DecisionRow[] {
    const rows = this.db
      .prepare('SELECT * FROM decisions WHERE request_id = ? ORDER BY id')
      .all(requestId) as Row[];
    return rows.map(toDecision);
  }

  /** Newest decisions first, for the decision log. */
  listRecentDecisions(limit: number): DecisionRow[] {
    const rows = this.db.prepare('SELECT * FROM decisions ORDER BY id DESC LIMIT ?').all(limit) as Row[];
    return rows.map(toDecision);
  }

  // ---- payments ----

  getPayment(requestId: string): PaymentRow | null {
    const row = this.db.prepare('SELECT * FROM payments WHERE request_id = ?').get(requestId) as Row | undefined;
    return row ? toPayment(row) : null;
  }

  getPaymentByTx(txHash: string): PaymentRow | null {
    const row = this.db.prepare('SELECT * FROM payments WHERE tx_hash = ?').get(txHash) as Row | undefined;
    return row ? toPayment(row) : null;
  }

  listPayments(): PaymentRow[] {
    return (this.db.prepare('SELECT * FROM payments').all() as Row[]).map(toPayment);
  }

  /** Insert or replace the single payment for a request. */
  savePayment(p: PaymentRow): void {
    this.db
      .prepare(
        `INSERT INTO payments (request_id, tx_hash, status, block_number, reason, detail,
                               actual_from, actual_recipient, actual_amount, created_at, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(request_id) DO UPDATE SET
           tx_hash = excluded.tx_hash,
           status = excluded.status,
           block_number = excluded.block_number,
           reason = excluded.reason,
           detail = excluded.detail,
           actual_from = excluded.actual_from,
           actual_recipient = excluded.actual_recipient,
           actual_amount = excluded.actual_amount,
           checked_at = excluded.checked_at`,
      )
      .run(
        p.requestId,
        p.txHash,
        p.status,
        p.blockNumber,
        p.reason,
        p.detail,
        p.actualFrom,
        p.actualRecipient,
        p.actualAmount === null ? null : p.actualAmount.toString(),
        p.createdAt,
        p.checkedAt,
      );
  }

  // ---- audit ----

  addEvent(requestId: string, type: string, detail: unknown, at: number): void {
    this.db
      .prepare('INSERT INTO audit_events (request_id, type, detail, at) VALUES (?, ?, ?, ?)')
      .run(requestId, type, JSON.stringify(detail), at);
  }

  listEvents(requestId: string): AuditEventRow[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_events WHERE request_id = ? ORDER BY id')
      .all(requestId) as Row[];
    return rows.map((r) => ({
      id: r.id as number,
      requestId: r.request_id as string,
      type: r.type as string,
      detail: JSON.parse(r.detail as string) as unknown,
      at: r.at as number,
    }));
  }
}

function toMandate(r: Row): Mandate {
  return {
    agentId: r.agent_id as string,
    name: r.name as string,
    perPaymentLimit: BigInt(r.per_payment_limit as string),
    dailyLimit: BigInt(r.daily_limit as string),
    approvalThreshold: r.approval_threshold === null ? null : BigInt(r.approval_threshold as string),
    allowedRecipients: JSON.parse(r.allowed_recipients as string) as Address[],
    walletAddress: (r.wallet_address as Address | null) ?? null,
    active: r.active === 1,
  };
}

function toRequest(r: Row): RequestRow {
  return {
    id: r.id as string,
    agentId: r.agent_id as string,
    recipient: r.recipient as Address,
    amount: BigInt(r.amount as string),
    memo: (r.memo as string | null) ?? null,
    status: r.status as Outcome,
    createdAt: r.created_at as number,
    decidedAt: (r.decided_at as number | null) ?? null,
  };
}

function toDecision(r: Row): DecisionRow {
  return {
    id: r.id as number,
    requestId: r.request_id as string,
    outcome: r.outcome as Outcome,
    decidedBy: r.decided_by as string,
    reasons: JSON.parse(r.reasons as string) as Reason[],
    message: JSON.parse(r.message as string) as WireDecision,
    signature: r.signature as Hex,
    signer: r.signer as Address,
    createdAt: r.created_at as number,
  };
}

function toPayment(r: Row): PaymentRow {
  return {
    requestId: r.request_id as string,
    txHash: r.tx_hash as Hash,
    status: r.status as PaymentStatus,
    blockNumber: (r.block_number as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    detail: (r.detail as string | null) ?? null,
    actualFrom: (r.actual_from as Address | null) ?? null,
    actualRecipient: (r.actual_recipient as Address | null) ?? null,
    actualAmount: r.actual_amount === null ? null : BigInt(r.actual_amount as string),
    createdAt: r.created_at as number,
    checkedAt: (r.checked_at as number | null) ?? null,
  };
}
