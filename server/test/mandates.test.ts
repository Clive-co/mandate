import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db';
import { KeyRing } from '../src/keys';
import { ALICE, BOB, authorize, createMandate, makeEnv, mandateBody, openTestDb, type Env } from './helpers';

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
});

const replace = (id: string, over: Record<string, unknown> = {}) =>
  env.app.inject({ method: 'POST', url: `/mandates/${id}/replace`, payload: { ...mandateBody(over), agentId: undefined, reason: 'raise limit' } });
const revoke = (id: string, reason = 'compromised') =>
  env.app.inject({ method: 'POST', url: `/mandates/${id}/revoke`, payload: { reason } });

describe('immutability, enforced by the database', () => {
  it('rejects UPDATE and DELETE on a mandate, even by raw SQL', async () => {
    const { body } = await createMandate(env);
    await expect(db.query(`UPDATE mandates SET per_tx_limit = 999999999 WHERE id = $1`, [body.id])).rejects.toThrow('append-only');
    await expect(db.query(`DELETE FROM mandates WHERE id = $1`, [body.id])).rejects.toThrow('append-only');
    const [row] = await db.query<{ p: string }>(`SELECT per_tx_limit::text p FROM mandates WHERE id = $1`, [body.id]);
    expect(row!.p).toBe('50000000'); // unchanged
  });

  it('rejects UPDATE, DELETE and TRUNCATE on revocations', async () => {
    const { body } = await createMandate(env);
    await revoke(body.id);
    await expect(db.query(`UPDATE mandate_revocations SET reason = 'x'`)).rejects.toThrow('append-only');
    await expect(db.query(`DELETE FROM mandate_revocations`)).rejects.toThrow('append-only');
    await expect(db.query(`TRUNCATE mandate_revocations`)).rejects.toThrow('append-only');
  });

  it('rejects UPDATE, DELETE and TRUNCATE on the decision log', async () => {
    await createMandate(env);
    const { body } = await authorize(env, '10');
    await expect(db.query(`UPDATE decision_log SET verdict = 'deny' WHERE id = $1`, [body.id])).rejects.toThrow('append-only');
    await expect(db.query(`UPDATE decision_log SET amount = 1`)).rejects.toThrow('append-only');
    await expect(db.query(`DELETE FROM decision_log`)).rejects.toThrow('append-only');
    await expect(db.query(`TRUNCATE decision_log CASCADE`)).rejects.toThrow('append-only');
    expect(await db.query(`SELECT 1 FROM decision_log WHERE id = $1`, [body.id])).toHaveLength(1);
  });

  it('rejects UPDATE and DELETE on reconciliation attempts', async () => {
    await createMandate(env);
    const { body } = await authorize(env, '10');
    await db.query(
      `INSERT INTO reconciliations (decision_id, tx_hash, status, created_at) VALUES ($1, $2, 'pending', now())`,
      [body.id, `0x${'e'.repeat(64)}`],
    );
    await expect(db.query(`UPDATE reconciliations SET status = 'matched'`)).rejects.toThrow('append-only');
    await expect(db.query(`DELETE FROM reconciliations`)).rejects.toThrow('append-only');
  });

  it('the schema script is idempotent (running it again keeps data and triggers)', async () => {
    await createMandate(env);
    const { migrate } = await import('../src/db');
    await migrate(db);
    await migrate(db);
    expect(await db.query(`SELECT 1 FROM mandates`)).toHaveLength(1);
    await expect(db.query(`DELETE FROM mandates`)).rejects.toThrow('append-only');
  });
});

describe('creating mandates', () => {
  it('creates version 1', async () => {
    const { res, body } = await createMandate(env);
    expect(res.statusCode).toBe(201);
    expect(body).toMatchObject({ agentId: 'agent-1', version: 1, status: 'active', perTxLimitUsdc: '50', dailyLimitUsdc: '100', categories: ['cloud', 'data'] });
  });

  it('refuses a second mandate while one is active (use replace)', async () => {
    await createMandate(env);
    const { res, body } = await createMandate(env);
    expect(res.statusCode).toBe(409);
    expect(body.error).toBe('mandate_exists');
  });

  it('lowercases and de-duplicates nothing silently: categories are normalised to lowercase', async () => {
    const { body } = await createMandate(env, { categories: ['Cloud', ' DATA '] });
    expect(body.categories).toEqual(['cloud', 'data']);
  });

  it('allows a brand-new mandate after the last one was revoked', async () => {
    const first = (await createMandate(env)).body;
    await revoke(first.id);
    const { res, body } = await createMandate(env);
    expect(res.statusCode).toBe(201);
    expect(body.version).toBe(2);
  });

  it('allows a brand-new mandate after the last one expired', async () => {
    await createMandate(env);
    env.clock.now = new Date('2027-01-02T00:00:00Z');
    const { res, body } = await createMandate(env, { expiresAt: '2027-06-01T00:00:00Z' });
    expect(res.statusCode).toBe(201);
    expect(body.version).toBe(2);
  });

  it.each([
    ['perTxLimit above dailyLimit', { perTxLimit: '200' }],
    ['an expiry in the past', { expiresAt: '2020-01-01T00:00:00Z' }],
    ['no categories', { categories: [] }],
    ['an empty recipient list (use null for "anyone")', { allowedRecipients: [] }],
    ['a bad recipient address', { allowedRecipients: ['0x123'] }],
    ['a 7-decimal amount', { perTxLimit: '1.1234567' }],
    ['a non-USDC currency', { currency: 'EURC' }],
    ['a bad agent id', { agentId: 'has spaces' }],
  ])('rejects %s', async (_n, over) => {
    expect((await createMandate(env, over)).res.statusCode).toBe(400);
  });
});

describe('revoke-and-replace', () => {
  it('replace creates the next version and revokes the old one, pointing at it', async () => {
    const v1 = (await createMandate(env)).body;
    const res = await replace(v1.id, { perTxLimit: '80', dailyLimit: '200' });
    expect(res.statusCode).toBe(201);
    const v2 = res.json();
    expect(v2).toMatchObject({ version: 2, status: 'active', perTxLimitUsdc: '80', dailyLimitUsdc: '200' });

    const all = (await env.app.inject({ method: 'GET', url: '/mandates?agentId=agent-1' })).json();
    expect(all.map((m: { version: number; status: string }) => `v${m.version}:${m.status}`)).toEqual(['v2:active', 'v1:replaced']);
    const old = all.find((m: { version: number }) => m.version === 1);
    expect(old).toMatchObject({ replacedBy: v2.id, revokeReason: 'raise limit' });
    expect(old.perTxLimitUsdc).toBe('50'); // the old record is untouched
  });

  it('the new mandate takes effect immediately and the old terms stop applying', async () => {
    const v1 = (await createMandate(env)).body;
    expect((await authorize(env, '40')).body.verdict).toBe('allow');
    await replace(v1.id, { perTxLimit: '5' });
    const d = (await authorize(env, '10')).body;
    expect(d).toMatchObject({ verdict: 'deny', reasonCode: 'exceeds_per_tx_limit', mandateVersion: 2 });
  });

  it('the daily budget carries over when a mandate is replaced', async () => {
    const v1 = (await createMandate(env)).body;
    await authorize(env, '50'); // 50 of 100 used under v1
    await replace(v1.id, { dailyLimit: '100' });
    expect((await authorize(env, '50')).body.verdict).toBe('allow'); // 100 of 100
    expect((await authorize(env, '1')).body.reasonCode).toBe('exceeds_daily_limit');
  });

  it('past decisions keep pointing at the mandate version that decided them', async () => {
    const v1 = (await createMandate(env)).body;
    const before = (await authorize(env, '10')).body;
    await replace(v1.id);
    const after = (await authorize(env, '10')).body;
    expect(before).toMatchObject({ mandateId: v1.id, mandateVersion: 1 });
    expect(after.mandateVersion).toBe(2);
    const detail = (await env.app.inject({ method: 'GET', url: `/decisions/${before.id}` })).json();
    expect(detail.mandate).toMatchObject({ id: v1.id, status: 'replaced', perTxLimitUsdc: '50' });
  });

  it('cannot replace or revoke a mandate twice', async () => {
    const v1 = (await createMandate(env)).body;
    await replace(v1.id);
    expect((await replace(v1.id)).json().error).toBe('already_revoked');
    expect((await revoke(v1.id)).json().error).toBe('already_revoked');
  });

  it('only one of two concurrent replaces of the same mandate wins', async () => {
    const v1 = (await createMandate(env)).body;
    const results = await Promise.all([replace(v1.id, { perTxLimit: '10' }), replace(v1.id, { perTxLimit: '20' })]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const all = (await env.app.inject({ method: 'GET', url: '/mandates?agentId=agent-1' })).json();
    expect(all).toHaveLength(2); // exactly one new version, no orphans
    expect(all.filter((m: { status: string }) => m.status === 'active')).toHaveLength(1);
  });

  it('rejects replacing with invalid terms, leaving the old mandate active', async () => {
    const v1 = (await createMandate(env)).body;
    expect((await replace(v1.id, { perTxLimit: '999' })).statusCode).toBe(400);
    expect((await env.app.inject({ method: 'GET', url: `/mandates/${v1.id}` })).json().status).toBe('active');
  });

  it('404s for an unknown mandate', async () => {
    expect((await replace('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await revoke('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
});

describe('revoke without replacement', () => {
  it('denies the agent with mandate_revoked, and records why', async () => {
    const v1 = (await createMandate(env)).body;
    const res = await revoke(v1.id, 'key leaked');
    expect(res.json()).toMatchObject({ status: 'revoked', revokeReason: 'key leaked', replacedBy: null });
    const d = (await authorize(env, '1')).body;
    expect(d).toMatchObject({ verdict: 'deny', reasonCode: 'mandate_revoked' });
    expect(d.reason).toContain('key leaked');
  });

  it('requires a reason', async () => {
    const v1 = (await createMandate(env)).body;
    expect((await env.app.inject({ method: 'POST', url: `/mandates/${v1.id}/revoke`, payload: {} })).statusCode).toBe(400);
  });
});

describe('allowlists and recipients', () => {
  it('a mandate with allowedRecipients null accepts any recipient', async () => {
    await createMandate(env, { allowedRecipients: null });
    expect((await authorize(env, '5', { recipient: BOB })).body.verdict).toBe('allow');
  });

  it('a mandate with a list rejects others', async () => {
    await createMandate(env, { allowedRecipients: [ALICE] });
    expect((await authorize(env, '5', { recipient: BOB })).body.reasonCode).toBe('recipient_not_allowed');
  });
});
