import {
  TransactionReceiptNotFoundError,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type TransactionReceipt,
} from 'viem';
import { buildApp } from '../src/app';
import { connectPg, connectPglite, migrate, type Db } from '../src/db';
import { KeyRing } from '../src/keys';
import type { ReceiptClient } from '../src/reconcile';
import { MandateService } from '../src/service';

export const ISSUER = 'https://mandate.test';
export const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;
export const CHAIN_ID = 84532;

export const AGENT_WALLET = '0x1111111111111111111111111111111111111111' as Address;
export const ALICE = '0x2222222222222222222222222222222222222222' as Address;
export const BOB = '0x3333333333333333333333333333333333333333' as Address;
export const MALLORY = '0x4444444444444444444444444444444444444444' as Address;
export const FAKE_TOKEN = '0x5555555555555555555555555555555555555555' as Address;

export const TX_A = `0x${'a'.repeat(64)}` as Hash;
export const TX_B = `0x${'b'.repeat(64)}` as Hash;
export const TX_C = `0x${'c'.repeat(64)}` as Hash;

// ---------------------------------------------------------------- database

/** Real Postgres when TEST_DATABASE_URL is set (CI), otherwise in-process PGlite. */
export function openTestDb(): Promise<Db> | Db {
  const url = process.env.TEST_DATABASE_URL;
  return url ? connectPg(url) : connectPglite();
}

export async function resetDb(db: Db): Promise<void> {
  await db.exec('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrate(db);
}

// ---------------------------------------------------------------- chain

export class FakeChain implements ReceiptClient {
  receipts = new Map<string, TransactionReceipt>();
  async getTransactionReceipt({ hash }: { hash: Hash }) {
    const r = this.receipts.get(hash.toLowerCase());
    if (!r) throw new TransactionReceiptNotFoundError({ hash });
    return r;
  }
}

/** Build an ERC-20 Transfer log exactly as the chain would emit it. */
export function transferLog(args: { token?: Address; from: Address; to: Address; amount: bigint; logIndex?: number }): Log {
  return {
    address: args.token ?? USDC,
    topics: encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from: args.from, to: args.to } }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: 'uint256' }], [args.amount]),
    blockHash: `0x${'d'.repeat(64)}` as Hash,
    blockNumber: 123n,
    logIndex: args.logIndex ?? 0,
    transactionHash: TX_A,
    transactionIndex: 0,
    removed: false,
  };
}

export function receipt(logs: Log[], status: 'success' | 'reverted' = 'success'): TransactionReceipt {
  return {
    status,
    logs,
    blockNumber: 123n,
    blockHash: `0x${'d'.repeat(64)}` as Hash,
    transactionHash: TX_A,
    transactionIndex: 0,
    from: AGENT_WALLET,
    to: USDC,
    contractAddress: null,
    cumulativeGasUsed: 21000n,
    gasUsed: 21000n,
    effectiveGasPrice: 1n,
    logsBloom: '0x' as Hex,
    type: 'eip1559',
  } as TransactionReceipt;
}

// ---------------------------------------------------------------- app under test

export interface Env {
  db: Db;
  keys: KeyRing;
  chain: FakeChain;
  clock: { now: Date };
  service: MandateService;
  app: ReturnType<typeof buildApp>;
}

export async function makeEnv(db: Db, keys: KeyRing): Promise<Env> {
  await resetDb(db);
  const chain = new FakeChain();
  const clock = { now: new Date('2026-10-27T10:00:00Z') };
  const now = () => clock.now;
  const service = new MandateService({ db, keys, chain, token: USDC, chainId: CHAIN_ID, issuer: ISSUER, now });
  return { db, keys, chain, clock, service, app: buildApp(service, { now }) };
}

// ---------------------------------------------------------------- request helpers

export const mandateBody = (over: Record<string, unknown> = {}) => ({
  agentId: 'agent-1',
  perTxLimit: '50',
  dailyLimit: '100',
  categories: ['cloud', 'data'],
  allowedRecipients: [ALICE],
  payerAddress: null,
  expiresAt: '2026-12-31T00:00:00Z',
  ...over,
});

export async function createMandate(env: Env, over: Record<string, unknown> = {}) {
  const res = await env.app.inject({ method: 'POST', url: '/mandates', payload: mandateBody(over) });
  return { res, body: res.json() };
}

export async function authorize(
  env: Env,
  amount: string,
  over: { recipient?: string; category?: string; agentId?: string; currency?: string } = {},
) {
  const res = await env.app.inject({
    method: 'POST',
    url: '/authorize',
    payload: { agentId: 'agent-1', amount, currency: 'USDC', recipient: ALICE, category: 'cloud', ...over },
  });
  return { res, body: res.json() };
}

export const attach = (env: Env, decisionId: string, txHash: string) =>
  env.app.inject({ method: 'POST', url: `/decisions/${decisionId}/payment`, payload: { txHash } });
