import { TransactionReceiptNotFoundError, type Hash, type TransactionReceipt } from 'viem';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { openDb } from '../src/db';
import { MandateService } from '../src/service';
import { DecisionSigner } from '../src/signing';
import { Store } from '../src/store';
import type { ReceiptClient } from '../src/tracing';
import { parseUsdc as usdc } from '../src/units';
import { AGENT_WALLET, ALICE, BOB, MALLORY, TEST_SIGNER_KEY, TX_A, TX_B, USDC, receipt, transferLog } from './fixtures';

class FakeChain implements ReceiptClient {
  receipts = new Map<string, TransactionReceipt>();
  async getTransactionReceipt({ hash }: { hash: Hash }) {
    const r = this.receipts.get(hash.toLowerCase());
    if (!r) throw new TransactionReceiptNotFoundError({ hash });
    return r;
  }
}

const TX_C = `0x${'c'.repeat(64)}` as Hash;

function setup() {
  const chain = new FakeChain();
  const clock = { now: new Date('2026-10-27T10:00:00Z') };
  const service = new MandateService({
    store: new Store(openDb(':memory:')),
    signer: new DecisionSigner(TEST_SIGNER_KEY),
    chain,
    token: USDC,
    now: () => clock.now,
  });
  const app = buildApp(service);
  return { app, chain, clock, service };
}

type Ctx = ReturnType<typeof setup>;

const mandateBody = (over: Record<string, unknown> = {}) => ({
  name: 'Test agent',
  perPaymentLimit: '50',
  dailyLimit: '100',
  approvalThreshold: null,
  allowedRecipients: [ALICE],
  walletAddress: null,
  active: true,
  ...over,
});

async function putMandate(ctx: Ctx, over: Record<string, unknown> = {}, agentId = 'agent-1') {
  const res = await ctx.app.inject({ method: 'PUT', url: `/mandates/${agentId}`, payload: mandateBody(over) });
  expect(res.statusCode).toBe(200);
}

async function submit(ctx: Ctx, amount: string, recipient: string = ALICE, agentId = 'agent-1') {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/requests',
    payload: { agentId, recipient, amount, memo: 'test' },
  });
  return { res, body: res.json() };
}

const resolve = (ctx: Ctx, id: string, action: 'approve' | 'reject') =>
  ctx.app.inject({ method: 'POST', url: `/requests/${id}/resolve`, payload: { action, actor: 'dana' } });

const attach = (ctx: Ctx, id: string, txHash: string) =>
  ctx.app.inject({ method: 'POST', url: `/requests/${id}/payment`, payload: { txHash } });

describe('submitting requests', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = setup();
    await putMandate(ctx);
  });

  it('approves an in-policy request and returns a decision that verifies', async () => {
    const { res, body } = await submit(ctx, '10');
    expect(res.statusCode).toBe(201);
    expect(body.request.status).toBe('approved');
    expect(body.decision.outcome).toBe('approved');
    expect(body.decision.decidedBy).toBe('policy');

    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/verify',
      payload: { message: body.decision.message, signature: body.decision.signature },
    });
    expect(verify.json()).toMatchObject({ valid: true });
  });

  it('/verify rejects a decision that was tampered with', async () => {
    const { body } = await submit(ctx, '10');
    const tampered = { ...body.decision.message, amount: '99000000' };
    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/verify',
      payload: { message: tampered, signature: body.decision.signature },
    });
    expect(verify.json().valid).toBe(false);
  });

  it('/verify rejects flipping a denied decision to approved', async () => {
    const { body } = await submit(ctx, '75'); // over per-payment limit -> denied
    expect(body.decision.outcome).toBe('denied');
    const forged = { ...body.decision.message, outcome: 'approved' };
    const verify = await ctx.app.inject({
      method: 'POST',
      url: '/verify',
      payload: { message: forged, signature: body.decision.signature },
    });
    expect(verify.json().valid).toBe(false);
  });

  it('denies and explains an over-limit request', async () => {
    const { body } = await submit(ctx, '75');
    expect(body.request.status).toBe('denied');
    expect(body.decision.reasons[0].code).toBe('exceeds_per_payment_limit');
  });

  it('queues a request to a non-allowlisted recipient', async () => {
    const { body } = await submit(ctx, '10', BOB);
    expect(body.request.status).toBe('needs_approval');
    expect(body.request.decidedAt).toBeNull();
  });

  it('records a request from an unknown agent as denied (no_mandate)', async () => {
    const { res, body } = await submit(ctx, '1', ALICE, 'ghost');
    expect(res.statusCode).toBe(201);
    expect(body.request.status).toBe('denied');
    expect(body.decision.reasons[0].code).toBe('no_mandate');
  });

  it('accumulates spend: two 50s fill the 100 daily limit, the next is denied', async () => {
    expect((await submit(ctx, '50')).body.request.status).toBe('approved');
    expect((await submit(ctx, '50')).body.request.status).toBe('approved');
    const third = await submit(ctx, '1');
    expect(third.body.request.status).toBe('denied');
    expect(third.body.decision.reasons[0].code).toBe('exceeds_daily_limit');
  });

  it('does not count denied or queued requests toward the daily limit', async () => {
    await submit(ctx, '75'); // denied
    await submit(ctx, '40', BOB); // queued
    expect((await submit(ctx, '50')).body.request.status).toBe('approved');
    expect((await submit(ctx, '50')).body.request.status).toBe('approved');
  });

  it('resets the daily budget at the next UTC day', async () => {
    await submit(ctx, '50');
    await submit(ctx, '50');
    expect((await submit(ctx, '10')).body.request.status).toBe('denied');
    ctx.clock.now = new Date('2026-10-28T00:00:01Z');
    expect((await submit(ctx, '10')).body.request.status).toBe('approved');
  });

  it('cannot be raced past the daily limit by concurrent requests', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => submit(ctx, '30')));
    const statuses = results.map((r) => r.body.request.status as string);
    expect(statuses.filter((s) => s === 'approved')).toHaveLength(3); // 3 x 30 = 90 <= 100
    expect(statuses.filter((s) => s === 'denied')).toHaveLength(3);
  });

  it('validates input', async () => {
    const bad = [
      { agentId: 'agent-1', recipient: ALICE, amount: '1.2345678' }, // 7 decimals
      { agentId: 'agent-1', recipient: ALICE, amount: '-5' },
      { agentId: 'agent-1', recipient: ALICE, amount: 'abc' },
      { agentId: 'agent-1', recipient: '0x123', amount: '1' },
      { agentId: '', recipient: ALICE, amount: '1' },
    ];
    for (const payload of bad) {
      const res = await ctx.app.inject({ method: 'POST', url: '/requests', payload });
      expect(res.statusCode, JSON.stringify(payload)).toBe(400);
    }
  });
});

describe('human approvals', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = setup();
    await putMandate(ctx);
  });

  it('approving a queued request issues a second, human-signed decision', async () => {
    const queued = (await submit(ctx, '10', BOB)).body.request;
    const res = await resolve(ctx, queued.id, 'approve');
    expect(res.statusCode).toBe(200);
    expect(res.json().request.status).toBe('approved');
    expect(res.json().decision.decidedBy).toBe('human:dana');

    const detail = (await ctx.app.inject({ method: 'GET', url: `/requests/${queued.id}` })).json();
    expect(detail.decisions.map((d: { decidedBy: string; outcome: string }) => `${d.decidedBy}:${d.outcome}`)).toEqual([
      'policy:needs_approval',
      'human:dana:approved',
    ]);
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual([
      'request_submitted',
      'decision_signed',
      'human_resolved',
      'decision_signed',
    ]);
  });

  it('rejecting turns the request into denied', async () => {
    const queued = (await submit(ctx, '10', BOB)).body.request;
    const res = await resolve(ctx, queued.id, 'reject');
    expect(res.json().request.status).toBe('denied');
    expect(res.json().decision.reasons[0].code).toBe('rejected_by_human');
  });

  it('a request can only be resolved once', async () => {
    const queued = (await submit(ctx, '10', BOB)).body.request;
    await resolve(ctx, queued.id, 'approve');
    const again = await resolve(ctx, queued.id, 'reject');
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('not_pending');
  });

  it('cannot resolve something that was auto-approved or does not exist', async () => {
    const approved = (await submit(ctx, '10')).body.request;
    expect((await resolve(ctx, approved.id, 'approve')).statusCode).toBe(409);
    expect((await resolve(ctx, 'nope', 'approve')).statusCode).toBe(404);
  });

  it('a human cannot approve past the daily limit', async () => {
    const queued = (await submit(ctx, '40', BOB)).body.request; // queued: unknown recipient
    await submit(ctx, '50'); // approved
    await submit(ctx, '45'); // approved -> 95 spent
    const res = await resolve(ctx, queued.id, 'approve'); // 95 + 40 > 100
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('hard_rule_violation');
    expect(res.json().details[0].code).toBe('exceeds_daily_limit');
    // ...and it stays in the queue so the human can reject it
    expect((await resolve(ctx, queued.id, 'reject')).statusCode).toBe(200);
  });

  it('human-approved spend counts toward the daily limit', async () => {
    const queued = (await submit(ctx, '50', BOB)).body.request;
    await resolve(ctx, queued.id, 'approve');
    await submit(ctx, '50');
    expect((await submit(ctx, '1')).body.request.status).toBe('denied');
  });

  it('lists the queue by status', async () => {
    await submit(ctx, '10', BOB);
    await submit(ctx, '10');
    const res = await ctx.app.inject({ method: 'GET', url: '/requests?status=needs_approval' });
    expect(res.json()).toHaveLength(1);
  });
});

describe('onchain tracing', () => {
  let ctx: Ctx;
  let requestId: string;
  beforeEach(async () => {
    ctx = setup();
    await putMandate(ctx, { walletAddress: AGENT_WALLET });
    requestId = (await submit(ctx, '10')).body.request.id;
  });

  it('confirms a payment that matches the approval', async () => {
    ctx.chain.receipts.set(TX_A, receipt([transferLog({ from: AGENT_WALLET, to: ALICE, amount: usdc('10') })]));
    const res = await attach(ctx, requestId, TX_A);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'confirmed',
      blockNumber: '123',
      explorerUrl: `https://sepolia.basescan.org/tx/${TX_A}`,
    });
  });

  it('flags a mismatch when the amount differs', async () => {
    ctx.chain.receipts.set(TX_A, receipt([transferLog({ from: AGENT_WALLET, to: ALICE, amount: usdc('11') })]));
    const res = await attach(ctx, requestId, TX_A);
    expect(res.json()).toMatchObject({ status: 'mismatch', reason: 'wrong_amount' });
  });

  it('flags a mismatch when the transfer came from a different wallet than the mandate says', async () => {
    ctx.chain.receipts.set(TX_A, receipt([transferLog({ from: MALLORY, to: ALICE, amount: usdc('10') })]));
    const res = await attach(ctx, requestId, TX_A);
    expect(res.json()).toMatchObject({ status: 'mismatch', reason: 'wrong_sender' });
  });

  it('stays pending until the receipt exists, then confirms on recheck', async () => {
    const first = await attach(ctx, requestId, TX_A);
    expect(first.json().status).toBe('pending');

    ctx.chain.receipts.set(TX_A, receipt([transferLog({ from: AGENT_WALLET, to: ALICE, amount: usdc('10') })]));
    const again = await ctx.app.inject({ method: 'POST', url: `/requests/${requestId}/payment/recheck` });
    expect(again.json().status).toBe('confirmed');

    const detail = (await ctx.app.inject({ method: 'GET', url: `/requests/${requestId}` })).json();
    expect(detail.request.payment.status).toBe('confirmed');
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual([
      'request_submitted',
      'decision_signed',
      'payment_submitted',
      'payment_pending',
      'payment_confirmed',
    ]);
  });

  it('lets you replace a mismatched transaction with the correct one', async () => {
    ctx.chain.receipts.set(TX_A, receipt([transferLog({ from: AGENT_WALLET, to: BOB, amount: usdc('10') })]));
    ctx.chain.receipts.set(TX_B, receipt([transferLog({ from: AGENT_WALLET, to: ALICE, amount: usdc('10') })]));
    expect((await attach(ctx, requestId, TX_A)).json().status).toBe('mismatch');
    expect((await attach(ctx, requestId, TX_B)).json().status).toBe('confirmed');
  });

  it('does not allow changing the transaction after a confirmed payment', async () => {
    ctx.chain.receipts.set(TX_A, receipt([transferLog({ from: AGENT_WALLET, to: ALICE, amount: usdc('10') })]));
    await attach(ctx, requestId, TX_A);
    const res = await attach(ctx, requestId, TX_B);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('already_confirmed');
  });

  it('refuses to reuse one transaction to "pay" a second request', async () => {
    const second = (await submit(ctx, '10')).body.request.id;
    ctx.chain.receipts.set(TX_A, receipt([transferLog({ from: AGENT_WALLET, to: ALICE, amount: usdc('10') })]));
    expect((await attach(ctx, requestId, TX_A)).statusCode).toBe(201);
    const res = await attach(ctx, second, TX_A);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('tx_already_used');
  });

  it('only approved requests can be paid', async () => {
    const queued = (await submit(ctx, '10', BOB)).body.request.id;
    const denied = (await submit(ctx, '75')).body.request.id;
    expect((await attach(ctx, queued, TX_A)).json().error).toBe('not_approved');
    expect((await attach(ctx, denied, TX_B)).json().error).toBe('not_approved');
  });

  it('rejects malformed transaction hashes', async () => {
    expect((await attach(ctx, requestId, '0x1234')).statusCode).toBe(400);
  });

  it('reports RPC failures as 502, not as a verdict on the payment', async () => {
    ctx.chain.getTransactionReceipt = async () => {
      throw new Error('rpc down');
    };
    const res = await attach(ctx, requestId, TX_C);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('rpc_error');
    // and nothing was recorded
    const detail = (await ctx.app.inject({ method: 'GET', url: `/requests/${requestId}` })).json();
    expect(detail.request.payment).toBeNull();
  });
});

describe('summary and signer info', () => {
  it('summarises spend, queue depth and onchain status per agent', async () => {
    const ctx = setup();
    await putMandate(ctx, { walletAddress: AGENT_WALLET });
    const paid = (await submit(ctx, '20')).body.request.id;
    await submit(ctx, '10', BOB); // queued
    await submit(ctx, '75'); // denied
    ctx.chain.receipts.set(TX_A, receipt([transferLog({ from: AGENT_WALLET, to: ALICE, amount: usdc('20') })]));
    await attach(ctx, paid, TX_A);

    const summary = (await ctx.app.inject({ method: 'GET', url: '/summary' })).json();
    expect(summary.totals).toMatchObject({
      pendingApprovals: 1,
      spentTodayUsdc: '20',
      confirmedOnchainUsdc: '20',
      mismatches: 0,
    });
    expect(summary.agents[0]).toMatchObject({
      agentId: 'agent-1',
      remainingTodayUsdc: '80',
      requestCounts: { approved: 1, denied: 1, needs_approval: 1 },
    });
  });

  it('publishes the signer address and typed-data definition for offline verification', async () => {
    const ctx = setup();
    const res = (await ctx.app.inject({ method: 'GET', url: '/signer' })).json();
    expect(res.address).toBe(ctx.service.signerAddress);
    expect(res.primaryType).toBe('Decision');
    expect(res.domain.chainId).toBe(84532);
  });

  it('rejects a mandate whose per-payment limit exceeds its daily limit', async () => {
    const ctx = setup();
    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/mandates/a',
      payload: mandateBody({ perPaymentLimit: '200', dailyLimit: '100' }),
    });
    expect(res.statusCode).toBe(400);
  });
});
