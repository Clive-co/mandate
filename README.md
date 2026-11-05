# Mandate

**Spend authorization for AI agents, with signed verdicts and onchain reconciliation.**

A human gives an agent a *mandate*: limits, allowed spend categories, an expiry. When the agent wants to pay someone, it asks Mandate. Mandate answers **allow or deny, with a reason, as a signed token** a seller can verify offline. After the payment, Mandate takes the Base Sepolia transaction hash, decodes the USDC `Transfer` log, and checks it against the verdict.

> **Honest framing:** this is a testnet learning project modelled on agent-payment controls. It is not a production system, it has no authentication, and it never touches real money. See [Limitations](#limitations).

Stack: TypeScript throughout · Node + Fastify · **Postgres** (`pg`; PGlite for zero-setup dev and tests) · [`jose`](https://github.com/panva/jose) (ES256 JWTs) · [viem](https://viem.sh) · React (Vite) · Vitest · Base Sepolia.

## How it works

```mermaid
sequenceDiagram
    autonumber
    participant H as Human
    participant A as Agent
    participant M as Mandate API
    participant S as Seller
    participant C as Base Sepolia

    H->>M: create mandate (limits, categories, expiry)
    A->>M: POST /authorize {amount, recipient, category}
    M->>M: evaluate policy, append to decision log
    M-->>A: allow or deny + reason + signed ES256 JWT (5 min, nonce)
    A->>S: present verdict
    S->>M: GET /.well-known/jwks.json (cached)
    S->>S: verifyVerdict(): signature, amount, currency, recipient, nonce
    A->>C: USDC transfer
    A->>M: POST /decisions/:id/payment {txHash}
    M->>C: getTransactionReceipt
    M->>M: decode Transfer log, compare with bigint
    M-->>A: matched, mismatch, or pending
```

| Step | What | Where |
| --- | --- | --- |
| 1 | **Mandates**: immutable records, revoke-and-replace; **append-only decision log** in Postgres | `schema.ts`, `repo.ts`, `service.ts` |
| 2 | **Authorization endpoint**: limits, categories, expiry, then allow or deny with a reason | `policy.ts`, `POST /authorize` |
| 3 | **Signed verdicts**: ES256 JWT, `/.well-known/jwks.json`, 5-minute expiry, nonce | `keys.ts`, `verdict.ts` |
| 4 | **Verifier**: what a seller runs. Signature, amount, currency, recipient, replayed nonces | `verifier.ts` |
| 5 | **Onchain reconciliation**: viem `Transfer` decoding, bigint comparison; `matched`, `mismatch`, `pending` | `reconcile.ts` |
| 6 | **Dashboard**: allowed spend per agent, awaiting payment, per-payment trail from request to transaction | `web/` |
| 7 | **Stretch**: `request_spend` as an MCP tool | `mcp.ts`, `scripts/mcp.ts` |

## Mandates are immutable

A mandate row is never updated. To change one you **revoke and replace** it: the old version stays on record, marked replaced, and the next version becomes the agent's current mandate. Revocation lives in its own table (`mandate_revocations`), so the mandate row itself never changes.

- `POST /mandates` creates version 1 (or the next version, if the agent's latest mandate is revoked or expired).
- `POST /mandates/:id/replace` revokes this version and inserts the next one, in one transaction.
- `POST /mandates/:id/revoke` revokes without a replacement. The agent is denied until a new mandate exists.

The **decision log** (`decision_log`) records every authorization ever answered, allow *and* deny, with the signed token. Four tables (`mandates`, `mandate_revocations`, `decision_log`, `reconciliations`) are **append-only**: a trigger rejects `UPDATE`, `DELETE` and `TRUNCATE`. This stops the application, or anyone using its database role, from rewriting history. A table owner can still drop the triggers; for real hardening, run the app as a role that only has `INSERT` and `SELECT`.

## Policy

Checks run in a fixed order; the **first failure** is the single reason returned.

| # | Check | Reason code |
| --- | --- | --- |
| 1 | amount > 0 | `invalid_amount` |
| 2 | the agent has a mandate | `no_mandate` |
| 3 | it is not revoked | `mandate_revoked` |
| 4 | it has not expired (`now < expiresAt`) | `mandate_expired` |
| 5 | currency matches (USDC only) | `currency_mismatch` |
| 6 | category is on the mandate | `category_not_allowed` |
| 7 | recipient is on the allowlist (only if the mandate lists recipients) | `recipient_not_allowed` |
| 8 | amount ≤ per-transaction limit | `exceeds_per_tx_limit` |
| 9 | today's allowed spend + amount ≤ daily limit | `exceeds_daily_limit` |

Limits are inclusive. The daily limit is per **UTC day** and counts every *allowed* authorization for the agent (across mandate versions, so replacing a mandate does not reset the budget). It counts authorizations, not confirmed payments, so an allowed verdict that is never paid still uses budget. That is the conservative choice for a spending control. Authorizations for one agent are serialized with a row lock on its current mandate, so concurrent requests cannot both slip under the daily limit (there is a test that fires six at once).

## Signed verdicts

Each decision, allow or deny, is returned as an **ES256 JWT**:

```jsonc
// header
{ "alg": "ES256", "kid": "<JWK thumbprint>", "typ": "mandate-verdict+jwt" }
// claims
{
  "iss": "https://mandate.example", "sub": "research-bot",
  "iat": 1793100000, "exp": 1793100300,          // five minutes
  "jti": "<decision id>", "nonce": "<128 random bits>",
  "verdict": "allow", "reasonCode": null,
  "amount": "12500000", "currency": "USDC",       // base units as a string: never a float
  "recipient": "0x…", "category": "cloud",
  "chainId": 84532, "token": "0x036C…CF7e",
  "mandateId": "…", "mandateVersion": 2
}
```

Public keys are served at `GET /.well-known/jwks.json`. The `kid` is the key's RFC 7638 thumbprint. To rotate, generate a new key and move the old **public** key into `RETIRED_JWKS`, so verdicts already issued still verify.

## The verifier (what a seller runs)

`server/src/verifier.ts` knows nothing about this server's database. A seller needs the issuer's public keys and its own idea of what it expects to be paid:

```ts
import { createRemoteJWKSet } from 'jose';
import { InMemoryNonceStore, verifyVerdict } from './verifier';

const keys = createRemoteJWKSet(new URL('https://mandate.example/.well-known/jwks.json'));
const nonces = new InMemoryNonceStore(); // several instances? use a shared store (Redis SET NX EX)

const result = await verifyVerdict(
  token,
  { amount: 12_500_000n, currency: 'USDC', recipient: '0xSeller…' },
  { keys, issuer: 'https://mandate.example', nonces },
);
if (!result.ok) refuse(result.code); // bad_signature, expired, amount_mismatch, replayed, …
```

It pins `alg` to ES256 (no `none`, no algorithm confusion), checks the `typ` header and issuer, rejects expired or denied verdicts, compares amount as **bigint**, and consumes the nonce **last**, so a verification that fails for another reason does not burn a good token. The Simulator page runs this verifier as a demo seller: accept a verdict, click again, and watch the replay get rejected.

## Onchain reconciliation

`POST /decisions/:id/payment {txHash}` (allowed decisions only):

1. `getTransactionReceipt`. Not mined yet → `pending`. Any other RPC failure is a `502` and records nothing: a network error is not a verdict.
2. Reverted → `mismatch`.
3. `parseEventLogs` with `erc20Abi` decodes `Transfer` events. It matches the event *signature* only, so the log's emitting address is filtered to the verdict's USDC contract. A lookalike token cannot fake a payment.
4. Some transfer with the verdict's exact recipient and amount (and the mandate's payer wallet, if set) → `matched`. Otherwise `mismatch` with the most specific reason (`wrong_recipient`, `wrong_amount`, `wrong_sender`, `no_usdc_transfer`, `tx_reverted`).

Every check is appended to `reconciliations`; a payment's status is its latest row. Partial unique indexes guarantee a transaction can be `matched` once, and a decision can be `matched` once. `pending` can be re-checked with `POST /decisions/:id/payment/recheck`.

## Run it

Requires **Node ≥ 22.13**.

```bash
npm install
npm run seed     # demo mandates (incl. one revoked-and-replaced) + a spread of allow/deny decisions
npm run dev      # API on :8787, web on :5173
```

Open http://localhost:5173. With no `DATABASE_URL` the server uses PGlite (real Postgres compiled to WebAssembly) stored in `server/data/pglite`. For a real Postgres server, set `DATABASE_URL=postgres://user:pass@host:5432/db`; the schema is created on start. In development a signing key is generated into `server/data/signing-key.json` (gitignored); in production `SIGNING_KEY_JWK` is required (`npm run gen-key -w server` prints one). See [`.env.example`](.env.example).

### Getting real onchain data

1. Create a **throwaway** wallet; put its key in `server/.env` as `SENDER_PRIVATE_KEY`. Never use a key that holds real funds.
2. Get Base Sepolia ETH (gas) from a faucet and testnet USDC from [faucet.circle.com](https://faucet.circle.com) (choose *Base Sepolia*).
3. Seed with a recipient you control: `SEED_RECIPIENT=0xYourOtherWallet npm run seed` (delete `server/data/` to re-seed).
4. Authorize a payment to that recipient in the Simulator, then send exactly that amount: `npm run send-usdc -w server -- 0xRecipient 10`.
5. Paste the printed hash into the decision's **Onchain reconciliation** panel. Try the wrong amount or recipient to see `mismatch`.

USDC on Base Sepolia is `0x036CbD53842c5426634e7929541eC2318f3dCF7e` ([Circle](https://developers.circle.com/stablecoins/usdc-contract-addresses)).

## API

| Method & path | Purpose |
| --- | --- |
| `POST /mandates` · `GET /mandates` · `GET /mandates/:id` | Create, list (all versions), fetch |
| `POST /mandates/:id/replace` · `POST /mandates/:id/revoke` | Revoke-and-replace · revoke |
| `POST /authorize` | **Agent call.** `{agentId, amount, currency, recipient, category}` → verdict, reason, signed token. `200` for allow *and* deny |
| `GET /decisions` · `GET /decisions/:id` | Decision log · one decision with its trail |
| `POST /decisions/:id/payment` · `…/payment/recheck` | Reconcile a transaction hash · re-check |
| `GET /.well-known/jwks.json` | Public keys for verification |
| `GET /summary` | Dashboard data |
| `POST /demo/seller/verify` | A *simulated* seller, for the demo UI |

### MCP tool (stretch)

`request_spend` lets an agent ask for permission through the Model Context Protocol. A deny comes back as a normal result with its reason; only transport and validation problems set `isError`.

```bash
MANDATE_API_URL=http://localhost:8787 MANDATE_AGENT_ID=research-bot npm run mcp -w server
```

## Tests and CI

```bash
npm test                                   # Vitest on in-process Postgres (PGlite)
TEST_DATABASE_URL=postgres://… npm test    # the same suite on a real Postgres server
npm run lint && npm run typecheck && npm run build
```

CI (`.github/workflows/ci.yml`) runs lint, typecheck, the tests **twice** (PGlite, then a Postgres 16 service container), and the web build.

- **Policy**: every check and its precedence, inclusive boundaries, expiry instant.
- **Mandates**: immutability enforced by the database (`UPDATE`/`DELETE`/`TRUNCATE` all rejected), revoke-and-replace atomicity, concurrent replaces, version numbering.
- **Authorize**: verdict contents, UTC-day rollover, concurrent requests cannot exceed the daily limit, deny verdicts are signed and logged.
- **Verifier**: tampering, wrong key, `alg: none`, wrong `typ`/issuer, expiry, denied verdicts, amount/currency/recipient mismatch, replays, and that a failed check does not consume the nonce.
- **Reconciliation**: matched, pending, reverted, wrong recipient/amount/sender, **fake-token `Transfer` events ignored**, multi-transfer transactions, transaction reuse, RPC failure.
- **MCP**: tool discovery, allow and deny results, error paths, through a real MCP client and server pair.

Reconciliation tests build receipts with viem's own `encodeEventTopics` / `encodeAbiParameters` (byte-for-byte what a chain emits) but run against a fake client, not a live chain. The real-chain path is exercised by the manual steps above.

## Limitations

Deliberately small. Not done, and what it would take:

- **No authentication.** Anyone who can reach the API can create mandates, revoke them, or request spend. Real use needs per-agent credentials (for example mTLS or signed requests) and authenticated administrators.
- **Authorizations are not idempotent.** A retried `POST /authorize` is a second authorization and uses budget twice. An idempotency key would fix this.
- **The server never moves money.** It decides and reconciles. A real executor would have to *require* a valid verdict before releasing funds.
- **Reconciliation is not time-bound or final.** It does not check that the transfer happened within the verdict's five minutes, and `matched` means mined with a matching log, not final: there is no confirmation depth or reorg handling beyond a manual recheck.
- **The nonce store in the demo seller is in-memory.** Several seller instances need a shared store.
- **Append-only is enforced by triggers**, which a table owner can drop (see above).
- **Daily budget counts allowed authorizations**, not paid ones, and is per UTC day.
- USDC only; one chain.

## Deploying (not yet done)

- **API** (Render/Fly/Railway) with a managed Postgres: `npm ci`, start with `npm start -w server`. Set `NODE_ENV=production`, `DATABASE_URL`, `SIGNING_KEY_JWK`, `ISSUER` (the public URL), `RPC_URL`, `CORS_ORIGIN`.
- **Web** (Vercel/Netlify): root `web/`, build `npm run build`, output `dist`, and set `VITE_API_URL` to the API origin.

## Layout

```
server/src/  policy.ts · verdict.ts + keys.ts · verifier.ts · reconcile.ts   ← the core modules
             service.ts (orchestration) · repo.ts + db.ts + schema.ts (Postgres) · app.ts (routes)
             mcp.ts · seed.ts
server/test/ policy · mandates · authorize · verifier · reconcile · payments · mcp
web/src/     App.tsx · api.ts · pages/{Dashboard,Decisions,Mandates,Simulator}.tsx
docs/WALKTHROUGH.md   file-by-file guide and interview prep
```
