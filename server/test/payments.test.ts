import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db';
import { KeyRing } from '../src/keys';
import { parseUsdc as usdc } from '../src/units';
import {
  AGENT_WALLET,
  ALICE,
  BOB,
  MALLORY,
  TX_A,
  TX_B,
  TX_C,
  attach,
  authorize,
  createMandate,
  makeEnv,
  openTestDb,
  receipt,
  transferLog,
  type Env,
} from './helpers';

let db: Db;
let keys: KeyRing;
let env: Env;
let decisionId: string;

beforeAll(async () => {
  db = await openTestDb();
  keys = await KeyRing.generate();
});
afterAll(() => db.close());
beforeEach(async () => {
  env = await makeEnv(db, keys);
  await createMandate(env, { payerAddress: AGENT_WALLET });
  decisionId = (await authorize(env, '10')).body.id;
});

const pays = (to = ALICE, amount = '10', from = AGENT_WALLET) => receipt([transferLog({ from, to, amount: usdc(amount) })]);

describe('reconciling a payment against its verdict', () => {
  it('is matched when the transfer fits the verdict', async () => {
    env.chain.receipts.set(TX_A, pays());
    const res = await attach(env, decisionId, TX_A);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      status: 'matched',
      blockNumber: '123',
      actualAmount: '10000000',
      actualAmountUsdc: '10',
      explorerUrl: `https://sepolia.basescan.org/tx/${TX_A}`,
    });
  });

  it('is a mismatch when the amount differs', async () => {
    env.chain.receipts.set(TX_A, pays(ALICE, '11'));
    expect((await attach(env, decisionId, TX_A)).json()).toMatchObject({ status: 'mismatch', reason: 'wrong_amount' });
  });

  it('is a mismatch when the recipient differs', async () => {
    env.chain.receipts.set(TX_A, pays(BOB));
    expect((await attach(env, decisionId, TX_A)).json()).toMatchObject({ status: 'mismatch', reason: 'wrong_recipient' });
  });

  it("is a mismatch when the sender is not the mandate's payer wallet", async () => {
    env.chain.receipts.set(TX_A, pays(ALICE, '10', MALLORY));
    expect((await attach(env, decisionId, TX_A)).json()).toMatchObject({ status: 'mismatch', reason: 'wrong_sender' });
  });

  it('compares against the VERDICT, not the mandate as it is today', async () => {
    const mandate = (await env.app.inject({ method: 'GET', url: '/mandates?agentId=agent-1' })).json()[0];
    await env.app.inject({
      method: 'POST',
      url: `/mandates/${mandate.id}/replace`,
      payload: { perTxLimit: '5', dailyLimit: '5', categories: ['cloud'], allowedRecipients: [BOB], expiresAt: '2026-12-31T00:00:00Z' },
    });
    env.chain.receipts.set(TX_A, pays()); // pays ALICE 10, exactly what was authorized under v1
    expect((await attach(env, decisionId, TX_A)).json().status).toBe('matched');
  });

  it('is pending until the receipt exists, then matches on recheck', async () => {
    expect((await attach(env, decisionId, TX_A)).json().status).toBe('pending');
    env.chain.receipts.set(TX_A, pays());
    const again = await env.app.inject({ method: 'POST', url: `/decisions/${decisionId}/payment/recheck` });
    expect(again.json().status).toBe('matched');

    const detail = (await env.app.inject({ method: 'GET', url: `/decisions/${decisionId}` })).json();
    expect(detail.trail.map((e: { type: string }) => e.type)).toEqual([
      'authorization_requested',
      'verdict_issued',
      'reconciliation_pending',
      'reconciliation_matched',
    ]);
    expect(detail.decision.payment.status).toBe('matched');
  });

  it('keeps every attempt: a mismatch followed by the right transaction', async () => {
    env.chain.receipts.set(TX_A, pays(BOB));
    env.chain.receipts.set(TX_B, pays());
    expect((await attach(env, decisionId, TX_A)).json().status).toBe('mismatch');
    expect((await attach(env, decisionId, TX_B)).json().status).toBe('matched');
    const detail = (await env.app.inject({ method: 'GET', url: `/decisions/${decisionId}` })).json();
    expect(detail.reconciliations.map((r: { status: string }) => r.status)).toEqual(['mismatch', 'matched']);
  });

  it('refuses to change the transaction after a match', async () => {
    env.chain.receipts.set(TX_A, pays());
    await attach(env, decisionId, TX_A);
    const res = await attach(env, decisionId, TX_B);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('already_matched');
  });

  it('refuses to use one transaction to justify a second payment', async () => {
    const second = (await authorize(env, '10')).body.id;
    env.chain.receipts.set(TX_A, pays());
    expect((await attach(env, decisionId, TX_A)).statusCode).toBe(201);
    const res = await attach(env, second, TX_A);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('tx_already_used');
  });

  it('two concurrent attempts to match one transaction to two decisions: only one wins', async () => {
    const second = (await authorize(env, '10')).body.id;
    env.chain.receipts.set(TX_A, pays());
    const results = await Promise.all([attach(env, decisionId, TX_A), attach(env, second, TX_A)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const [row] = await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM reconciliations WHERE status = 'matched'`);
    expect(row!.n).toBe(1);
  });

  it('only allowed decisions can be reconciled', async () => {
    const denied = (await authorize(env, '75')).body.id;
    const res = await attach(env, denied, TX_A);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_allowed');
  });

  it('rejects malformed transaction hashes and unknown decisions', async () => {
    expect((await attach(env, decisionId, '0x1234')).statusCode).toBe(400);
    expect((await attach(env, '00000000-0000-4000-8000-000000000000', TX_A)).statusCode).toBe(404);
  });

  it('recheck needs an attached transaction', async () => {
    const res = await env.app.inject({ method: 'POST', url: `/decisions/${decisionId}/payment/recheck` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('no_payment');
  });

  it('reports RPC failures as 502 and records nothing', async () => {
    env.chain.getTransactionReceipt = async () => {
      throw new Error('rpc down');
    };
    const res = await attach(env, decisionId, TX_C);
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('rpc_error');
    expect(await db.query(`SELECT 1 FROM reconciliations`)).toHaveLength(0);
  });

  it('still reconciles after the verdict itself has expired (the chain does not care)', async () => {
    env.clock.now = new Date(env.clock.now.getTime() + 60 * 60_000);
    env.chain.receipts.set(TX_A, pays());
    expect((await attach(env, decisionId, TX_A)).json().status).toBe('matched');
  });
});

describe('GET /summary', () => {
  it('reports spend, outcomes and onchain status per agent', async () => {
    const paid = (await authorize(env, '20')).body.id;
    await authorize(env, '75'); // denied
    env.chain.receipts.set(TX_A, pays(ALICE, '20'));
    await attach(env, paid, TX_A);
    const wrong = (await authorize(env, '5')).body.id;
    env.chain.receipts.set(TX_B, pays(BOB, '5'));
    await attach(env, wrong, TX_B);

    const s = (await env.app.inject({ method: 'GET', url: '/summary' })).json();
    expect(s.totals).toMatchObject({
      allowedTodayUsdc: '35', // 10 + 20 + 5
      matchedUsdc: '20',
      allowCount: 3,
      denyCount: 1,
      mismatchCount: 1,
      awaitingPaymentCount: 1, // the first 10
    });
    expect(s.agents[0]).toMatchObject({
      agentId: 'agent-1',
      remainingTodayUsdc: '65',
      matchedCount: 1,
      mandate: { version: 1, status: 'active' },
    });
  });

  it('shows no remaining budget for an agent whose mandate is revoked', async () => {
    const m = (await env.app.inject({ method: 'GET', url: '/mandates?agentId=agent-1' })).json()[0];
    await env.app.inject({ method: 'POST', url: `/mandates/${m.id}/revoke`, payload: { reason: 'x' } });
    const s = (await env.app.inject({ method: 'GET', url: '/summary' })).json();
    expect(s.agents[0]).toMatchObject({ remainingTodayUsdc: '0', mandate: { status: 'revoked' } });
  });
});
