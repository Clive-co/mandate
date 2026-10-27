import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

// Node's built-in SQLite (no native addon to compile). It is loaded via createRequire because
// Vite/Vitest's resolver doesn't recognise `node:sqlite` as a builtin and strips the prefix.
const require = createRequire(import.meta.url);
const { DatabaseSync: Database } = require('node:sqlite') as typeof import('node:sqlite');

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS mandates (
  agent_id           TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  per_payment_limit  TEXT NOT NULL,   -- USDC base units, decimal string
  daily_limit        TEXT NOT NULL,
  approval_threshold TEXT,
  allowed_recipients TEXT NOT NULL,   -- JSON array of addresses
  wallet_address     TEXT,
  active             INTEGER NOT NULL DEFAULT 1
);

-- agent_id is intentionally NOT a foreign key: a request from an unknown agent is still recorded
-- (as denied / no_mandate) so the audit trail has it.
CREATE TABLE IF NOT EXISTS requests (
  id         TEXT PRIMARY KEY,
  agent_id   TEXT NOT NULL,
  recipient  TEXT NOT NULL,
  amount     TEXT NOT NULL,           -- USDC base units
  memo       TEXT,
  status     TEXT NOT NULL CHECK (status IN ('approved','denied','needs_approval')),
  created_at INTEGER NOT NULL,        -- epoch ms
  decided_at INTEGER                  -- epoch ms; null while needs_approval
);
CREATE INDEX IF NOT EXISTS idx_requests_agent_decided ON requests(agent_id, status, decided_at);

-- Every signed decision ever issued for a request (policy first, then maybe a human).
CREATE TABLE IF NOT EXISTS decisions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES requests(id),
  outcome    TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  reasons    TEXT NOT NULL,           -- JSON
  message    TEXT NOT NULL,           -- JSON: the signed typed-data message (wire format)
  signature  TEXT NOT NULL,
  signer     TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One tracked payment per request. tx_hash is UNIQUE so one transaction can't "pay" two requests.
CREATE TABLE IF NOT EXISTS payments (
  request_id       TEXT PRIMARY KEY REFERENCES requests(id),
  tx_hash          TEXT NOT NULL UNIQUE,
  status           TEXT NOT NULL CHECK (status IN ('pending','confirmed','mismatch')),
  block_number     TEXT,
  reason           TEXT,
  detail           TEXT,
  actual_from      TEXT,
  actual_recipient TEXT,
  actual_amount    TEXT,
  created_at       INTEGER NOT NULL,
  checked_at       INTEGER
);

-- Append-only audit trail, request -> decision(s) -> transaction.
CREATE TABLE IF NOT EXISTS audit_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES requests(id),
  type       TEXT NOT NULL,
  detail     TEXT NOT NULL,           -- JSON
  at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_request ON audit_events(request_id, id);
`;

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec('PRAGMA foreign_keys = ON');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  return db;
}
