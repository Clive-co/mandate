import { describe, expect, it } from 'vitest';
import { evaluatePolicy } from '../src/policy';
import type { AuthorizeInput, MandateRecord } from '../src/types';
import { parseUsdc as usdc } from '../src/units';
import { ALICE, BOB } from './helpers';

const NOW = new Date('2026-10-27T10:00:00Z');

const mandate = (over: Partial<MandateRecord> = {}): MandateRecord => ({
  id: 'm-1',
  agentId: 'agent-1',
  version: 1,
  perTxLimit: usdc('50'),
  dailyLimit: usdc('100'),
  currency: 'USDC',
  categories: ['cloud', 'data'],
  allowedRecipients: [ALICE],
  payerAddress: null,
  expiresAt: new Date('2026-12-31T00:00:00Z'),
  createdAt: new Date('2026-10-01T00:00:00Z'),
  revokedAt: null,
  revokeReason: null,
  replacedBy: null,
  ...over,
});

const req = (amount: string, over: Partial<AuthorizeInput> = {}): AuthorizeInput => ({
  agentId: 'agent-1',
  amount: usdc(amount),
  currency: 'USDC',
  recipient: ALICE,
  category: 'cloud',
  ...over,
});

const run = (r: AuthorizeInput, m: MandateRecord | null = mandate(), spent = 0n, now = NOW) => evaluatePolicy(r, m, spent, now);

describe('allow', () => {
  it('allows an in-policy request', () => {
    expect(run(req('10'))).toEqual({ verdict: 'allow', code: null, reason: 'Within mandate' });
  });

  it('limits are inclusive: exactly the per-tx limit is allowed', () => {
    expect(run(req('50')).verdict).toBe('allow');
  });

  it('limits are inclusive: spend landing exactly on the daily limit is allowed', () => {
    expect(run(req('50'), mandate(), usdc('50')).verdict).toBe('allow');
  });

  it('any recipient is allowed when the mandate has no allowlist', () => {
    expect(run(req('1', { recipient: BOB }), mandate({ allowedRecipients: null })).verdict).toBe('allow');
  });

  it('matches recipients case-insensitively', () => {
    expect(run(req('1', { recipient: ALICE.toUpperCase().replace('0X', '0x') as typeof ALICE })).verdict).toBe('allow');
  });
});

describe('deny: one reason per check', () => {
  it.each([
    ['amount is zero', () => run(req('0')), 'invalid_amount'],
    ['there is no mandate', () => run(req('1'), null), 'no_mandate'],
    ['the mandate is revoked', () => run(req('1'), mandate({ revokedAt: NOW, revokeReason: 'agent compromised' })), 'mandate_revoked'],
    ['the mandate has expired', () => run(req('1'), mandate({ expiresAt: new Date('2026-10-01T00:00:00Z') })), 'mandate_expired'],
    ['the currency differs', () => run(req('1', { currency: 'EURC' })), 'currency_mismatch'],
    ['the category is not allowed', () => run(req('1', { category: 'gambling' })), 'category_not_allowed'],
    ['the recipient is not on the allowlist', () => run(req('1', { recipient: BOB })), 'recipient_not_allowed'],
    ['the amount exceeds the per-tx limit', () => run(req('50.000001')), 'exceeds_per_tx_limit'],
    ['the day would exceed the daily limit', () => run(req('20'), mandate(), usdc('90')), 'exceeds_daily_limit'],
  ])('denies when %s', (_name, fn, code) => {
    const r = fn();
    expect(r.verdict).toBe('deny');
    expect(r.code).toBe(code);
    expect(r.reason.length).toBeGreaterThan(0);
  });

  it('explains how much of the daily budget is left', () => {
    expect(run(req('20'), mandate(), usdc('90')).reason).toContain('10 USDC left today');
  });
});

describe('expiry', () => {
  const m = mandate({ expiresAt: new Date('2026-10-27T10:00:00Z') });
  it('is expired at the exact instant of expiresAt', () => {
    expect(run(req('1'), m, 0n, new Date('2026-10-27T10:00:00Z')).code).toBe('mandate_expired');
  });
  it('is still valid one millisecond earlier', () => {
    expect(run(req('1'), m, 0n, new Date('2026-10-27T09:59:59.999Z')).verdict).toBe('allow');
  });
});

describe('precedence: the first failing check wins', () => {
  it('revoked beats expired', () => {
    const m = mandate({ revokedAt: NOW, revokeReason: 'x', expiresAt: new Date('2026-01-01T00:00:00Z') });
    expect(run(req('1'), m).code).toBe('mandate_revoked');
  });

  it('a bad category beats a bad recipient and an over-limit amount', () => {
    expect(run(req('999', { category: 'gambling', recipient: BOB })).code).toBe('category_not_allowed');
  });

  it('a bad recipient beats an over-limit amount', () => {
    expect(run(req('999', { recipient: BOB })).code).toBe('recipient_not_allowed');
  });

  it('the per-tx limit is reported before the daily limit', () => {
    expect(run(req('60'), mandate({ dailyLimit: usdc('70') }), usdc('20')).code).toBe('exceeds_per_tx_limit');
  });

  it('amount <= 0 is rejected before anything else, even with no mandate', () => {
    expect(run(req('0'), null).code).toBe('invalid_amount');
  });
});
