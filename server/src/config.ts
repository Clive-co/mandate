import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { JWK } from 'jose';
import { isAddress, type Address } from 'viem';
import { KeyRing } from './keys';

/** USDC on Base Sepolia, from Circle: https://developers.circle.com/stablecoins/usdc-contract-addresses */
export const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;

export interface Config {
  port: number;
  /** Real Postgres when set; otherwise PGlite (in-process Postgres) at `pgliteDir`. */
  databaseUrl: string | null;
  pgliteDir: string;
  rpcUrl: string;
  tokenAddress: Address;
  corsOrigin: string;
  /** The `iss` claim in verdicts; the JWKS is served at `${issuer}/.well-known/jwks.json`. */
  issuer: string;
  production: boolean;
  signingKeyJwk: string | null;
  retiredJwks: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tokenAddress = (env.USDC_ADDRESS || USDC_BASE_SEPOLIA) as string;
  if (!isAddress(tokenAddress)) throw new Error(`USDC_ADDRESS is not a valid address: ${tokenAddress}`);
  const port = Number(env.PORT ?? 8787);

  return {
    port,
    databaseUrl: env.DATABASE_URL?.trim() || null,
    pgliteDir: env.PGLITE_DIR ?? './data/pglite',
    rpcUrl: env.RPC_URL ?? 'https://sepolia.base.org',
    tokenAddress,
    corsOrigin: env.CORS_ORIGIN ?? 'http://localhost:5173',
    issuer: (env.ISSUER ?? `http://localhost:${port}`).replace(/\/+$/, ''),
    production: env.NODE_ENV === 'production',
    signingKeyJwk: env.SIGNING_KEY_JWK?.trim() || null,
    retiredJwks: env.RETIRED_JWKS?.trim() || null,
  };
}

/**
 * Load the ES256 signing key. In production it must come from SIGNING_KEY_JWK (a private JWK as
 * JSON). In development, if it isn't set, a key is generated once and kept in data/signing-key.json
 * (gitignored, mode 0600) so restarts keep signing with the same key. It only signs verdicts and
 * never holds funds.
 */
export async function loadKeyRing(config: Config): Promise<KeyRing> {
  const retired = config.retiredJwks ? (JSON.parse(config.retiredJwks) as JWK[]) : [];
  if (config.signingKeyJwk) return KeyRing.fromPrivateJwk(JSON.parse(config.signingKeyJwk) as JWK, retired);
  if (config.production) throw new Error('SIGNING_KEY_JWK is required in production (run `npm run gen-key -w server`)');

  const file = join('./data', 'signing-key.json');
  if (existsSync(file)) return KeyRing.fromPrivateJwk(JSON.parse(readFileSync(file, 'utf8')) as JWK, retired);

  const keys = await KeyRing.generate();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(keys.exportPrivateJwk()), { mode: 0o600 });
  chmodSync(file, 0o600);
  console.warn(`[mandate] SIGNING_KEY_JWK not set: generated a dev signing key at ${file} (kid ${keys.kid})`);
  return keys;
}
