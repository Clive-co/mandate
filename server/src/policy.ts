import type { AuthorizeInput, MandateRecord, PolicyResult, ReasonCode } from './types';
import { formatUsdc } from './units';

/**
 * The policy engine: a pure function. No I/O, no clock, no database. The caller supplies the
 * agent's current mandate, how much it has already been allowed today, and the time.
 *
 * Checks run in this fixed order and the FIRST failure is the single reason returned. A fixed
 * order makes the answer deterministic and easy to test and explain:
 *
 *   1. amount > 0                    invalid_amount
 *   2. a mandate exists              no_mandate
 *   3. it is not revoked             mandate_revoked
 *   4. it has not expired            mandate_expired
 *   5. currency matches              currency_mismatch
 *   6. category is allowed           category_not_allowed
 *   7. recipient is allowed          recipient_not_allowed   (only if the mandate lists recipients)
 *   8. amount <= per-transaction     exceeds_per_tx_limit
 *   9. spentToday + amount <= daily  exceeds_daily_limit
 *
 * Limits are inclusive: spending exactly the limit is allowed. A mandate is expired from the
 * instant `now >= expiresAt`.
 */
export function evaluatePolicy(
  request: AuthorizeInput,
  mandate: MandateRecord | null,
  spentToday: bigint,
  now: Date,
): PolicyResult {
  if (request.amount <= 0n) return deny('invalid_amount', 'Amount must be greater than zero');
  if (!mandate) return deny('no_mandate', 'This agent has no mandate');
  if (mandate.revokedAt) {
    return deny('mandate_revoked', `Mandate v${mandate.version} was revoked: ${mandate.revokeReason ?? 'no reason given'}`);
  }
  if (now.getTime() >= mandate.expiresAt.getTime()) {
    return deny('mandate_expired', `Mandate v${mandate.version} expired at ${mandate.expiresAt.toISOString()}`);
  }
  if (request.currency !== mandate.currency) {
    return deny('currency_mismatch', `Mandate is denominated in ${mandate.currency}, not ${request.currency}`);
  }
  if (!mandate.categories.includes(request.category)) {
    return deny('category_not_allowed', `Category "${request.category}" is not allowed (allowed: ${mandate.categories.join(', ')})`);
  }
  if (mandate.allowedRecipients && !mandate.allowedRecipients.some((a) => sameAddress(a, request.recipient))) {
    return deny('recipient_not_allowed', `Recipient ${request.recipient} is not on the mandate's allowlist`);
  }
  if (request.amount > mandate.perTxLimit) {
    return deny('exceeds_per_tx_limit', `${formatUsdc(request.amount)} USDC exceeds the per-transaction limit of ${formatUsdc(mandate.perTxLimit)} USDC`);
  }
  if (spentToday + request.amount > mandate.dailyLimit) {
    const left = mandate.dailyLimit > spentToday ? mandate.dailyLimit - spentToday : 0n;
    return deny(
      'exceeds_daily_limit',
      `${formatUsdc(request.amount)} USDC would exceed the daily limit of ${formatUsdc(mandate.dailyLimit)} USDC (${formatUsdc(left)} USDC left today)`,
    );
  }
  return { verdict: 'allow', code: null, reason: 'Within mandate' };
}

function deny(code: ReasonCode, reason: string): PolicyResult {
  return { verdict: 'deny', code, reason };
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
