import { SignJWT, createLocalJWKSet, decodeProtectedHeader } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { KeyRing } from '../src/keys';
import { VERDICT_TTL_SECONDS, VERDICT_TYP, signVerdict, type VerdictInput } from '../src/verdict';
import { InMemoryNonceStore, verifyVerdict, type ExpectedPayment, type VerifyOptions } from '../src/verifier';
import { parseUsdc as usdc } from '../src/units';
import { ALICE, BOB, CHAIN_ID, ISSUER, USDC } from './helpers';

const T0 = new Date('2026-10-27T10:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

const input = (over: Partial<VerdictInput> = {}): VerdictInput => ({
  id: crypto.randomUUID(),
  agentId: 'agent-1',
  verdict: 'allow',
  reasonCode: null,
  amount: usdc('12.5'),
  currency: 'USDC',
  recipient: ALICE,
  category: 'cloud',
  chainId: CHAIN_ID,
  token: USDC,
  mandateId: 'mandate-1',
  mandateVersion: 1,
  ...over,
});

const expected: ExpectedPayment = { amount: usdc('12.5'), currency: 'USDC', recipient: ALICE };

let keys: KeyRing;
beforeAll(async () => {
  keys = await KeyRing.generate();
});

/** Fresh nonce store and options per test, so replay state never leaks between tests. */
function opts(over: Partial<VerifyOptions> = {}): VerifyOptions {
  return {
    keys: createLocalJWKSet(keys.jwks()),
    issuer: ISSUER,
    nonces: new InMemoryNonceStore(() => Math.floor(T0.getTime() / 1000)),
    now: T0,
    ...over,
  };
}

const issue = (over: Partial<VerdictInput> = {}, ring = keys) => signVerdict(ring, ISSUER, input(over), T0);

describe('signing a verdict', () => {
  it('produces an ES256 JWT with a kid, the right typ, a five-minute expiry and a nonce', async () => {
    const { token, claims } = await issue();
    expect(decodeProtectedHeader(token)).toEqual({ alg: 'ES256', kid: keys.kid, typ: VERDICT_TYP });
    expect(claims.exp - claims.iat).toBe(VERDICT_TTL_SECONDS);
    expect(VERDICT_TTL_SECONDS).toBe(300);
    expect(claims.nonce.length).toBeGreaterThanOrEqual(21); // 16 random bytes, base64url
    expect(claims).toMatchObject({ iss: ISSUER, sub: 'agent-1', amount: '12500000', currency: 'USDC', recipient: ALICE });
  });

  it('uses a different nonce every time', async () => {
    const nonces = new Set((await Promise.all(Array.from({ length: 50 }, () => issue()))).map((v) => v.claims.nonce));
    expect(nonces.size).toBe(50);
  });

  it('the kid is the key thumbprint and the JWKS never contains private material', () => {
    const [jwk] = keys.jwks().keys;
    expect(jwk).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig', kid: keys.kid });
    expect(JSON.stringify(keys.jwks())).not.toContain('"d"');
  });
});

describe('verifyVerdict: the happy path', () => {
  it('accepts a valid allow verdict that matches what the seller expects', async () => {
    const { token } = await issue();
    const r = await verifyVerdict(token, expected, opts());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims).toMatchObject({ verdict: 'allow', sub: 'agent-1' });
  });

  it('accepts a recipient written in a different case', async () => {
    const { token } = await issue();
    const r = await verifyVerdict(token, { ...expected, recipient: ALICE.toUpperCase().replace('0X', '0x') as typeof ALICE }, opts());
    expect(r.ok).toBe(true);
  });

  it('accepts the optional chain and token pins when they match', async () => {
    const { token } = await issue();
    expect((await verifyVerdict(token, { ...expected, chainId: CHAIN_ID, token: USDC }, opts())).ok).toBe(true);
  });
});

describe('verifyVerdict: comparing the payment terms', () => {
  it.each([
    ['amount', { amount: usdc('12.500001') }, 'amount_mismatch'],
    ['currency', { currency: 'EURC' }, 'currency_mismatch'],
    ['recipient', { recipient: BOB }, 'recipient_mismatch'],
    ['chain', { chainId: 1 }, 'chain_mismatch'],
    ['token', { token: BOB }, 'token_mismatch'],
  ])('rejects when the seller expects a different %s', async (_n, change, code) => {
    const { token } = await issue();
    const r = await verifyVerdict(token, { ...expected, ...change }, opts());
    expect(r).toMatchObject({ ok: false, code });
  });

  it('compares the amount as an exact integer: one base unit off is rejected', async () => {
    const { token } = await issue({ amount: usdc('12.5') + 1n });
    expect(await verifyVerdict(token, expected, opts())).toMatchObject({ ok: false, code: 'amount_mismatch' });
  });

  it('refuses a deny verdict even though its signature is valid', async () => {
    const { token } = await issue({ verdict: 'deny', reasonCode: 'exceeds_per_tx_limit' });
    expect(await verifyVerdict(token, expected, opts())).toMatchObject({ ok: false, code: 'verdict_denied' });
  });
});

describe('verifyVerdict: replay protection', () => {
  it('accepts a verdict once and rejects the second presentation', async () => {
    const { token } = await issue();
    const o = opts();
    expect((await verifyVerdict(token, expected, o)).ok).toBe(true);
    expect(await verifyVerdict(token, expected, o)).toMatchObject({ ok: false, code: 'replayed' });
  });

  it('does not burn the nonce when verification fails for another reason', async () => {
    const { token } = await issue();
    const o = opts();
    expect(await verifyVerdict(token, { ...expected, amount: usdc('99') }, o)).toMatchObject({ code: 'amount_mismatch' });
    expect((await verifyVerdict(token, expected, o)).ok).toBe(true); // the right terms still work, once
  });

  it('only one of several concurrent presentations succeeds', async () => {
    const { token } = await issue();
    const o = opts();
    const results = await Promise.all(Array.from({ length: 10 }, () => verifyVerdict(token, expected, o)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.code === 'replayed')).toHaveLength(9);
  });

  it('treats separate verdicts for identical payments as separate (distinct nonces)', async () => {
    const o = opts();
    const [a, b] = [await issue(), await issue()];
    expect((await verifyVerdict(a.token, expected, o)).ok).toBe(true);
    expect((await verifyVerdict(b.token, expected, o)).ok).toBe(true);
  });

  it('the in-memory store forgets nonces once they have expired', () => {
    let now = 1000;
    const store = new InMemoryNonceStore(() => now);
    expect(store.consume('n1', 1300)).toBe(true);
    expect(store.consume('n1', 1300)).toBe(false);
    now = 1301;
    expect(store.consume('n2', 1600)).toBe(true); // triggers cleanup of n1
    expect(store.consume('n1', 1900)).toBe(true); // forgotten
  });
});

describe('verifyVerdict: time', () => {
  it('accepts a verdict inside its five-minute window', async () => {
    const { token } = await issue();
    expect((await verifyVerdict(token, expected, opts({ now: at(299) }))).ok).toBe(true);
  });

  it('rejects a verdict after it expires (beyond the clock tolerance)', async () => {
    const { token } = await issue();
    expect(await verifyVerdict(token, expected, opts({ now: at(306) }))).toMatchObject({ ok: false, code: 'expired' });
  });

  it('rejects a verdict issued in the future', async () => {
    const { token } = await issue();
    expect(await verifyVerdict(token, expected, opts({ now: at(-60) }))).toMatchObject({ ok: false, code: 'not_yet_valid' });
  });
});

describe('verifyVerdict: forged and malformed tokens', () => {
  it('rejects a payload that was edited after signing', async () => {
    const { token } = await issue({ amount: usdc('1') });
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    payload.amount = usdc('12.5').toString();
    const forged = [h, Buffer.from(JSON.stringify(payload)).toString('base64url'), s].join('.');
    expect(await verifyVerdict(forged, expected, opts())).toMatchObject({ ok: false, code: 'bad_signature' });
  });

  it('rejects flipping a deny verdict to allow', async () => {
    const { token } = await issue({ verdict: 'deny', reasonCode: 'no_mandate' });
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    payload.verdict = 'allow';
    const forged = [h, Buffer.from(JSON.stringify(payload)).toString('base64url'), s].join('.');
    expect(await verifyVerdict(forged, expected, opts())).toMatchObject({ ok: false, code: 'bad_signature' });
  });

  it('rejects a token signed by another key that claims our kid', async () => {
    const attacker = await KeyRing.generate();
    const claims = (await issue()).claims;
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'ES256', kid: keys.kid, typ: VERDICT_TYP })
      .sign(attacker.key);
    expect(await verifyVerdict(token, expected, opts())).toMatchObject({ ok: false, code: 'bad_signature' });
  });

  it('rejects a token signed by another key under its own kid (not in our JWKS)', async () => {
    const attacker = await KeyRing.generate();
    const { token } = await issue({}, attacker);
    expect(await verifyVerdict(token, expected, opts())).toMatchObject({ ok: false, code: 'unknown_key' });
  });

  it('rejects an unsecured alg "none" token', async () => {
    const { claims } = await issue();
    const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${enc({ alg: 'none', typ: VERDICT_TYP })}.${enc(claims)}.`;
    const r = await verifyVerdict(none, expected, opts());
    expect(r.ok).toBe(false);
  });

  it('rejects an HS256 token (algorithm confusion): the verifier pins ES256', async () => {
    const { claims } = await issue();
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'HS256', kid: keys.kid, typ: VERDICT_TYP })
      .sign(new TextEncoder().encode('any-shared-secret-of-sufficient-length!!'));
    expect(await verifyVerdict(token, expected, opts())).toMatchObject({ ok: false, code: 'unsupported_algorithm' });
  });

  it('rejects a validly signed JWT that is not a verdict (wrong typ)', async () => {
    const { claims } = await issue();
    const token = await new SignJWT({ ...claims }).setProtectedHeader({ alg: 'ES256', kid: keys.kid, typ: 'JWT' }).sign(keys.key);
    expect(await verifyVerdict(token, expected, opts())).toMatchObject({ ok: false, code: 'wrong_type' });
  });

  it('rejects a verdict from an issuer the seller does not trust', async () => {
    const { token } = await signVerdict(keys, 'https://evil.example', input(), T0);
    expect(await verifyVerdict(token, expected, opts())).toMatchObject({ ok: false, code: 'wrong_issuer' });
  });

  it('rejects a signed token that lacks the claims it needs', async () => {
    const iat = Math.floor(T0.getTime() / 1000);
    const token = await new SignJWT({ iss: ISSUER, sub: 'a', iat, exp: iat + 300 })
      .setProtectedHeader({ alg: 'ES256', kid: keys.kid, typ: VERDICT_TYP })
      .sign(keys.key);
    expect(await verifyVerdict(token, expected, opts())).toMatchObject({ ok: false, code: 'malformed_claims' });
  });

  it.each(['', 'garbage', 'a.b.c', 'eyJhbGciOiJFUzI1NiJ9.e30.'])('rejects malformed input %j without throwing', async (bad) => {
    const r = await verifyVerdict(bad, expected, opts());
    expect(r.ok).toBe(false);
  });
});

describe('key rotation', () => {
  it('verdicts signed by a retired key keep verifying while it stays in the JWKS', async () => {
    const oldKeys = await KeyRing.generate();
    const { token } = await issue({}, oldKeys);
    const rotated = await KeyRing.fromPrivateJwk(
      (await KeyRing.generate()).exportPrivateJwk(),
      oldKeys.jwks().keys, // the retired PUBLIC key
    );
    expect(rotated.jwks().keys.map((k) => k.kid)).toContain(oldKeys.kid);
    expect((await verifyVerdict(token, expected, opts({ keys: createLocalJWKSet(rotated.jwks()) }))).ok).toBe(true);
  });

  it('once the retired key is dropped from the JWKS, its verdicts are rejected', async () => {
    const oldKeys = await KeyRing.generate();
    const { token } = await issue({}, oldKeys);
    expect(await verifyVerdict(token, expected, opts())).toMatchObject({ ok: false, code: 'unknown_key' });
  });

  it('rejects a private JWK that is not P-256', async () => {
    await expect(KeyRing.fromPrivateJwk({ kty: 'oct', k: 'AAAA' })).rejects.toThrow('P-256');
  });
});
