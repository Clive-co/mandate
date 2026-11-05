/**
 * The Postgres schema. Idempotent: safe to run on every start.
 *
 * Three ideas to notice:
 *  1. IMMUTABLE mandates. Rows are never updated. A revocation is a separate row in
 *     `mandate_revocations`; "replace" inserts the next version and the revocation points at it.
 *  2. APPEND-ONLY logs. `mandates`, `mandate_revocations`, `decision_log` and `reconciliations`
 *     reject UPDATE, DELETE and TRUNCATE with a trigger.
 *  3. Money is NUMERIC(78,0): exact integers wide enough for a uint256 (the type USDC uses onchain).
 *
 * The triggers stop the application (and anyone using its database role) from rewriting history.
 * A table owner or superuser can still drop them. For real hardening, run the app as a role that
 * only has INSERT and SELECT on these tables.
 */
export const SCHEMA = /* sql */ `
CREATE OR REPLACE FUNCTION mandate_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS mandates (
  id                 uuid PRIMARY KEY,
  agent_id           text NOT NULL,
  version            integer NOT NULL CHECK (version >= 1),
  per_tx_limit       numeric(78,0) NOT NULL CHECK (per_tx_limit > 0),
  daily_limit        numeric(78,0) NOT NULL,
  currency           text NOT NULL,
  categories         text[] NOT NULL CHECK (cardinality(categories) > 0),
  allowed_recipients text[] CHECK (allowed_recipients IS NULL OR cardinality(allowed_recipients) > 0),
  payer_address      text,
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL,
  UNIQUE (agent_id, version),
  CHECK (daily_limit >= per_tx_limit)
);

CREATE TABLE IF NOT EXISTS mandate_revocations (
  mandate_id  uuid PRIMARY KEY REFERENCES mandates(id),
  revoked_at  timestamptz NOT NULL,
  reason      text NOT NULL,
  replaced_by uuid REFERENCES mandates(id)
);

-- Every authorization request ever answered, allow or deny. id doubles as the verdict's jti.
CREATE TABLE IF NOT EXISTS decision_log (
  seq             bigserial UNIQUE,
  id              uuid PRIMARY KEY,
  agent_id        text NOT NULL,
  mandate_id      uuid REFERENCES mandates(id),
  mandate_version integer,
  amount          numeric(78,0) NOT NULL,
  currency        text NOT NULL,
  recipient       text NOT NULL,
  category        text NOT NULL,
  verdict         text NOT NULL CHECK (verdict IN ('allow', 'deny')),
  reason_code     text,
  reason          text NOT NULL,
  nonce           text NOT NULL UNIQUE,
  token           text NOT NULL,
  claims          jsonb NOT NULL,
  issued_at       timestamptz NOT NULL,
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS decision_log_agent_time ON decision_log (agent_id, created_at);

-- Every onchain check, in order. The current status of a payment is its latest row.
CREATE TABLE IF NOT EXISTS reconciliations (
  id               bigserial PRIMARY KEY,
  decision_id      uuid NOT NULL REFERENCES decision_log(id),
  tx_hash          text NOT NULL,
  status           text NOT NULL CHECK (status IN ('pending', 'matched', 'mismatch')),
  reason           text,
  detail           text,
  block_number     numeric(78,0),
  actual_from      text,
  actual_recipient text,
  actual_amount    numeric(78,0),
  created_at       timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS reconciliations_decision ON reconciliations (decision_id, id);
-- One transaction can justify only one payment, and a payment can be matched only once.
CREATE UNIQUE INDEX IF NOT EXISTS reconciliations_one_match_per_tx
  ON reconciliations (tx_hash) WHERE status = 'matched';
CREATE UNIQUE INDEX IF NOT EXISTS reconciliations_one_match_per_decision
  ON reconciliations (decision_id) WHERE status = 'matched';

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['mandates', 'mandate_revocations', 'decision_log', 'reconciliations'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_row_mutation', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION mandate_forbid_mutation()',
      t || '_no_row_mutation', t);
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_no_truncate', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION mandate_forbid_mutation()',
      t || '_no_truncate', t);
  END LOOP;
END $$;
`;
