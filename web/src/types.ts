// Mirrors the JSON the API returns (see server/src/serialize.ts).
// Money arrives as exact base units (`amount`) and a decimal string for display (`...Usdc`).
// Times are epoch milliseconds.

export type Verdict = 'allow' | 'deny';
export type ReconStatus = 'pending' | 'matched' | 'mismatch';
export type MandateStatus = 'active' | 'expired' | 'revoked' | 'replaced';

export interface Mandate {
  id: string;
  agentId: string;
  version: number;
  status: MandateStatus;
  perTxLimitUsdc: string;
  dailyLimitUsdc: string;
  currency: string;
  categories: string[];
  /** null = any recipient. */
  allowedRecipients: string[] | null;
  payerAddress: string | null;
  expiresAt: number;
  createdAt: number;
  revokedAt: number | null;
  revokeReason: string | null;
  replacedBy: string | null;
}

export interface Recon {
  txHash: string;
  status: ReconStatus;
  reason: string | null;
  detail: string | null;
  blockNumber: string | null;
  actualFrom: string | null;
  actualRecipient: string | null;
  actualAmount: string | null;
  actualAmountUsdc: string | null;
  explorerUrl: string;
  checkedAt: number;
}

export interface Decision {
  id: string;
  agentId: string;
  verdict: Verdict;
  reasonCode: string | null;
  reason: string;
  amount: string;
  amountUsdc: string;
  currency: string;
  recipient: string;
  category: string;
  mandateId: string | null;
  mandateVersion: number | null;
  nonce: string;
  /** The signed verdict (ES256 JWT). */
  token: string;
  claims: Record<string, unknown>;
  issuedAt: number;
  expiresAt: number;
  createdAt: number;
  payment: Recon | null;
}

export interface TrailEvent {
  at: number;
  type:
    | 'authorization_requested'
    | 'verdict_issued'
    | 'reconciliation_pending'
    | 'reconciliation_matched'
    | 'reconciliation_mismatch';
  detail: Record<string, unknown>;
}

export interface DecisionDetail {
  decision: Decision;
  mandate: Mandate | null;
  reconciliations: Recon[];
  trail: TrailEvent[];
}

export interface AgentSummary {
  agentId: string;
  mandate: Mandate;
  allowedTodayUsdc: string;
  remainingTodayUsdc: string;
  allowCount: number;
  denyCount: number;
  awaitingPaymentCount: number;
  matchedUsdc: string;
  matchedCount: number;
  mismatchCount: number;
  pendingCount: number;
}

export interface Summary {
  totals: {
    allowedTodayUsdc: string;
    matchedUsdc: string;
    allowCount: number;
    denyCount: number;
    awaitingPaymentCount: number;
    pendingCount: number;
    mismatchCount: number;
  };
  agents: AgentSummary[];
}

export type SellerResult =
  | { ok: true; claims: Record<string, unknown> }
  | { ok: false; code: string; message: string };

/** The terms of a mandate as the create/replace forms send them. */
export interface MandateTermsInput {
  perTxLimit: string;
  dailyLimit: string;
  categories: string[];
  allowedRecipients: string[] | null;
  payerAddress: string | null;
  expiresAt: string;
}
