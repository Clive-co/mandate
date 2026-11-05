import { buildApp } from './app';
import { createRuntime, loadDotEnv } from './bootstrap';
import { loadConfig } from './config';

loadDotEnv();
const { config, db, service } = await createRuntime(loadConfig());

const app = buildApp(service, { corsOrigin: config.corsOrigin, logger: true });

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ port: config.port, host: '0.0.0.0' });
app.log.info(`Database: ${db.kind}. JWKS: ${config.issuer}/.well-known/jwks.json`);
