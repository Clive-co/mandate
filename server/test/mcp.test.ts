import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLocalJWKSet } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db';
import { KeyRing } from '../src/keys';
import { createMcpServer, type AuthorizeClient } from '../src/mcp';
import { parseUsdc as usdc } from '../src/units';
import { InMemoryNonceStore, verifyVerdict } from '../src/verifier';
import { ALICE, ISSUER, createMandate, makeEnv, openTestDb, type Env } from './helpers';

let db: Db;
let keys: KeyRing;
let env: Env;

beforeAll(async () => {
  db = await openTestDb();
  keys = await KeyRing.generate();
});
afterAll(() => db.close());
beforeEach(async () => {
  env = await makeEnv(db, keys);
  await createMandate(env);
});

/** Routes the tool's call through the real HTTP layer (Fastify inject) instead of the network. */
const viaApp = (): AuthorizeClient => ({
  async authorize(request) {
    const res = await env.app.inject({ method: 'POST', url: '/authorize', payload: request });
    if (res.statusCode !== 200) throw new Error(`Mandate API ${res.statusCode}: ${res.json().message}`);
    return res.json();
  },
});

async function connect(opts: { defaultAgentId?: string } = {}) {
  const server = createMcpServer(viaApp(), opts);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

/** `callTool` returns a union of result shapes; ours always has text content. */
const text = (r: unknown) => ((r as { content: Array<{ text: string }> }).content[0]!).text;

describe('request_spend MCP tool', () => {
  it('is discoverable with a description and input schema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['request_spend']);
    expect(tools[0]!.description).toContain('allow or deny');
    expect(Object.keys(tools[0]!.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['amount', 'recipient', 'category']),
    );
  });

  it('returns an allow with a signed verdict a seller can verify', async () => {
    const client = await connect();
    const r = await client.callTool({
      name: 'request_spend',
      arguments: { agentId: 'agent-1', amount: '12.5', recipient: ALICE, category: 'cloud' },
    });
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(text(r));
    expect(out).toMatchObject({ verdict: 'allow', reasonCode: null });

    const verified = await verifyVerdict(
      out.token,
      { amount: usdc('12.5'), currency: 'USDC', recipient: ALICE },
      { keys: createLocalJWKSet(env.service.jwks()), issuer: ISSUER, nonces: new InMemoryNonceStore(), now: env.clock.now },
    );
    expect(verified.ok).toBe(true);
  });

  it('returns a deny as a normal result (not a tool error), with the reason', async () => {
    const client = await connect();
    const r = await client.callTool({
      name: 'request_spend',
      arguments: { agentId: 'agent-1', amount: '75', recipient: ALICE, category: 'cloud' },
    });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(text(r))).toMatchObject({ verdict: 'deny', reasonCode: 'exceeds_per_tx_limit' });
  });

  it('uses the configured default agent when none is given', async () => {
    const client = await connect({ defaultAgentId: 'agent-1' });
    const r = await client.callTool({ name: 'request_spend', arguments: { amount: '1', recipient: ALICE, category: 'cloud' } });
    expect(JSON.parse(text(r)).verdict).toBe('allow');
  });

  it('reports a missing agent id as a tool error', async () => {
    const client = await connect();
    const r = await client.callTool({ name: 'request_spend', arguments: { amount: '1', recipient: ALICE, category: 'cloud' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('agentId is required');
  });

  it('surfaces API validation errors as a tool error', async () => {
    const client = await connect();
    const r = await client.callTool({
      name: 'request_spend',
      arguments: { agentId: 'agent-1', amount: '1.2345678', recipient: ALICE, category: 'cloud' },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('400');
  });

  it('records the call in the decision log like any other authorization', async () => {
    const client = await connect();
    await client.callTool({ name: 'request_spend', arguments: { agentId: 'agent-1', amount: '5', recipient: ALICE, category: 'cloud' } });
    const log = (await env.app.inject({ method: 'GET', url: '/decisions' })).json();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ verdict: 'allow', amount: '5000000' });
  });
});
