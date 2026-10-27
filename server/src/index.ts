import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { buildApp } from './app';
import { loadConfig } from './config';
import { openDb } from './db';
import { MandateService } from './service';
import { DecisionSigner } from './signing';
import { Store } from './store';

try {
  process.loadEnvFile('.env'); // server/.env, if present
} catch {
  /* no .env file: rely on the real environment */
}

const config = loadConfig();

const service = new MandateService({
  store: new Store(openDb(config.dbPath)),
  signer: new DecisionSigner(config.signerKey),
  chain: createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) }),
  token: config.tokenAddress,
});

const app = buildApp(service, { corsOrigin: config.corsOrigin, logger: true });

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(`Decision signer address: ${service.signerAddress}`);
