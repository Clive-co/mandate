import { describe, expect, it } from 'vitest';
import { checkHardRules, evaluatePolicy } from '../src/policy';
import { parseUsdc as usdc } from '../src/units';
import { ALICE, BOB, mandate } from './fixtures';

const req = (amount: string, recipient = ALICE) => ({ amount: usdc(amount), recipient });

describe('evaluatePolicy: approved', () => {
  it('approves a small payment to an allowed recipient', () => {
    const r = evaluatePolicy(req('10'), mandate(), 0n);
    expect(r).toEqual({ outcome: 'approved', reasons: [] });
  });

  it('allows exactly the per-payment limit (boundary is inclusive)', () => {
    expect(evaluatePolicy(req('50'), mandate(), 0n).outcome).toBe('approved');
  });

  it('allows spend that lands exactly on the daily limit', () => {
    expect(evaluatePolicy(req('50'), mandate(), usdc('50')).outcome).toBe('approved');
  });

  it('matches recipients case-insensitively (checksummed vs lowercase)', () => {
    const m = mandate({ allowedRecipients: [ALICE] });
    expect(evaluatePolicy(req('1', ALICE.toLowerCase() as typeof ALICE), m, 0n).outcome).toBe('approved');
  });
});

describe('evaluatePolicy: denied (hard rules)', () => {
  it('denies when the amount exceeds the per-payment limit', () => {
    const r = evaluatePolicy(req('50.000001'), mandate(), 0n);
    expect(r.outcome).toBe('denied');
    expect(r.reasons.map((x) => x.code)).toEqual(['exceeds_per_payment_limit']);
  });

  it('denies when spent-today + amount would exceed the daily limit', () => {
    const r = evaluatePolicy(req('20'), mandate(), usdc('90'));
    expect(r.outcome).toBe('denied');
    expect(r.reasons.map((x) => x.code)).toEqual(['exceeds_daily_limit']);
    expect(r.reasons[0]!.message).toContain('10 USDC left today');
  });

  it('reports every hard rule that fails', () => {
    const r = evaluatePolicy(req('60'), mandate({ dailyLimit: usdc('70') }), usdc('20'));
    expect(r.reasons.map((x) => x.code)).toEqual(['exceeds_per_payment_limit', 'exceeds_daily_limit']);
  });

  it('denies zero amounts', () => {
    const r = evaluatePolicy(req('0'), mandate(), 0n);
    expect(r.outcome).toBe('denied');
    expect(r.reasons[0]!.code).toBe('invalid_amount');
  });

  it('denies when there is no mandate', () => {
    const r = evaluatePolicy(req('1'), null, 0n);
    expect(r.outcome).toBe('denied');
    expect(r.reasons[0]!.code).toBe('no_mandate');
  });

  it('denies when the mandate is paused', () => {
    const r = evaluatePolicy(req('1'), mandate({ active: false }), 0n);
    expect(r.outcome).toBe('denied');
    expect(r.reasons[0]!.code).toBe('mandate_inactive');
  });

  it('hard denials win over soft escalations (unknown recipient AND over limit -> denied)', () => {
    const r = evaluatePolicy(req('60', BOB), mandate(), 0n);
    expect(r.outcome).toBe('denied');
    expect(r.reasons.map((x) => x.code)).toEqual(['exceeds_per_payment_limit']);
  });
});

describe('evaluatePolicy: needs_approval (soft rules)', () => {
  it('escalates a recipient that is not on the allowlist', () => {
    const r = evaluatePolicy(req('10', BOB), mandate(), 0n);
    expect(r.outcome).toBe('needs_approval');
    expect(r.reasons.map((x) => x.code)).toEqual(['recipient_not_allowed']);
  });

  it('escalates everything when the allowlist is empty', () => {
    const r = evaluatePolicy(req('1'), mandate({ allowedRecipients: [] }), 0n);
    expect(r.outcome).toBe('needs_approval');
  });

  it('escalates amounts above the approval threshold, even to an allowed recipient', () => {
    const m = mandate({ approvalThreshold: usdc('25') });
    const r = evaluatePolicy(req('25.01'), m, 0n);
    expect(r.outcome).toBe('needs_approval');
    expect(r.reasons.map((x) => x.code)).toEqual(['above_approval_threshold']);
  });

  it('does not escalate an amount equal to the threshold', () => {
    const m = mandate({ approvalThreshold: usdc('25') });
    expect(evaluatePolicy(req('25'), m, 0n).outcome).toBe('approved');
  });

  it('reports both soft reasons when both apply', () => {
    const m = mandate({ approvalThreshold: usdc('5') });
    const r = evaluatePolicy(req('10', BOB), m, 0n);
    expect(r.outcome).toBe('needs_approval');
    expect(r.reasons.map((x) => x.code)).toEqual(['recipient_not_allowed', 'above_approval_threshold']);
  });
});

describe('checkHardRules (used when a human approves a queued request)', () => {
  it('returns no reasons when hard rules still hold, even for a non-allowlisted recipient', () => {
    expect(checkHardRules(req('10', BOB), mandate(), 0n)).toEqual([]);
  });

  it('returns reasons when other spend has since used up the daily budget', () => {
    const reasons = checkHardRules(req('10', BOB), mandate(), usdc('95'));
    expect(reasons.map((r) => r.code)).toEqual(['exceeds_daily_limit']);
  });

  it('returns reasons when the mandate was paused after queueing', () => {
    const reasons = checkHardRules(req('10', BOB), mandate({ active: false }), 0n);
    expect(reasons.map((r) => r.code)).toEqual(['mandate_inactive']);
  });
});
