import type { Address } from 'viem';

/** What the policy engine (or a human) decided about a spend request. */
export type Outcome = 'approved' | 'denied' | 'needs_approval';

/** Onchain tracing status of an approved payment. */
export type PaymentStatus = 'pending' | 'confirmed' | 'mismatch';

/**
 * A human-defined spending policy for one agent.
 * All amounts are USDC base units (6 decimals) as bigint.
 */
export interface Mandate {
  agentId: string;
  name: string;
  /** Hard cap for a single payment. Above this, the request is denied. */
  perPaymentLimit: bigint;
  /** Hard cap on approved spend per UTC day. Above this, the request is denied. */
  dailyLimit: bigint;
  /** Soft cap. Above this (but within hard limits), a human must approve. null = no threshold. */
  approvalThreshold: bigint | null;
  /** Recipients the agent may pay without a human. Anyone else needs approval. */
  allowedRecipients: Address[];
  /** Optional: the wallet the agent pays from. If set, onchain tracing also checks `from`. */
  walletAddress: Address | null;
  active: boolean;
}

export interface SpendRequestInput {
  amount: bigint;
  recipient: Address;
}

export type ReasonCode =
  | 'invalid_amount'
  | 'no_mandate'
  | 'mandate_inactive'
  | 'exceeds_per_payment_limit'
  | 'exceeds_daily_limit'
  | 'recipient_not_allowed'
  | 'above_approval_threshold'
  | 'rejected_by_human';

export interface Reason {
  code: ReasonCode;
  message: string;
}

export interface PolicyResult {
  outcome: Outcome;
  reasons: Reason[];
}
