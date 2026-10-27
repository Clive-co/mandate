import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isAddress, isHex, type Address, type Hex } from 'viem';
import { newSignerKey } from './signing';

/** USDC on Base Sepolia, from Circle: https://developers.circle.com/stablecoins/usdc-contract-addresses */
export const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;

export interface Config {
  port: number;
  dbPath: string;
  rpcUrl: string;
  signerKey: Hex;
  tokenAddress: Address;
  corsOrigin: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const tokenAddress = (env.USDC_ADDRESS || USDC_BASE_SEPOLIA) as string;
  if (!isAddress(tokenAddress)) throw new Error(`USDC_ADDRESS is not a valid address: ${tokenAddress}`);

  const dbPath = env.DB_PATH ?? './data/mandate.db';
  const signerKey = env.SIGNER_PRIVATE_KEY?.trim() || devSignerKey(dbPath, env.NODE_ENV === 'production');
  if (!isHex(signerKey) || signerKey.length !== 66) {
    throw new Error('SIGNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string');
  }

  return {
    port: Number(env.PORT ?? 8787),
    dbPath,
    rpcUrl: env.RPC_URL ?? 'https://sepolia.base.org',
    signerKey,
    tokenAddress,
    corsOrigin: env.CORS_ORIGIN ?? 'http://localhost:5173',
  };
}

/**
 * No SIGNER_PRIVATE_KEY set. In production that's an error. In development we generate a key once
 * and keep it next to the database (data/signer.key, gitignored), so the server, the seed script
 * and restarts all sign with the same key and old decisions keep verifying. The key only signs
 * decisions and never holds funds.
 */
function devSignerKey(dbPath: string, production: boolean): Hex {
  if (production) throw new Error('SIGNER_PRIVATE_KEY is required in production');
  if (dbPath === ':memory:') return newSignerKey();

  const file = join(dirname(dbPath), 'signer.key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim() as Hex;

  const key = newSignerKey();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  console.warn(`[mandate] No SIGNER_PRIVATE_KEY set: generated a dev signing key at ${file}`);
  return key;
}
