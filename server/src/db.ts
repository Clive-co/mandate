import { mkdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { SCHEMA } from './schema';

/**
 * A deliberately tiny database interface, so the app runs on either:
 *  - `pg` against a real Postgres server (DATABASE_URL), the production path; or
 *  - PGlite, Postgres compiled to WebAssembly running in-process, for zero-setup dev and tests.
 * Both speak the same SQL, so there is one set of queries.
 */
export type Row = Record<string, unknown>;

export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  readonly kind: 'pg' | 'pglite';
  /** Run `fn` in one transaction: COMMIT if it resolves, ROLLBACK if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Run a multi-statement script (no parameters). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export function connectPg(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    kind: 'pg',
    async query<T>(sql: string, params?: unknown[]) {
      return (await pool.query(sql, params)).rows as T[];
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({
          async query<R>(sql: string, params?: unknown[]) {
            return (await client.query(sql, params)).rows as R[];
          },
        });
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** `dir` is a directory for persistent storage, or undefined / "memory://" for in-memory. */
export async function connectPglite(dir?: string): Promise<Db> {
  const inMemory = !dir || dir === 'memory://';
  if (!inMemory) mkdirSync(dir, { recursive: true });
  const db = await PGlite.create(inMemory ? undefined : dir);
  return {
    kind: 'pglite',
    async query<T>(sql: string, params?: unknown[]) {
      return (await db.query<T>(sql, params)).rows;
    },
    async exec(sql) {
      await db.exec(sql);
    },
    async transaction<T>(fn: (tx: Queryable) => Promise<T>) {
      return db.transaction(async (tx) =>
        fn({
          async query<R>(sql: string, params?: unknown[]) {
            return (await tx.query<R>(sql, params)).rows;
          },
        }),
      );
    },
    close: () => db.close(),
  };
}

export async function migrate(db: Db): Promise<void> {
  await db.exec(SCHEMA);
}

/** Postgres SQLSTATE of an error from either driver, e.g. "23505" for a unique violation. */
export function sqlState(err: unknown): string | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'string' ? code : undefined;
}
