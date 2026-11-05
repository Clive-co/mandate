import type { Address } from 'viem';

export const CURRENCY = 'USDC';
export type Currency = typeof CURRENCY;

/** What the authorization endpoint answers. */
export type Verdict = 'allow' | 'deny';

/** Where an allowed payment stands onchain. */
export type ReconStatus = 'pending' | 'matched' | 'mismatch';

/** The terms of a mandate. All amounts are USDC base units (6 decimals) as bigint. */
export interface MandateTerms {
  /** Cap for a single payment. */
  perTxLimit: bigint;
  /** Cap on allowed spend per UTC day, across every mandate version of the agent. */
  dailyLimit: bigint;
  currency: Currency;
  /** Spend categories the agent may use (lowercase). */
  categories: string[];
  /** Recipients the agent may pay. null = any recipient. Never an empty array. */
  allowedRecipients: Address[] | null;
  /** Optional: the wallet the agent pays from. When set, reconciliation also checks the sender. */
  payerAddress: Address | null;
  expiresAt: Date;
}

/** One immutable mandate record. Changing terms means revoking this one and creating the next version. */
export interface Mandate extends MandateTerms {
  id: string;
  agentId: string;
  /** 1, 2, 3… per agent. The highest version is the agent's current mandate. */
  version: number;
  createdAt: Date;
}

/** A mandate plus its revocation, which lives in a separate append-only table. */
export interface MandateRecord extends Mandate {
  revokedAt: Date | null;
  revokeReason: string | null;
  replacedBy: string | null;
}

export type MandateStatus = 'active' | 'expired' | 'revoked' | 'replaced';

export function mandateStatus(m: MandateRecord, now: Date): MandateStatus {
  if (m.revokedAt) return m.replacedBy ? 'replaced' : 'revoked';
  return now.getTime() >= m.expiresAt.getTime() ? 'expired' : 'active';
}

export interface AuthorizeInput {
  agentId: string;
  amount: bigint;
  currency: string;
  recipient: Address;
  category: string;
}

export type ReasonCode =
  | 'invalid_amount'
  | 'no_mandate'
  | 'mandate_revoked'
  | 'mandate_expired'
  | 'currency_mismatch'
  | 'category_not_allowed'
  | 'recipient_not_allowed'
  | 'exceeds_per_tx_limit'
  | 'exceeds_daily_limit';

export interface PolicyResult {
  verdict: Verdict;
  /** null when allowed. */
  code: ReasonCode | null;
  reason: string;
}
