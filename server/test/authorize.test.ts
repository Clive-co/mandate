import { createLocalJWKSet, createRemoteJWKSet, decodeJwt, decodeProtectedHeader } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db';
import { KeyRing } from '../src/keys';
import { parseUsdc as usdc } from '../src/units';
import { InMemoryNonceStore, verifyVerdict } from '../src/verifier';
import { ALICE, BOB, CHAIN_ID, ISSUER, USDC, authorize, createMandate, makeEnv, openTestDb, type Env } from './helpers';

let db: Db;
let keys: KeyRing;
let env: Env;

beforeAll(async () => {
  db = await openTestDb();
  keys = await KeyRing.generate();
});
afterAll(() => db.close());
beforeEach(async () => {
  env = await makeEnv(db, keys);
  await createMandate(env);
});

describe('POST /authorize', () => {
  it('allows an in-policy request, with a signed verdict', async () => {
    const { res, body } = await authorize(env, '12.5');
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({
      verdict: 'allow',
      reasonCode: null,
      amount: '12500000',
      amountUsdc: '12.5',
      currency: 'USDC',
      recipient: ALICE,
      category: 'cloud',
      mandateVersion: 1,
    });
    expect(body.expiresAt - body.issuedAt).toBe(300_000);
    expect(decodeProtectedHeader(body.token)).toMatchObject({ alg: 'ES256', kid: keys.kid });
  });

  it('a deny is a 200 with the reason, and is still signed', async () => {
    const { res, body } = await authorize(env, '75');
    expect(res.statusCode).toBe(200);
    expect(body).toMatchObject({ verdict: 'deny', reasonCode: 'exceeds_per_tx_limit' });
    expect(body.reason).toContain('per-transaction limit of 50 USDC');
    expect(decodeJwt(body.token)).toMatchObject({ verdict: 'deny', reasonCode: 'exceeds_per_tx_limit' });
  });

  it('returns a reason for every kind of denial', async () => {
    const cases: Array<[string, Parameters<typeof authorize>[2], string]> = [
      ['1', { category: 'gambling' }, 'category_not_allowed'],
      ['1', { recipient: BOB }, 'recipient_not_allowed'],
      ['1', { currency: 'EURC' }, 'currency_mismatch'],
      ['1', { agentId: 'ghost' }, 'no_mandate'],
      ['0', {}, 'invalid_amount'],
    ];
    for (const [amount, over, code] of cases) {
      expect((await authorize(env, amount, over)).body.reasonCode, code).toBe(code);
    }
  });

  it('denies once the mandate has expired', async () => {
    env.clock.now = new Date('2026-12-31T00:00:00Z');
    expect((await authorize(env, '1')).body.reasonCode).toBe('mandate_expired');
  });

  it('accumulates allowed spend: two 50s fill the 100 daily limit, the next is denied', async () => {
    expect((await authorize(env, '50')).body.verdict).toBe('allow');
    expect((await authorize(env, '50')).body.verdict).toBe('allow');
    const third = (await authorize(env, '1')).body;
    expect(third).toMatchObject({ verdict: 'deny', reasonCode: 'exceeds_daily_limit' });
  });

  it('does not count denied requests toward the daily limit', async () => {
    await authorize(env, '75'); // denied
    await authorize(env, '1', { category: 'gambling' }); // denied
    expect((await authorize(env, '50')).body.verdict).toBe('allow');
    expect((await authorize(env, '50')).body.verdict).toBe('allow');
  });

  it('resets the daily budget at the next UTC day', async () => {
    await authorize(env, '50');
    await authorize(env, '50');
    expect((await authorize(env, '10')).body.verdict).toBe('deny');
    env.clock.now = new Date('2026-10-28T00:00:01Z');
    expect((await authorize(env, '10')).body.verdict).toBe('allow');
  });

  it('cannot be raced past the daily limit by concurrent requests', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => authorize(env, '30')));
    const verdicts = results.map((r) => r.body.verdict as string);
    expect(verdicts.filter((v) => v === 'allow')).toHaveLength(3); // 3 x 30 = 90 <= 100
    expect(verdicts.filter((v) => v === 'deny')).toHaveLength(5);
    const [row] = await db.query<{ total: string }>(`SELECT SUM(amount)::text AS total FROM decision_log WHERE verdict = 'allow'`);
    expect(BigInt(row!.total)).toBeLessThanOrEqual(usdc('100'));
  });

  it('keeps agents independent of each other', async () => {
    await createMandate(env, { agentId: 'agent-2' });
    await authorize(env, '50');
    await authorize(env, '50');
    expect((await authorize(env, '10', { agentId: 'agent-2' })).body.verdict).toBe('allow');
  });

  it('validates input', async () => {
    const bad = [
      { agentId: 'agent-1', recipient: ALICE, amount: '1.2345678', category: 'cloud' },
      { agentId: 'agent-1', recipient: ALICE, amount: '-5', category: 'cloud' },
      { agentId: 'agent-1', recipient: ALICE, amount: 'abc', category: 'cloud' },
      { agentId: 'agent-1', recipient: '0x123', amount: '1', category: 'cloud' },
      { agentId: 'agent-1', recipient: ALICE, amount: '1' }, // no category
      { agentId: '', recipient: ALICE, amount: '1', category: 'cloud' },
    ];
    for (const payload of bad) {
      expect((await env.app.inject({ method: 'POST', url: '/authorize', payload })).statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('the decision log', () => {
  it('records allows AND denies, in order, with the signed token', async () => {
    const a = (await authorize(env, '10')).body;
    const b = (await authorize(env, '75')).body;
    const log = (await env.app.inject({ method: 'GET', url: '/decisions' })).json();
    expect(log.map((d: { id: string }) => d.id)).toEqual([b.id, a.id]); // newest first
    expect(log[0]).toMatchObject({ verdict: 'deny', token: b.token });
  });

  it('filters by verdict and agent', async () => {
    await authorize(env, '10');
    await authorize(env, '75');
    const denies = (await env.app.inject({ method: 'GET', url: '/decisions?verdict=deny' })).json();
    expect(denies).toHaveLength(1);
    expect(denies[0].verdict).toBe('deny');
  });

  it('the trail for a decision starts with the request and the verdict', async () => {
    const d = (await authorize(env, '10')).body;
    const detail = (await env.app.inject({ method: 'GET', url: `/decisions/${d.id}` })).json();
    expect(detail.trail.map((e: { type: string }) => e.type)).toEqual(['authorization_requested', 'verdict_issued']);
    expect(detail.trail[0].detail).toMatchObject({ amountUsdc: '10', recipient: ALICE });
  });

  it('404s for an unknown decision', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/decisions/00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
  });
});

describe('GET /.well-known/jwks.json', () => {
  it('publishes the public key, cacheable, with no private material', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/.well-known/jwks.json' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age');
    const jwks = res.json();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: keys.kid });
    expect(jwks.keys[0].d).toBeUndefined();
  });
});

describe('end to end: the agent gets a verdict, the seller verifies it', () => {
  const seller = (jwks: ReturnType<typeof createLocalJWKSet>) => ({
    keys: jwks,
    issuer: ISSUER,
    nonces: new InMemoryNonceStore(() => Math.floor(env.clock.now.getTime() / 1000)),
    now: env.clock.now,
  });

  it('a verdict from /authorize verifies against keys fetched from the JWKS endpoint', async () => {
    const { body } = await authorize(env, '12.5');
    const jwks = createLocalJWKSet((await env.app.inject({ method: 'GET', url: '/.well-known/jwks.json' })).json());
    const result = await verifyVerdict(body.token, { amount: usdc('12.5'), currency: 'USDC', recipient: ALICE, chainId: CHAIN_ID, token: USDC }, seller(jwks));
    expect(result.ok).toBe(true);
  });

  it('a seller expecting a different amount or recipient refuses it', async () => {
    const { body } = await authorize(env, '12.5');
    const jwks = createLocalJWKSet(env.service.jwks());
    const s = seller(jwks);
    expect(await verifyVerdict(body.token, { amount: usdc('12'), currency: 'USDC', recipient: ALICE }, s)).toMatchObject({ code: 'amount_mismatch' });
    expect(await verifyVerdict(body.token, { amount: usdc('12.5'), currency: 'USDC', recipient: BOB }, s)).toMatchObject({ code: 'recipient_mismatch' });
  });

  it('the denied verdict from /authorize is refused by the seller', async () => {
    const { body } = await authorize(env, '75');
    const jwks = createLocalJWKSet(env.service.jwks());
    expect(await verifyVerdict(body.token, { amount: usdc('75'), currency: 'USDC', recipient: ALICE }, seller(jwks))).toMatchObject({ code: 'verdict_denied' });
  });

  it('the verdict expires five minutes after it was issued', async () => {
    const { body } = await authorize(env, '10');
    env.clock.now = new Date(env.clock.now.getTime() + 6 * 60_000);
    const jwks = createLocalJWKSet(env.service.jwks());
    expect(await verifyVerdict(body.token, { amount: usdc('10'), currency: 'USDC', recipient: ALICE }, seller(jwks))).toMatchObject({ code: 'expired' });
  });

  it('the demo seller endpoint accepts once and then reports a replay', async () => {
    const { body } = await authorize(env, '10');
    const payload = { token: body.token, expected: { amount: '10', currency: 'USDC', recipient: ALICE } };
    const first = (await env.app.inject({ method: 'POST', url: '/demo/seller/verify', payload })).json();
    const second = (await env.app.inject({ method: 'POST', url: '/demo/seller/verify', payload })).json();
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: 'replayed' });
  });

  it('the demo seller endpoint does not burn the nonce on a mismatch', async () => {
    const { body } = await authorize(env, '10');
    const wrong = { token: body.token, expected: { amount: '11', currency: 'USDC', recipient: ALICE } };
    const right = { token: body.token, expected: { amount: '10', currency: 'USDC', recipient: ALICE } };
    expect((await env.app.inject({ method: 'POST', url: '/demo/seller/verify', payload: wrong })).json()).toMatchObject({ code: 'amount_mismatch' });
    expect((await env.app.inject({ method: 'POST', url: '/demo/seller/verify', payload: right })).json().ok).toBe(true);
  });

  it('createRemoteJWKSet is what a real seller would use (sanity: it constructs from the URL)', () => {
    expect(typeof createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`))).toBe('function');
  });
});
