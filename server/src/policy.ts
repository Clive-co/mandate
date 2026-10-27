import type { Mandate, PolicyResult, Reason, SpendRequestInput } from './types';
import { formatUsdc } from './units';

/**
 * The policy engine. A pure function: no I/O, no clock, no database.
 * The caller supplies how much the agent has already spent today.
 *
 * Rules, in two tiers:
 *
 *  HARD rules -> `denied` (a human cannot override these through the queue)
 *    - amount must be > 0
 *    - the agent must have an active mandate
 *    - amount <= perPaymentLimit
 *    - spentToday + amount <= dailyLimit
 *
 *  SOFT rules -> `needs_approval` (a human decides)
 *    - recipient is not on the allowlist (an empty allowlist means "everyone needs approval")
 *    - amount > approvalThreshold (when one is set)
 *
 * If any hard rule fails the result is `denied`, and every failing hard rule is reported.
 * Otherwise, if any soft rule fires the result is `needs_approval`. Otherwise `approved`.
 */
export function evaluatePolicy(
  request: SpendRequestInput,
  mandate: Mandate | null,
  spentToday: bigint,
): PolicyResult {
  if (mandate === null) {
    return deny([{ code: 'no_mandate', message: 'No mandate exists for this agent' }]);
  }
  if (!mandate.active) {
    return deny([{ code: 'mandate_inactive', message: 'This agent’s mandate is paused' }]);
  }
  if (request.amount <= 0n) {
    return deny([{ code: 'invalid_amount', message: 'Amount must be greater than zero' }]);
  }

  const denials: Reason[] = [];

  if (request.amount > mandate.perPaymentLimit) {
    denials.push({
      code: 'exceeds_per_payment_limit',
      message: `${formatUsdc(request.amount)} USDC exceeds the per-payment limit of ${formatUsdc(mandate.perPaymentLimit)} USDC`,
    });
  }

  if (spentToday + request.amount > mandate.dailyLimit) {
    const remaining = mandate.dailyLimit > spentToday ? mandate.dailyLimit - spentToday : 0n;
    denials.push({
      code: 'exceeds_daily_limit',
      message: `${formatUsdc(request.amount)} USDC would exceed the daily limit of ${formatUsdc(mandate.dailyLimit)} USDC (${formatUsdc(remaining)} USDC left today)`,
    });
  }

  if (denials.length > 0) return deny(denials);

  const escalations: Reason[] = [];

  if (!isAllowedRecipient(mandate, request.recipient)) {
    escalations.push({
      code: 'recipient_not_allowed',
      message: `Recipient ${request.recipient} is not on the allowlist`,
    });
  }

  if (mandate.approvalThreshold !== null && request.amount > mandate.approvalThreshold) {
    escalations.push({
      code: 'above_approval_threshold',
      message: `${formatUsdc(request.amount)} USDC is above the auto-approval threshold of ${formatUsdc(mandate.approvalThreshold)} USDC`,
    });
  }

  if (escalations.length > 0) return { outcome: 'needs_approval', reasons: escalations };

  return { outcome: 'approved', reasons: [] };
}

/**
 * Re-check only the hard rules. Used when a human approves a queued request: the world may
 * have changed since it was queued (other spend landed, the mandate was tightened), and a
 * human clicking "approve" should not be able to blow through a hard limit.
 * Returns the denial reasons, or an empty array if the hard rules still pass.
 */
export function checkHardRules(
  request: SpendRequestInput,
  mandate: Mandate | null,
  spentToday: bigint,
): Reason[] {
  const result = evaluatePolicy(request, mandate, spentToday);
  return result.outcome === 'denied' ? result.reasons : [];
}

export function isAllowedRecipient(mandate: Mandate, recipient: string): boolean {
  const target = recipient.toLowerCase();
  return mandate.allowedRecipients.some((a) => a.toLowerCase() === target);
}

function deny(reasons: Reason[]): PolicyResult {
  return { outcome: 'denied', reasons };
}
