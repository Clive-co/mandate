import { baseSepolia } from 'viem/chains';
import type { AgentSummary, RequestDetail } from './service';
import type { DecisionRow, PaymentRow, RequestRow } from './store';
import type { Mandate } from './types';
import { formatUsdc } from './units';

/**
 * JSON shapes returned by the API. bigint can't be JSON-encoded, so money is returned twice:
 * `amount` (exact base units, as a string) and `amountUsdc` (human decimal, for display).
 */

export const EXPLORER_BASE = baseSepolia.blockExplorers.default.url; // https://sepolia.basescan.org

export const explorerTxUrl = (hash: string) => `${EXPLORER_BASE}/tx/${hash}`;

export function apiMandate(m: Mandate) {
  return {
    agentId: m.agentId,
    name: m.name,
    perPaymentLimitUsdc: formatUsdc(m.perPaymentLimit),
    dailyLimitUsdc: formatUsdc(m.dailyLimit),
    approvalThresholdUsdc: m.approvalThreshold === null ? null : formatUsdc(m.approvalThreshold),
    allowedRecipients: m.allowedRecipients,
    walletAddress: m.walletAddress,
    active: m.active,
  };
}

export function apiPayment(p: PaymentRow) {
  return {
    txHash: p.txHash,
    status: p.status,
    blockNumber: p.blockNumber,
    reason: p.reason,
    detail: p.detail,
    actualFrom: p.actualFrom,
    actualRecipient: p.actualRecipient,
    actualAmountUsdc: p.actualAmount === null ? null : formatUsdc(p.actualAmount),
    explorerUrl: explorerTxUrl(p.txHash),
    createdAt: p.createdAt,
    checkedAt: p.checkedAt,
  };
}

export function apiRequest(r: RequestRow, payment: PaymentRow | null = null) {
  return {
    id: r.id,
    agentId: r.agentId,
    recipient: r.recipient,
    amount: r.amount.toString(),
    amountUsdc: formatUsdc(r.amount),
    memo: r.memo,
    status: r.status,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
    payment: payment ? apiPayment(payment) : null,
  };
}

export function apiDecision(d: DecisionRow) {
  return {
    id: d.id,
    requestId: d.requestId,
    outcome: d.outcome,
    decidedBy: d.decidedBy,
    reasons: d.reasons,
    message: d.message,
    signature: d.signature,
    signer: d.signer,
    createdAt: d.createdAt,
  };
}

export function apiDetail(d: RequestDetail) {
  return {
    request: apiRequest(d.request, d.payment),
    mandate: d.mandate ? apiMandate(d.mandate) : null,
    decisions: d.decisions.map(apiDecision),
    events: d.events,
  };
}

export function apiAgentSummary(s: AgentSummary) {
  const remaining = s.mandate.dailyLimit > s.spentToday ? s.mandate.dailyLimit - s.spentToday : 0n;
  return {
    ...apiMandate(s.mandate),
    spentTodayUsdc: formatUsdc(s.spentToday),
    remainingTodayUsdc: formatUsdc(remaining),
    pendingApprovals: s.pendingApprovals,
    requestCounts: s.counts,
    confirmedOnchainUsdc: formatUsdc(s.confirmedOnchain),
    mismatches: s.mismatches,
    pendingPayments: s.pendingPayments,
  };
}
