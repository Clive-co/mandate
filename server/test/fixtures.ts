import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type TransactionReceipt,
} from 'viem';
import type { Mandate } from '../src/types';
import { parseUsdc } from '../src/units';

export const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address;
export const AGENT_WALLET = '0x1111111111111111111111111111111111111111' as Address;
export const ALICE = '0x2222222222222222222222222222222222222222' as Address;
export const BOB = '0x3333333333333333333333333333333333333333' as Address;
export const MALLORY = '0x4444444444444444444444444444444444444444' as Address;
export const FAKE_TOKEN = '0x5555555555555555555555555555555555555555' as Address;

export const TX_A = `0x${'a'.repeat(64)}` as Hash;
export const TX_B = `0x${'b'.repeat(64)}` as Hash;

export const TEST_SIGNER_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex; // well-known Hardhat test key, holds nothing real

export function mandate(overrides: Partial<Mandate> = {}): Mandate {
  return {
    agentId: 'agent-1',
    name: 'Test agent',
    perPaymentLimit: parseUsdc('50'),
    dailyLimit: parseUsdc('100'),
    approvalThreshold: null,
    allowedRecipients: [ALICE],
    walletAddress: null,
    active: true,
    ...overrides,
  };
}

/** Build an ERC-20 Transfer log exactly as the chain would emit it. */
export function transferLog(args: {
  token?: Address;
  from: Address;
  to: Address;
  amount: bigint;
  logIndex?: number;
}): Log {
  return {
    address: args.token ?? USDC,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: 'Transfer',
      args: { from: args.from, to: args.to },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: 'uint256' }], [args.amount]),
    blockHash: `0x${'c'.repeat(64)}` as Hash,
    blockNumber: 123n,
    logIndex: args.logIndex ?? 0,
    transactionHash: TX_A,
    transactionIndex: 0,
    removed: false,
  };
}

export function receipt(logs: Log[], status: 'success' | 'reverted' = 'success'): TransactionReceipt {
  return {
    status,
    logs,
    blockNumber: 123n,
    blockHash: `0x${'c'.repeat(64)}` as Hash,
    transactionHash: TX_A,
    transactionIndex: 0,
    from: AGENT_WALLET,
    to: USDC,
    contractAddress: null,
    cumulativeGasUsed: 21000n,
    gasUsed: 21000n,
    effectiveGasPrice: 1n,
    logsBloom: '0x' as Hex,
    type: 'eip1559',
  } as TransactionReceipt;
}
