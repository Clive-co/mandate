# Walkthrough: know every file

## The core modules (`server/src/`)

**`policy.ts`: the decision.** One pure function, `evaluatePolicy(request, mandate, spentToday, now)`. No database, no clock, no network, which is why it is exhaustively testable. Nine checks in a fixed order; the first failure is the single reason. Limits are inclusive; a mandate is expired from the instant `now >= expiresAt`.

**`verdict.ts` + `keys.ts`: the signed answer.** `signVerdict` builds the claims and signs them with `jose`'s `SignJWT` (ES256, `kid`, `typ: mandate-verdict+jwt`, `exp = iat + 300`, a 128-bit random `nonce`, `jti` = the decision id). `KeyRing` holds the active private key plus retired *public* keys, and publishes them as a JWKS. The `kid` is the RFC 7638 thumbprint of the public key. `amount` is a base-unit *string*, never a JSON number.

**`verifier.ts`: what a seller runs.** `verifyVerdict(token, expected, { keys, issuer, nonces })`. It imports nothing from the database. Order of checks: signature and header (`alg` pinned to ES256, `typ`, issuer, expiry) → verdict is `allow` → amount (bigint), currency, recipient (and optional chain/token) match what the seller expects → **only then** consume the nonce. `NonceStore.consume` must be atomic; the in-memory one is for a single process.

**`reconcile.ts`: the link to the chain.** `reconcileTransfer(client, txHash, expected)`: `getTransactionReceipt` (not found → `pending`; other RPC errors are rethrown, because a network error is not a verdict) → reverted is `mismatch` → `parseEventLogs({ abi: erc20Abi, eventName: 'Transfer' })` → **filter by emitting contract address** → look for a transfer with the exact recipient and amount (and sender, if known) → `matched`, else `mismatch` with the most specific reason.

## Persistence and orchestration

| File | What it does |
| --- | --- |
| `schema.ts` | The Postgres schema, idempotent. `NUMERIC(78,0)` money (wide enough for a uint256). Append-only triggers on four tables. Partial unique indexes so a transaction or a decision can only be `matched` once |
| `db.ts` | A tiny `Db` interface with two adapters: `pg` (a real server) and PGlite (Postgres in WebAssembly). One set of SQL for both. `transaction()` is BEGIN/COMMIT/ROLLBACK |
| `repo.ts` | All SQL. Numerics are cast to text and read back as `bigint` |
| `service.ts` | Orchestration: mandates (create/replace/revoke), `authorize`, decision detail and trail, reconciliation, summary. Owns the locking |
| `app.ts` | Fastify routes, zod validation, error mapping (`AppError` to HTTP status), and the *demo* seller endpoint |
| `serialize.ts` | bigint to JSON shapes (`amount` exact, `amountUsdc` for display) |
| `config.ts`, `bootstrap.ts`, `index.ts` | Env loading (dev key file; key required in production), wiring |
| `mcp.ts`, `scripts/mcp.ts` | The `request_spend` MCP tool, and its stdio entry point |
| `seed.ts`, `scripts/` | Demo data through the real service; `gen-key`; `send-usdc` (a real testnet transfer via viem) |

## Data model

`mandates` (immutable, one row per version) ← `mandate_revocations` (one row per revoked mandate, `replaced_by` points at the next version) · `decision_log` (every verdict, allow and deny, with its token and claims) → `reconciliations` (every onchain check; the current status is the latest row).

## Frontend (`web/src/`)

`api.ts` (typed fetch + a `usePoll` hook) · `App.tsx` (hash router) · `pages/Dashboard` (spend per agent, awaiting payment, recent approvals) · `Decisions` (log, and a detail page with the request-to-transaction trail and the reconcile panel) · `Mandates` (versions, revoke, replace, create) · `Simulator` (play the agent, then play the seller and watch a replay get rejected).

## Questions 

**"Why a JWT and not just an API response?"**
The seller is a different party. A signed, self-contained token lets the seller verify *offline* that the verdict is ours and unaltered, without calling us per payment. The cost is that revocation and expiry must be designed in: hence the five-minute `exp` and the nonce.

**"Why ES256 and a JWKS?"**
Asymmetric: sellers only ever hold public keys, so a compromised seller cannot mint verdicts (it could with an HS256 shared secret). The JWKS lets sellers fetch and cache keys, and the `kid` selects the right one, which is what makes rotation possible: keep the old public key published until old verdicts expire.

**"What stops a replay?"**
The `nonce` claim plus the seller's nonce store: the first presentation consumes it, the second is rejected. The expiry bounds how long the store must remember it. Two subtleties worth knowing: consume the nonce *last* (a verification that fails for another reason must not burn a good token), and `consume` must be atomic (a test fires concurrent presentations; exactly one wins).

**"What attacks does the verifier defend against?"**
`alg: none`, algorithm confusion (HS256 signed with the public key as secret), tokens that are validly signed but are not verdicts (`typ`), a verdict from the wrong issuer, edited payloads, a denied verdict with a flipped `verdict` claim, a token signed by a different key claiming our `kid`.

**"Why are amounts strings in the JWT?"**
JSON numbers are doubles; USDC amounts are 6-decimal integers that must be exact. The verifier compares `BigInt(claim) === expected` so one base unit off is rejected and `"10"` vs `"10.0"` cannot slip through.

**"How do mandates stay immutable?"**
Rows are never updated: a revocation is a separate row. The database enforces it with triggers that reject `UPDATE`, `DELETE` and `TRUNCATE`, and tests assert this with raw SQL. Be honest about the limit: a table owner can drop a trigger, so production hardening is a database role with only `INSERT` and `SELECT`.

**"Could two requests race past the daily limit?"**
No. `authorize` runs in one transaction that first takes `SELECT … FOR UPDATE` on the agent's current mandate row, then sums today's allowed spend. A concurrent request for the same agent waits on that lock, and under READ COMMITTED its later `SUM` statement sees the first request's committed row. A test fires six concurrent requests. The same property is verified on real Postgres, not only PGlite.

**"What does replacing a mandate do to today's spend?"**
Nothing: the daily budget is summed per agent across mandate versions. A human raising the limit does not get a free reset, and tightening it takes effect immediately.

**"How do you know a transaction paid the right thing?"**
Decode the receipt's `Transfer` logs, keep only logs emitted by the verdict's USDC contract (`parseEventLogs` matches the event signature only, so a lookalike token's `Transfer` would otherwise count), and require the exact recipient and amount, compared as `bigint`. The source of truth is the **verdict**, not the mandate as it is today.

**"What if the same transaction is submitted twice, or for two payments?"**
Partial unique indexes on `reconciliations`: one `matched` row per `tx_hash` and one per decision. The service checks first and again inside the transaction; the index is the backstop for a race (a test attempts two concurrent matches; one wins).

**"Is `matched` final?"**
No: mined with a successful receipt and a matching log. No confirmation depth or reorg handling, and it does not check the transfer happened within the verdict's five minutes (a test documents that it still reconciles after expiry). On an L2 and a testnet that is a reasonable shortcut; it is not a production guarantee.

**"What would you build next?"**
Per-agent authentication; idempotency keys on `/authorize`; make a payment executor *require* a valid verdict before releasing funds; bound reconciliation by time and confirmation depth; a shared nonce store (Redis `SET NX EX`); an escrow state tracker.

