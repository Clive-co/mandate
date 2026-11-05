import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { createLocalJWKSet } from 'jose';
import { isAddress, isHash, type Hash } from 'viem';
import { z, ZodError } from 'zod';
import { apiDecision, apiDecisionListItem, apiDetail, apiMandate, apiRecon, apiSummary } from './serialize';
import { AppError, MandateService, normalizeAddress } from './service';
import { CURRENCY, type MandateTerms } from './types';
import { parseUsdc } from './units';
import { InMemoryNonceStore, verifyVerdict, type NonceStore } from './verifier';

// ---------------------------------------------------------------- input schemas

const MAX_BASE_UNITS = 2n ** 128n - 1n;

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), 'must be a valid 0x address')
  .transform((v) => normalizeAddress(v.toLowerCase()));

/** A decimal USDC string such as "12.5" (at most 6 places) -> base units as bigint. */
const usdcAmount = z.string().transform((v, ctx) => {
  try {
    const n = parseUsdc(v);
    if (n > MAX_BASE_UNITS) throw new Error('amount is too large');
    return n;
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: (e as Error).message });
    return z.NEVER;
  }
});

const agentId = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'letters, digits, _ . - only');
const category = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/, 'lowercase letters, digits, _ - (max 32)'));
const reason = z.string().trim().min(1).max(200);

const terms = z.object({
  perTxLimit: usdcAmount,
  dailyLimit: usdcAmount,
  currency: z.literal(CURRENCY).default(CURRENCY),
  categories: z.array(category).min(1).max(50),
  allowedRecipients: z.array(address).min(1).max(200).nullable().default(null),
  payerAddress: address.nullable().default(null),
  expiresAt: z.string().datetime({ offset: true }).transform((v) => new Date(v)),
});

const createMandateBody = terms.extend({ agentId });
const replaceBody = terms.extend({ reason: reason.default('replaced') });
const revokeBody = z.object({ reason });

const authorizeBody = z.object({
  agentId,
  amount: usdcAmount,
  currency: z.string().min(1).max(16).default(CURRENCY),
  recipient: address,
  category,
});

const txBody = z.object({
  txHash: z.string().refine((v) => isHash(v), 'must be a 0x-prefixed 32-byte transaction hash'),
});

const sellerBody = z.object({
  token: z.string().min(1),
  expected: z.object({ amount: usdcAmount, currency: z.string().min(1), recipient: address }),
});

const decisionsQuery = z.object({
  verdict: z.enum(['allow', 'deny']).optional(),
  agentId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export interface AppOptions {
  corsOrigin?: string | boolean;
  logger?: boolean;
  /** Nonce store for the demo seller endpoint. Defaults to an in-memory one. */
  sellerNonces?: NonceStore;
  now?: () => Date;
}

export function buildApp(service: MandateService, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const now = opts.now ?? (() => new Date());
  const sellerNonces = opts.sellerNonces ?? new InMemoryNonceStore(() => Math.floor(now().getTime() / 1000));

  void app.register(cors, { origin: opts.corsOrigin ?? true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'invalid_request',
        message: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
      });
    }
    app.log.error(err);
    const e = err as Error & { statusCode?: number };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: 'bad_request', message: e.message });
    }
    return reply.status(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  app.get('/health', async () => ({ ok: true }));

  /** The public keys a seller uses to verify verdicts. Cacheable: keys change rarely. */
  app.get('/.well-known/jwks.json', async (_req, reply) => {
    void reply.header('cache-control', 'public, max-age=300');
    return service.jwks();
  });

  // ---- mandates (immutable; change = revoke-and-replace) ----

  app.post('/mandates', async (req, reply) => {
    const { agentId: id, ...rest } = createMandateBody.parse(req.body);
    const m = await service.createMandate(id, rest satisfies MandateTerms);
    return reply.status(201).send(apiMandate(m, now()));
  });

  app.get('/mandates', async (req) => {
    const q = z.object({ agentId: z.string().optional() }).parse(req.query);
    return (await service.listMandates(q.agentId)).map((m) => apiMandate(m, now()));
  });

  app.get<{ Params: { id: string } }>('/mandates/:id', async (req) => apiMandate(await service.getMandate(req.params.id), now()));

  app.post<{ Params: { id: string } }>('/mandates/:id/replace', async (req, reply) => {
    const { reason: why, ...rest } = replaceBody.parse(req.body);
    return reply.status(201).send(apiMandate(await service.replaceMandate(req.params.id, rest, why), now()));
  });

  app.post<{ Params: { id: string } }>('/mandates/:id/revoke', async (req) => {
    const { reason: why } = revokeBody.parse(req.body);
    return apiMandate(await service.revokeMandate(req.params.id, why), now());
  });

  // ---- authorization ----

  /**
   * The agent's call. Always 200 when the request was well-formed: a deny is a successful
   * answer, not an error. The body carries the verdict, the reason, and the signed JWT.
   */
  app.post('/authorize', async (req) => {
    const body = authorizeBody.parse(req.body);
    return apiDecision(await service.authorize(body));
  });

  app.get('/decisions', async (req) => {
    const q = decisionsQuery.parse(req.query);
    return (await service.listDecisions(q)).map(apiDecisionListItem);
  });

  app.get<{ Params: { id: string } }>('/decisions/:id', async (req) => apiDetail(await service.getDecisionDetail(req.params.id), now()));

  // ---- onchain reconciliation ----

  app.post<{ Params: { id: string } }>('/decisions/:id/payment', async (req, reply) => {
    const body = txBody.parse(req.body);
    return reply.status(201).send(apiRecon(await service.attachPayment(req.params.id, body.txHash as Hash)));
  });

  app.post<{ Params: { id: string } }>('/decisions/:id/payment/recheck', async (req) =>
    apiRecon(await service.recheckPayment(req.params.id)),
  );

  // ---- dashboard ----

  app.get('/summary', async () => apiSummary(await service.summary(), now()));

  // ---- demo seller ----

  /**
   * A SIMULATED seller, for the demo UI. It runs the same `verifyVerdict` a real seller would,
   * with the issuer's public keys and its own nonce store, so you can watch a replay get rejected.
   * Always 200: the answer is in `ok`. A real seller runs the verifier in its own process.
   */
  app.post('/demo/seller/verify', async (req) => {
    const { token, expected } = sellerBody.parse(req.body);
    const result = await verifyVerdict(token, expected, {
      keys: createLocalJWKSet(service.jwks()),
      issuer: service.issuer,
      nonces: sellerNonces,
      now: now(),
    });
    return result.ok ? { ok: true, claims: result.claims } : result;
  });

  return app;
}
