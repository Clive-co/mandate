/**
 * Seeds demo agents, a mandate that has been revoked-and-replaced, and a spread of authorizations
 * (allow and several kinds of deny) through the real service, so every verdict is genuinely signed.
 *
 *   SEED_RECIPIENT=0xYourWallet npm run seed
 *
 * Set SEED_RECIPIENT to a wallet you control so you can pay it with real Base Sepolia USDC and
 * reconcile the transfer. Set SEED_AGENT_WALLET to the wallet you will pay FROM to enable the
 * sender check for `research-bot`.
 */
import { getAddress, isAddress, type Address } from 'viem';
import { createRuntime, loadDotEnv } from './bootstrap';
import { parseUsdc as usdc } from './units';

loadDotEnv();
const { db, service } = await createRuntime();

if ((await service.listMandates()).length > 0) {
  console.log('The database already has mandates; delete data/pglite (or use a fresh database) to re-seed.');
  await db.close();
  process.exit(0);
}

const addr = (v: string | undefined, fallback: string): Address =>
  getAddress((v && isAddress(v, { strict: false }) ? v : fallback).toLowerCase());

const vendor = addr(process.env.SEED_RECIPIENT, '0x00000000000000000000000000000000000a11ce');
const hosting = addr(undefined, '0x00000000000000000000000000000000000b0b00');
const stranger = addr(undefined, '0x0000000000000000000000000000000000c0ffee');
const payer = process.env.SEED_AGENT_WALLET ? addr(process.env.SEED_AGENT_WALLET, '') : null;

const days = (n: number) => new Date(Date.now() + n * 86_400_000);

await service.createMandate('research-bot', {
  perTxLimit: usdc('50'),
  dailyLimit: usdc('120'),
  currency: 'USDC',
  categories: ['api-credits', 'data'],
  allowedRecipients: [vendor],
  payerAddress: payer,
  expiresAt: days(30),
});
await service.createMandate('ops-bot', {
  perTxLimit: usdc('200'),
  dailyLimit: usdc('300'),
  currency: 'USDC',
  categories: ['cloud', 'hosting'],
  allowedRecipients: [hosting, vendor],
  payerAddress: null,
  expiresAt: days(14),
});

// A mandate that was tightened later: v1 is revoked and replaced by v2 (any recipient, lower cap).
const v1 = await service.createMandate('data-bot', {
  perTxLimit: usdc('500'),
  dailyLimit: usdc('1000'),
  currency: 'USDC',
  categories: ['data'],
  allowedRecipients: null,
  payerAddress: null,
  expiresAt: days(7),
});
await service.replaceMandate(
  v1.id,
  {
    perTxLimit: usdc('100'),
    dailyLimit: usdc('250'),
    currency: 'USDC',
    categories: ['data', 'api-credits'],
    allowedRecipients: null,
    payerAddress: null,
    expiresAt: days(7),
  },
  'Limits too generous after the pilot',
);

const requests: Array<[agentId: string, amount: string, recipient: Address, category: string]> = [
  ['research-bot', '10', vendor, 'api-credits'], //     allow
  ['research-bot', '30', vendor, 'data'], //            allow
  ['research-bot', '80', vendor, 'data'], //            deny: over the per-transaction limit
  ['research-bot', '5', stranger, 'api-credits'], //    deny: recipient not on the allowlist
  ['research-bot', '5', vendor, 'gambling'], //         deny: category not allowed
  ['ops-bot', '40', hosting, 'hosting'], //             allow
  ['ops-bot', '150', hosting, 'cloud'], //              allow
  ['ops-bot', '120', hosting, 'cloud'], //              deny: would exceed the daily limit
  ['data-bot', '90', stranger, 'data'], //              allow (under the replacement mandate)
  ['ghost-bot', '1', vendor, 'data'], //                deny: no mandate at all
];

for (const [agentId, amount, recipient, category] of requests) {
  const d = await service.authorize({ agentId, amount: usdc(amount), currency: 'USDC', recipient, category });
  const why = d.reasonCode ? ` (${d.reasonCode})` : '';
  console.log(`${agentId.padEnd(13)} ${amount.padStart(4)} USDC ${category.padEnd(12)} -> ${d.verdict}${why}`);
}

await db.close();
console.log('\nSeeded. Start the stack with `npm run dev`.');
