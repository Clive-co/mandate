import { isAddressEqual, type Address } from 'viem';
import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { VERDICT_TYP, type VerdictClaims } from './verdict';

/**
 * The verifier: what a SELLER runs before delivering goods or services to an agent.
 *
 * It deliberately knows nothing about this server's database. It needs only:
 *   - the issuer's public keys (the JWKS), and
 *   - what the seller itself expects to be paid: amount, currency, recipient.
 *
 * A seller would wire the keys up like this (jose fetches and caches the JWKS):
 *
 *   const keys = createRemoteJWKSet(new URL('https://mandate.example/.well-known/jwks.json'));
 *   const result = await verifyVerdict(token, expected, { keys, issuer, nonces });
 *   if (!result.ok) refuse(result.code);
 *
 * Order of checks: signature and header, then time, then the verdict itself, then that the
 * payment terms match what the seller expects, and ONLY THEN is the nonce consumed. Consuming
 * it last means a verification that fails for another reason doesn't burn a good token.
 */

export interface ExpectedPayment {
  /** Base units of USDC (6 decimals). */
  amount: bigint;
  currency: string;
  recipient: Address;
  /** Optional extra pins. */
  chainId?: number;
  token?: Address;
}

/** Remembers nonces so a verdict can only be accepted once. `consume` must be atomic. */
export interface NonceStore {
  /** Returns true if the nonce was new (and is now recorded), false if it was already seen. */
  consume(nonce: string, expiresAtSeconds: number): boolean | Promise<boolean>;
}

/** Fine for one process. Several seller instances need a shared store (e.g. Redis `SET NX EX`). */
export class InMemoryNonceStore implements NonceStore {
  private readonly seen = new Map<string, number>();

  constructor(private readonly nowSeconds: () => number = () => Math.floor(Date.now() / 1000)) {}

  consume(nonce: string, expiresAtSeconds: number): boolean {
    const now = this.nowSeconds();
    for (const [n, exp] of this.seen) if (exp < now) this.seen.delete(n); // forget expired ones
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, expiresAtSeconds);
    return true;
  }
}

export type VerifyErrorCode =
  | 'malformed'
  | 'unsupported_algorithm'
  | 'unknown_key'
  | 'bad_signature'
  | 'wrong_type'
  | 'wrong_issuer'
  | 'expired'
  | 'not_yet_valid'
  | 'malformed_claims'
  | 'verdict_denied'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'recipient_mismatch'
  | 'chain_mismatch'
  | 'token_mismatch'
  | 'replayed';

export type VerifyResult =
  | { ok: true; claims: VerdictClaims }
  | { ok: false; code: VerifyErrorCode; message: string };

export interface VerifyOptions {
  keys: JWTVerifyGetKey;
  /** The issuer the seller trusts, e.g. "https://mandate.example". */
  issuer: string;
  nonces: NonceStore;
  /** Injectable for tests. */
  now?: Date;
  /** Allowed clock difference between issuer and seller. Default 5 seconds. */
  clockToleranceSeconds?: number;
}

const fail = (code: VerifyErrorCode, message: string): VerifyResult => ({ ok: false, code, message });

export async function verifyVerdict(
  token: string,
  expected: ExpectedPayment,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const now = opts.now ?? new Date();
  const tolerance = opts.clockToleranceSeconds ?? 5;

  let payload;
  try {
    // algorithms is pinned to ES256: the token can't choose its own algorithm (no "none", no HS256 trick).
    ({ payload } = await jwtVerify(token, opts.keys, {
      algorithms: ['ES256'],
      typ: VERDICT_TYP,
      issuer: opts.issuer,
      currentDate: now,
      clockTolerance: tolerance,
    }));
  } catch (err) {
    return mapJoseError(err);
  }

  const claims = asClaims(payload);
  if (!claims) return fail('malformed_claims', 'The verdict is missing required claims');

  if (claims.iat > Math.floor(now.getTime() / 1000) + tolerance) {
    return fail('not_yet_valid', 'The verdict was issued in the future');
  }
  if (claims.verdict !== 'allow') {
    return fail('verdict_denied', `The verdict is "${claims.verdict}"${claims.reasonCode ? ` (${claims.reasonCode})` : ''}`);
  }

  // Compare as bigint: exact, no float rounding, and "10" vs "10.0" can't sneak through.
  if (BigInt(claims.amount) !== expected.amount) {
    return fail('amount_mismatch', `Verdict authorizes ${claims.amount}, seller expects ${expected.amount}`);
  }
  if (claims.currency !== expected.currency) {
    return fail('currency_mismatch', `Verdict is in ${claims.currency}, seller expects ${expected.currency}`);
  }
  if (!sameAddress(claims.recipient, expected.recipient)) {
    return fail('recipient_mismatch', `Verdict pays ${claims.recipient}, seller expects ${expected.recipient}`);
  }
  if (expected.chainId !== undefined && claims.chainId !== expected.chainId) {
    return fail('chain_mismatch', `Verdict is for chain ${claims.chainId}, seller expects ${expected.chainId}`);
  }
  if (expected.token !== undefined && !sameAddress(claims.token, expected.token)) {
    return fail('token_mismatch', `Verdict is for token ${claims.token}, seller expects ${expected.token}`);
  }

  if (!(await opts.nonces.consume(claims.nonce, claims.exp + tolerance))) {
    return fail('replayed', 'This verdict has already been used');
  }
  return { ok: true, claims };
}

function mapJoseError(err: unknown): VerifyResult {
  const e = err as { code?: string; claim?: string; message?: string };
  switch (e.code) {
    case 'ERR_JWT_EXPIRED':
      return fail('expired', 'The verdict has expired');
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
      return fail('bad_signature', 'The signature does not verify');
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return fail('unsupported_algorithm', 'Only ES256 verdicts are accepted');
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
      return fail('unknown_key', 'No key in the JWKS matches this verdict');
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED':
      if (e.claim === 'typ') return fail('wrong_type', 'This token is not a Mandate verdict');
      if (e.claim === 'iss') return fail('wrong_issuer', 'The verdict was issued by an unexpected issuer');
      if (e.claim === 'nbf') return fail('not_yet_valid', 'The verdict is not valid yet');
      return fail('malformed_claims', e.message ?? 'Invalid claims');
    default:
      return fail('malformed', 'Not a valid signed verdict');
  }
}

/** Runtime check of the claims we rely on, since a JWT payload is untrusted JSON until proven otherwise. */
function asClaims(p: Record<string, unknown>): VerdictClaims | null {
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  const ok =
    str(p.nonce) &&
    str(p.sub) &&
    str(p.jti) &&
    (p.verdict === 'allow' || p.verdict === 'deny') &&
    typeof p.amount === 'string' &&
    /^\d+$/.test(p.amount) &&
    str(p.currency) &&
    str(p.recipient) &&
    str(p.token) &&
    typeof p.chainId === 'number' &&
    typeof p.iat === 'number' &&
    typeof p.exp === 'number';
  return ok ? (p as VerdictClaims) : null;
}

function sameAddress(a: string, b: string): boolean {
  try {
    return isAddressEqual(a as Address, b as Address);
  } catch {
    return false;
  }
}
