/**
 * Seeds demo agents and a spread of requests (approved / queued / denied) through the real
 * service, so every decision is properly signed.
 *
 *   SEED_RECIPIENT=0xYourWallet npm run seed -w server
 *
 * Set SEED_RECIPIENT to a wallet you control so you can send real Base Sepolia USDC to it and
 * trace it. Set SEED_AGENT_WALLET to the wallet you'll pay FROM to enable the sender check.
 */
import { createPublicClient, getAddress, http, isAddress, type Address } from 'viem';
import { baseSepolia } from 'viem/chains';
import { loadConfig } from './config';
import { openDb } from './db';
import { MandateService } from './service';
import { DecisionSigner } from './signing';
import { Store } from './store';
import { parseUsdc as usdc } from './units';

try {
  process.loadEnvFile('.env');
} catch {
  /* optional */
}

const config = loadConfig();
const store = new Store(openDb(config.dbPath));

if (store.listRequests().length > 0) {
  console.log(`Database at ${config.dbPath} already has requests; delete it to re-seed.`);
  process.exit(0);
}

const service = new MandateService({
  store,
  signer: new DecisionSigner(config.signerKey),
  chain: createPublicClient({ chain: baseSepolia, transport: http(config.rpcUrl) }),
  token: config.tokenAddress,
});

const pick = (v: string | undefined, fallback: string): Address => {
  const value = v && isAddress(v, { strict: false }) ? v : fallback;
  return getAddress(value.toLowerCase());
};

const vendor = pick(process.env.SEED_RECIPIENT, '0x00000000000000000000000000000000000a11ce');
const otherVendor = getAddress('0x00000000000000000000000000000000000b0b00');
const stranger = getAddress('0x0000000000000000000000000000000000c0ffee');
const agentWallet = process.env.SEED_AGENT_WALLET ? pick(process.env.SEED_AGENT_WALLET, '') : null;

service.upsertMandate({
  agentId: 'research-bot',
  name: 'Research assistant',
  perPaymentLimit: usdc('50'),
  dailyLimit: usdc('120'),
  approvalThreshold: usdc('25'),
  allowedRecipients: [vendor],
  walletAddress: agentWallet,
  active: true,
});
service.upsertMandate({
  agentId: 'ops-bot',
  name: 'Ops automation',
  perPaymentLimit: usdc('200'),
  dailyLimit: usdc('300'),
  approvalThreshold: usdc('100'),
  allowedRecipients: [otherVendor, vendor],
  walletAddress: null,
  active: true,
});

const requests: Array<[string, Address, string, string]> = [
  ['research-bot', vendor, '10', 'API credits for web search'],
  ['research-bot', vendor, '30', 'Dataset purchase (above auto-approval threshold)'],
  ['research-bot', vendor, '80', 'Annual plan (over the per-payment limit)'],
  ['research-bot', stranger, '5', 'Tip to an unknown address'],
  ['ops-bot', otherVendor, '40', 'Cloud storage'],
  ['ops-bot', otherVendor, '150', 'Quarterly hosting prepayment'],
];

for (const [agentId, recipient, amount, memo] of requests) {
  const { request, decision } = await service.submitRequest({
    agentId,
    recipient,
    amount: usdc(amount),
    memo,
  });
  console.log(`${agentId.padEnd(13)} ${amount.padStart(4)} USDC -> ${decision.outcome.padEnd(14)} ${request.id}`);
}
console.log('\nSeeded. Start the API with `npm run dev -w server`.');
