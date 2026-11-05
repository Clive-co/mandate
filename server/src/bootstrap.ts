import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { loadConfig, loadKeyRing, type Config } from './config';
import { connectPg, connectPglite, migrate, type Db } from './db';
import { MandateService } from './service';

/** Load `server/.env` if there is one; real environment variables win. */
export function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    /* no .env file: rely on the real environment */
  }
}

/** Wire config, database, keys and chain client into a ready-to-use service. Shared by the server and seed script. */
export async function createRuntime(config: Config = loadConfig()): Promise<{ config: Config; db: Db; service: MandateService }> {
  const db = config.databaseUrl ? connectPg(config.databaseUrl) : await connectPglite(config.pgliteDir);
  await migrate(db);
  const service = new MandateService({
    db,
    keys: await loadKeyRing(config),
    chain: createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) }),
    token: config.tokenAddress,
    chainId: baseSepolia.id,
    issuer: config.issuer,
  });
  return { config, db, service };
}
