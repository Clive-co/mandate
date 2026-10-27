/**
 * Send real Base Sepolia testnet USDC so you have transactions to trace.
 *
 *   npm run send-usdc -w server -- <recipient> <amountUsdc>
 *   npm run send-usdc -w server -- 0xAbc...123 10
 *
 * Needs SENDER_PRIVATE_KEY in server/.env: a TESTNET wallet holding Base Sepolia ETH (gas)
 * and testnet USDC. Never use a key that holds real funds.
 *   - ETH:  a Base Sepolia faucet (e.g. Coinbase Developer Platform, Alchemy)
 *   - USDC: https://faucet.circle.com  (choose Base Sepolia)
 */
import { createPublicClient, createWalletClient, erc20Abi, http, isAddress, isHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { USDC_BASE_SEPOLIA } from '../src/config';
import { explorerTxUrl } from '../src/serialize';
import { formatUsdc, parseUsdc } from '../src/units';

try {
  process.loadEnvFile('.env');
} catch {
  /* optional */
}

const [to, amountArg] = process.argv.slice(2);
const key = process.env.SENDER_PRIVATE_KEY;
const rpc = process.env.RPC_URL ?? 'https://sepolia.base.org';
const token = (process.env.USDC_ADDRESS ?? USDC_BASE_SEPOLIA) as Hex;

if (!to || !isAddress(to, { strict: false }) || !amountArg) {
  console.error('Usage: npm run send-usdc -w server -- <recipient 0x…> <amountUsdc>');
  process.exit(1);
}
if (!key || !isHex(key) || key.length !== 66) {
  console.error('Set SENDER_PRIVATE_KEY (a funded TESTNET key) in server/.env');
  process.exit(1);
}

const amount = parseUsdc(amountArg);
const account = privateKeyToAccount(key);
const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpc) });
const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpc) });

const balance = await publicClient.readContract({
  address: token,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [account.address],
});
console.log(`From ${account.address}: ${formatUsdc(balance)} USDC`);
if (balance < amount) {
  console.error(`Not enough USDC. Get some at https://faucet.circle.com (Base Sepolia).`);
  process.exit(1);
}

const hash = await wallet.writeContract({
  address: token,
  abi: erc20Abi,
  functionName: 'transfer',
  args: [to, amount],
});
console.log(`Sent ${formatUsdc(amount)} USDC -> ${to}`);
console.log(`tx hash: ${hash}`);
console.log(explorerTxUrl(hash));
