# Walkthrough: know every file

## The three core modules (`server/src/`)

**`policy.ts`: the decision.** One pure function, `evaluatePolicy(request, mandate, spentToday)`. No database, no clock, no network: that's *why* it's easy to test and why the tests are exhaustive. Two tiers: hard rules deny, soft rules escalate. `checkHardRules` reuses it when a human approves, so a human can't approve past a limit.

**`signing.ts`: the receipt for the decision.** Defines an EIP-712 domain + `Decision` type and wraps viem's `signTypedData` / `verifyTypedData`. `toWire`/`fromWire` convert `uint256` fields between `bigint` and JSON-safe strings. A verifier needs only the signer's *address*.

**`tracing.ts`: the link to the chain.** `traceTransfer(client, txHash, expected)`:
1. `getTransactionReceipt`; "not found" → `pending`, any other RPC error is rethrown (not a verdict).
2. `status === 'reverted'` → `mismatch`.
3. `parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs })`, then **filter by emitting contract address**.
4. Any transfer with the right `to`, exact `value` (and `from`, if known) → `confirmed`; otherwise `mismatch` with the most specific reason.

## Supporting server files

| File | What it does |
| --- | --- |
| `types.ts`, `units.ts` | Domain types; `parseUsdc`/`formatUsdc` (6-decimal bigint money), `utcDayStart` |
| `db.ts` | Opens SQLite (`node:sqlite`, loaded via `createRequire` because Vite doesn't recognise the builtin) and defines the schema |
| `store.ts` | Synchronous data-access layer; `transaction()` wraps `BEGIN IMMEDIATE … COMMIT` |
| `service.ts` | Orchestration: submit → evaluate → persist → sign; resolve; attach/recheck payment; summaries. Owns the "no `await` between check and insert" guarantee |
| `serialize.ts` | bigint → JSON shapes (`amount` exact, `amountUsdc` for display) |
| `app.ts` | Fastify routes, zod validation, error mapping (`AppError` → HTTP status) |
| `config.ts`, `index.ts` | Env loading (dev key file, required key in production); wiring |
| `seed.ts`, `scripts/` | Demo data; `gen-key`; `send-usdc` (real testnet transfer via `writeContract`) |

## Data model

`mandates` → `requests` (status: approved / denied / needs_approval) → `decisions` (one per signed decision; a queued request gets two: policy, then human) → `payments` (one per request, `tx_hash UNIQUE`) and `audit_events` (append-only timeline).

## Frontend (`web/src/`)

`api.ts` (typed fetch + a `usePoll` hook) · `App.tsx` (hash router, nav) · `pages/Dashboard` · `Approvals` (queue + decision log + Verify buttons) · `Requests` (list; detail with audit trail and the transaction-tracing panel) · `Simulator` (plays the agent). `ui.tsx` holds shared bits like the exact `formatBaseUnits`.

## Questions

**"Why EIP-712 instead of signing a JSON string?"**
Canonical encoding (no key-order/whitespace ambiguity), a domain separator that prevents cross-app replay, and wallets/tools can render the fields. The cost is you must agree on the type definition, which `/signer` publishes.

**"What's in your signed message, and what's *not*?"**
Request id, agent, token, recipient, amount, outcome, who decided, timestamp. The reasons aren't signed; the outcome is what a receiver acts on. (Reasonable follow-up: you could sign a hash of the policy version too.)

**"How do you know a transaction paid the right thing?"**
Decode the receipt's `Transfer` logs, keep only logs emitted by the USDC contract, require exact `value` and matching `to` (and `from` if the mandate names a wallet). Checking the contract address matters because `parseEventLogs` only matches the event *signature*: a malicious contract can emit a lookalike.

**"Why is a reverted transaction a mismatch and not an error?"**
It *is* a definite answer: the tx was mined and no funds moved. A network failure is different: that's a `502` and nothing is recorded.

**"Could two requests race past the daily limit?"**
Not in this design: the spend read and the insert run in one synchronous SQLite transaction with no `await` between. There's a test that fires six concurrent requests. With multiple servers or an async DB you'd need a row lock or a constraint (e.g. `SELECT … FOR UPDATE`, or a serializable transaction).

**"Can a human approve anything?"**
No. Soft rules (unknown recipient, above threshold) are exactly what a human may override. Hard limits are re-checked at approval time against current spend.

**"What happens if the same tx hash is submitted twice?"**
`tx_hash` is `UNIQUE`, and the service checks it before and again inside the save transaction. One transfer can't justify two payments.

**"What does `confirmed` mean? Is it final?"**
Mined with a successful receipt and a matching transfer. It does *not* wait for confirmation depth, and doesn't handle reorgs. On an L2 like Base that's a reasonable demo shortcut, not a production guarantee.

**"What would you build next?"**
Per-agent auth; make the executor require a valid signed decision (that's the point of signing); confirmation depth; expose `request_spend` as an MCP tool so an agent can call it directly.

## Things to be honest about


