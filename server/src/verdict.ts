import { randomBytes } from 'node:crypto';
import { SignJWT, type JWTPayload } from 'jose';
import { ALG, type KeyRing } from './keys';
import type { ReasonCode, Verdict } from './types';

/** The JWT `typ` header. A verifier must check it so other JWTs from the same issuer can't be passed off as verdicts. */
export const VERDICT_TYP = 'mandate-verdict+jwt';

/** A verdict is good for five minutes. */
export const VERDICT_TTL_SECONDS = 300;

/**
 * The claims inside a verdict JWT.
 *
 * Registered claims: iss (issuer), sub (agent id), iat, exp, jti (the decision id, which links the
 * token to the decision log). Everything else is Mandate-specific. `amount` is a string of USDC
 * base units (6 decimals), because JSON numbers are floats and money must not be.
 */
export interface VerdictClaims extends JWTPayload {
  iss: string;
  sub: string;
  iat: number;
  exp: number;
  jti: string;
  /** Random single-use value. A seller remembers it until `exp` to reject replays. */
  nonce: string;
  verdict: Verdict;
  reasonCode: ReasonCode | null;
  amount: string;
  currency: string;
  recipient: string;
  category: string;
  chainId: number;
  /** USDC contract address the payment must be made in. */
  token: string;
  mandateId: string | null;
  mandateVersion: number | null;
}

export interface VerdictInput {
  id: string;
  agentId: string;
  verdict: Verdict;
  reasonCode: ReasonCode | null;
  amount: bigint;
  currency: string;
  recipient: string;
  category: string;
  chainId: number;
  token: string;
  mandateId: string | null;
  mandateVersion: number | null;
}

export interface SignedVerdict {
  token: string;
  claims: VerdictClaims;
  issuedAt: Date;
  expiresAt: Date;
}

export async function signVerdict(
  keys: KeyRing,
  issuer: string,
  input: VerdictInput,
  now: Date,
): Promise<SignedVerdict> {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + VERDICT_TTL_SECONDS;
  const claims: VerdictClaims = {
    iss: issuer,
    sub: input.agentId,
    iat,
    exp,
    jti: input.id,
    nonce: randomBytes(16).toString('base64url'),
    verdict: input.verdict,
    reasonCode: input.reasonCode,
    amount: input.amount.toString(),
    currency: input.currency,
    recipient: input.recipient,
    category: input.category,
    chainId: input.chainId,
    token: input.token,
    mandateId: input.mandateId,
    mandateVersion: input.mandateVersion,
  };
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: ALG, kid: keys.kid, typ: VERDICT_TYP })
    .sign(keys.key);
  return { token, claims, issuedAt: new Date(iat * 1000), expiresAt: new Date(exp * 1000) };
}
