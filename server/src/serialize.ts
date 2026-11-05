import { baseSepolia } from 'viem/chains';
import type { DecisionDetail, AgentSummary, TrailEvent } from './service';
import type { DecisionRow, DecisionWithPayment, ReconRow } from './repo';
import { mandateStatus, type MandateRecord } from './types';
import { formatUsdc } from './units';

/**
 * JSON shapes returned by the API. bigint can't be JSON-encoded, so money is returned twice:
 * `amount` (exact base units, as a string) and `amountUsdc` (human decimal, for display).
 * Dates are epoch milliseconds.
 */

export const EXPLORER_BASE = baseSepolia.blockExplorers.default.url; // https://sepolia.basescan.org
export const explorerTxUrl = (hash: string) => `${EXPLORER_BASE}/tx/${hash}`;

const ms = (d: Date | null) => (d ? d.getTime() : null);

export function apiMandate(m: MandateRecord, now: Date) {
  return {
    id: m.id,
    agentId: m.agentId,
    version: m.version,
    status: mandateStatus(m, now),
    perTxLimitUsdc: formatUsdc(m.perTxLimit),
    dailyLimitUsdc: formatUsdc(m.dailyLimit),
    currency: m.currency,
    categories: m.categories,
    allowedRecipients: m.allowedRecipients,
    payerAddress: m.payerAddress,
    expiresAt: m.expiresAt.getTime(),
    createdAt: m.createdAt.getTime(),
    revokedAt: ms(m.revokedAt),
    revokeReason: m.revokeReason,
    replacedBy: m.replacedBy,
  };
}

export function apiRecon(r: ReconRow) {
  return {
    txHash: r.txHash,
    status: r.status,
    reason: r.reason,
    detail: r.detail,
    blockNumber: r.blockNumber?.toString() ?? null,
    actualFrom: r.actualFrom,
    actualRecipient: r.actualRecipient,
    actualAmount: r.actualAmount?.toString() ?? null,
    actualAmountUsdc: r.actualAmount === null ? null : formatUsdc(r.actualAmount),
    explorerUrl: explorerTxUrl(r.txHash),
    checkedAt: r.createdAt.getTime(),
  };
}

/** The decision as the API returns it. `token` is the signed verdict JWT. */
export function apiDecision(d: DecisionRow, payment: ReconRow | null = null) {
  return {
    id: d.id,
    agentId: d.agentId,
    verdict: d.verdict,
    reasonCode: d.reasonCode,
    reason: d.reason,
    amount: d.amount.toString(),
    amountUsdc: formatUsdc(d.amount),
    currency: d.currency,
    recipient: d.recipient,
    category: d.category,
    mandateId: d.mandateId,
    mandateVersion: d.mandateVersion,
    nonce: d.nonce,
    token: d.token,
    claims: d.claims,
    issuedAt: d.issuedAt.getTime(),
    expiresAt: d.expiresAt.getTime(),
    createdAt: d.createdAt.getTime(),
    payment: payment ? apiRecon(payment) : null,
  };
}

export const apiDecisionListItem = (d: DecisionWithPayment) => apiDecision(d, d.payment);

function apiTrail(e: TrailEvent) {
  const detail = { ...e.detail };
  if (typeof detail.amount === 'string') detail.amountUsdc = formatUsdc(BigInt(detail.amount));
  return { at: e.at.getTime(), type: e.type, detail };
}

export function apiDetail(d: DecisionDetail, now: Date) {
  const latest = d.reconciliations.at(-1) ?? null;
  return {
    decision: apiDecision(d.decision, latest),
    mandate: d.mandate ? apiMandate(d.mandate, now) : null,
    reconciliations: d.reconciliations.map(apiRecon),
    trail: d.trail.map(apiTrail),
  };
}

export function apiSummary(agents: AgentSummary[], now: Date) {
  const rows = agents.map((a) => {
    const s = a.stats;
    const remaining = a.mandate.dailyLimit > a.allowedToday ? a.mandate.dailyLimit - a.allowedToday : 0n;
    return {
      agentId: a.mandate.agentId,
      mandate: apiMandate(a.mandate, now),
      allowedTodayUsdc: formatUsdc(a.allowedToday),
      remainingTodayUsdc: a.status === 'active' ? formatUsdc(remaining) : '0',
      allowCount: s?.allowCount ?? 0,
      denyCount: s?.denyCount ?? 0,
      awaitingPaymentCount: s?.awaitingPaymentCount ?? 0,
      matchedUsdc: formatUsdc(s?.matchedAmount ?? 0n),
      matchedCount: s?.matchedCount ?? 0,
      mismatchCount: s?.mismatchCount ?? 0,
      pendingCount: s?.pendingCount ?? 0,
    };
  });
  const sum = (f: (a: AgentSummary) => bigint) => formatUsdc(agents.reduce((n, a) => n + f(a), 0n));
  const count = (f: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + f(r), 0);
  return {
    totals: {
      allowedTodayUsdc: sum((a) => a.allowedToday),
      matchedUsdc: sum((a) => a.stats?.matchedAmount ?? 0n),
      allowCount: count((r) => r.allowCount),
      denyCount: count((r) => r.denyCount),
      awaitingPaymentCount: count((r) => r.awaitingPaymentCount),
      pendingCount: count((r) => r.pendingCount),
      mismatchCount: count((r) => r.mismatchCount),
    },
    agents: rows,
  };
}
