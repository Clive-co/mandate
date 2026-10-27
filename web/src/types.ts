// Mirrors the JSON the API returns (see server/src/serialize.ts).
// Money arrives as human decimal strings (`...Usdc`) and, for requests, exact base units (`amount`).

export type Outcome = 'approved' | 'denied' | 'needs_approval';
export type PaymentStatus = 'pending' | 'confirmed' | 'mismatch';

export interface Reason {
  code: string;
  message: string;
}

export interface Payment {
  txHash: string;
  status: PaymentStatus;
  blockNumber: string | null;
  reason: string | null;
  detail: string | null;
  actualFrom: string | null;
  actualRecipient: string | null;
  actualAmountUsdc: string | null;
  explorerUrl: string;
  createdAt: number;
  checkedAt: number | null;
}

export interface SpendRequest {
  id: string;
  agentId: string;
  recipient: string;
  amount: string;
  amountUsdc: string;
  memo: string | null;
  status: Outcome;
  createdAt: number;
  decidedAt: number | null;
  payment: Payment | null;
}

export interface WireDecision {
  requestId: string;
  agentId: string;
  token: string;
  recipient: string;
  amount: string;
  outcome: Outcome;
  decidedBy: string;
  issuedAt: string;
}

export interface Decision {
  id: number;
  requestId: string;
  outcome: Outcome;
  decidedBy: string;
  reasons: Reason[];
  message: WireDecision;
  signature: string;
  signer: string;
  createdAt: number;
}

export interface AuditEvent {
  id: number;
  requestId: string;
  type: string;
  detail: Record<string, unknown>;
  at: number;
}

export interface Mandate {
  agentId: string;
  name: string;
  perPaymentLimitUsdc: string;
  dailyLimitUsdc: string;
  approvalThresholdUsdc: string | null;
  allowedRecipients: string[];
  walletAddress: string | null;
  active: boolean;
}

export interface AgentSummary extends Mandate {
  spentTodayUsdc: string;
  remainingTodayUsdc: string;
  pendingApprovals: number;
  requestCounts: Record<Outcome, number>;
  confirmedOnchainUsdc: string;
  mismatches: number;
  pendingPayments: number;
}

export interface Summary {
  totals: {
    pendingApprovals: number;
    spentTodayUsdc: string;
    confirmedOnchainUsdc: string;
    mismatches: number;
    pendingPayments: number;
  };
  agents: AgentSummary[];
}

export interface RequestDetail {
  request: SpendRequest;
  mandate: Mandate | null;
  decisions: Decision[];
  events: AuditEvent[];
}
