import { isAddressEqual, verifyTypedData, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import type { Outcome } from './types';

/**
 * EIP-712 typed-data signing for decisions.
 *
 * Why typed data instead of signing a JSON string? EIP-712 gives a canonical, unambiguous
 * encoding (no key-ordering or whitespace games), a domain separator so a signature made for
 * Mandate can't be replayed in another app, and wallets/tools can display the fields.
 *
 * The receiving side (e.g. a payment executor) only needs the signer's public address to check
 * that a decision really came from this server and wasn't altered.
 */
export const DECISION_DOMAIN = {
  name: 'Mandate',
  version: '1',
  chainId: baseSepolia.id,
} as const;

export const DECISION_TYPES = {
  Decision: [
    { name: 'requestId', type: 'string' },
    { name: 'agentId', type: 'string' },
    { name: 'token', type: 'address' },
    { name: 'recipient', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'outcome', type: 'string' },
    { name: 'decidedBy', type: 'string' },
    { name: 'issuedAt', type: 'uint256' },
  ],
} as const;

/** The decision as typed-data sees it (bigints). */
export interface DecisionMessage {
  requestId: string;
  agentId: string;
  token: Address;
  recipient: Address;
  amount: bigint;
  outcome: Outcome;
  /** "policy" or "human:<name>" */
  decidedBy: string;
  /** Unix seconds */
  issuedAt: bigint;
}

/** The decision as it travels over JSON (uint256 as decimal strings). */
export interface WireDecision {
  requestId: string;
  agentId: string;
  token: Address;
  recipient: Address;
  amount: string;
  outcome: Outcome;
  decidedBy: string;
  issuedAt: string;
}

export interface SignedDecision {
  message: WireDecision;
  signature: Hex;
  signer: Address;
}

export function toWire(m: DecisionMessage): WireDecision {
  return { ...m, amount: m.amount.toString(), issuedAt: m.issuedAt.toString() };
}

/** Throws if a field is not a valid uint256 decimal string. */
export function fromWire(w: WireDecision): DecisionMessage {
  if (!/^\d+$/.test(w.amount) || !/^\d+$/.test(w.issuedAt)) {
    throw new Error('amount and issuedAt must be non-negative integer strings');
  }
  return { ...w, amount: BigInt(w.amount), issuedAt: BigInt(w.issuedAt) };
}

export class DecisionSigner {
  private readonly account: PrivateKeyAccount;

  constructor(privateKey: Hex) {
    this.account = privateKeyToAccount(privateKey);
  }

  get address(): Address {
    return this.account.address;
  }

  async sign(message: DecisionMessage): Promise<SignedDecision> {
    const signature = await this.account.signTypedData({
      domain: DECISION_DOMAIN,
      types: DECISION_TYPES,
      primaryType: 'Decision',
      message,
    });
    return { message: toWire(message), signature, signer: this.account.address };
  }

  /** True only if `signature` is a valid signature of `message` by THIS server's key. */
  async verify(message: DecisionMessage, signature: Hex): Promise<boolean> {
    return verifyDecision(message, signature, this.account.address);
  }
}

/**
 * Verify a decision against an expected signer address. This is what a receiving system
 * would run, knowing only the server's public address.
 */
export async function verifyDecision(
  message: DecisionMessage,
  signature: Hex,
  expectedSigner: Address,
): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: expectedSigner,
      domain: DECISION_DOMAIN,
      types: DECISION_TYPES,
      primaryType: 'Decision',
      message,
      signature,
    });
  } catch {
    // Malformed signature bytes etc. -> not valid.
    return false;
  }
}

export function sameAddress(a: string, b: string): boolean {
  try {
    return isAddressEqual(a as Address, b as Address);
  } catch {
    return false;
  }
}

export function newSignerKey(): Hex {
  return generatePrivateKey();
}
