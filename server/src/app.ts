import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { isAddress, isHash } from 'viem';
import { z, ZodError } from 'zod';
import {
  apiAgentSummary,
  apiDecision,
  apiDetail,
  apiMandate,
  apiPayment,
  apiRequest,
} from './serialize';
import { AppError, MandateService, normalizeAddress } from './service';
import { DECISION_DOMAIN, DECISION_TYPES, fromWire, verifyDecision } from './signing';
import { parseUsdc, formatUsdc } from './units';
import type { Hash, Hex } from 'viem';

const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), 'must be a valid 0x address')
  .transform((v) => normalizeAddress(v.toLowerCase()));

const usdcAmount = z
  .string()
  .transform((v, ctx) => {
    try {
      return parseUsdc(v);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: (e as Error).message });
      return z.NEVER;
    }
  });

const agentId = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_.-]+$/, 'letters, digits, _ . - only');

const submitBody = z.object({
  agentId,
  recipient: address,
  amount: usdcAmount,
  memo: z.string().max(280).optional(),
});

const mandateBody = z.object({
  name: z.string().min(1).max(80),
  perPaymentLimit: usdcAmount,
  dailyLimit: usdcAmount,
  approvalThreshold: usdcAmount.nullable().default(null),
  allowedRecipients: z.array(address).max(200).default([]),
  walletAddress: address.nullable().default(null),
  active: z.boolean().default(true),
});

const resolveBody = z.object({
  action: z.enum(['approve', 'reject']),
  actor: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-zA-Z0-9_. @-]+$/, 'letters, digits, space and _ . @ - only')
    .default('reviewer'),
});

const txBody = z.object({
  txHash: z.string().refine((v) => isHash(v), 'must be a 0x-prefixed 32-byte transaction hash'),
});

const verifyBody = z.object({
  message: z.object({
    requestId: z.string(),
    agentId: z.string(),
    token: address,
    recipient: address,
    amount: z.string(),
    outcome: z.enum(['approved', 'denied', 'needs_approval']),
    decidedBy: z.string(),
    issuedAt: z.string(),
  }),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'must be hex'),
});

const listQuery = z.object({
  status: z.enum(['approved', 'denied', 'needs_approval']).optional(),
  agentId: z.string().optional(),
});

export interface AppOptions {
  corsOrigin?: string | boolean;
  logger?: boolean;
}

export function buildApp(service: MandateService, opts: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });

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

  /** Public info a receiving system needs to verify our decisions offline. */
  app.get('/signer', async () => ({
    address: service.signerAddress,
    domain: DECISION_DOMAIN,
    types: DECISION_TYPES,
    primaryType: 'Decision',
  }));

  // ---- mandates ----

  app.get('/summary', async () => {
    const agents = service.agentSummaries().map(apiAgentSummary);
    const sum = (f: (a: (typeof agents)[number]) => string) =>
      formatUsdc(agents.reduce((acc, a) => acc + parseUsdc(f(a)), 0n));
    return {
      totals: {
        pendingApprovals: agents.reduce((n, a) => n + a.pendingApprovals, 0),
        spentTodayUsdc: sum((a) => a.spentTodayUsdc),
        confirmedOnchainUsdc: sum((a) => a.confirmedOnchainUsdc),
        mismatches: agents.reduce((n, a) => n + a.mismatches, 0),
        pendingPayments: agents.reduce((n, a) => n + a.pendingPayments, 0),
      },
      agents,
    };
  });

  app.put<{ Params: { agentId: string } }>('/mandates/:agentId', async (req) => {
    const id = agentId.parse(req.params.agentId);
    const body = mandateBody.parse(req.body);
    if (body.perPaymentLimit > body.dailyLimit) {
      throw new AppError(400, 'invalid_mandate', 'perPaymentLimit cannot exceed dailyLimit');
    }
    return apiMandate(service.upsertMandate({ agentId: id, ...body }));
  });

  // ---- requests ----

  app.post('/requests', async (req, reply) => {
    const body = submitBody.parse(req.body);
    const { request, decision } = await service.submitRequest({ ...body, memo: body.memo ?? null });
    return reply.status(201).send({
      request: apiRequest(request),
      decision: apiDecision(decision),
    });
  });

  app.get('/requests', async (req) => {
    const q = listQuery.parse(req.query);
    return service.listRequests(q).map(({ request, payment }) => apiRequest(request, payment));
  });

  app.get<{ Params: { id: string } }>('/requests/:id', async (req) => apiDetail(service.getRequestDetail(req.params.id)));

  app.post<{ Params: { id: string } }>('/requests/:id/resolve', async (req) => {
    const body = resolveBody.parse(req.body);
    const { request, decision } = await service.resolveRequest(req.params.id, body.action, body.actor);
    return { request: apiRequest(request), decision: apiDecision(decision) };
  });

  app.get('/decisions', async () => service.recentDecisions().map(apiDecision));

  // ---- onchain tracing ----

  app.post<{ Params: { id: string } }>('/requests/:id/payment', async (req, reply) => {
    const body = txBody.parse(req.body);
    const payment = await service.attachPayment(req.params.id, body.txHash as Hash);
    return reply.status(201).send(apiPayment(payment));
  });

  app.post<{ Params: { id: string } }>('/requests/:id/payment/recheck', async (req) =>
    apiPayment(await service.recheckPayment(req.params.id)),
  );

  // ---- verification ----

  /**
   * Check that a decision was really signed by this server and hasn't been altered.
   * Always 200: the answer is in `valid`.
   */
  app.post('/verify', async (req) => {
    const body = verifyBody.parse(req.body);
    let message;
    try {
      message = fromWire(body.message);
    } catch (e) {
      return { valid: false, signer: service.signerAddress, reason: (e as Error).message };
    }
    const valid = await verifyDecision(message, body.signature as Hex, service.signerAddress);
    return { valid, signer: service.signerAddress };
  });

  return app;
}
