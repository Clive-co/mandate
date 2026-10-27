import { TransactionReceiptNotFoundError } from 'viem';
import { describe, expect, it } from 'vitest';
import { traceTransfer, type ExpectedTransfer, type ReceiptClient } from '../src/tracing';
import { parseUsdc as usdc } from '../src/units';
import {
  AGENT_WALLET,
  ALICE,
  BOB,
  FAKE_TOKEN,
  MALLORY,
  TX_A,
  USDC,
  receipt,
  transferLog,
} from './fixtures';

const expected: ExpectedTransfer = { token: USDC, recipient: ALICE, amount: usdc('10') };

const clientReturning = (r: ReturnType<typeof receipt>): ReceiptClient => ({
  getTransactionReceipt: async () => r,
});

describe('traceTransfer', () => {
  it('confirms a matching USDC transfer', async () => {
    const client = clientReturning(
      receipt([transferLog({ from: AGENT_WALLET, to: ALICE, amount: usdc('10') })]),
    );
    const r = await traceTransfer(client, TX_A, expected);
    expect(r.status).toBe('confirmed');
    expect(r.blockNumber).toBe(123n);
    expect(r.actual).toEqual({ from: AGENT_WALLET, to: ALICE, amount: usdc('10') });
  });

  it('is pending when the receipt is not found yet', async () => {
    const client: ReceiptClient = {
      getTransactionReceipt: async () => {
        throw new TransactionReceiptNotFoundError({ hash: TX_A });
      },
    };
    const r = await traceTransfer(client, TX_A, expected);
    expect(r.status).toBe('pending');
    expect(r.blockNumber).toBeNull();
  });

  it('propagates unexpected RPC errors instead of guessing a verdict', async () => {
    const client: ReceiptClient = {
      getTransactionReceipt: async () => {
        throw new Error('rpc exploded');
      },
    };
    await expect(traceTransfer(client, TX_A, expected)).rejects.toThrow('rpc exploded');
  });

  it('flags a reverted transaction', async () => {
    const r = await traceTransfer(clientReturning(receipt([], 'reverted')), TX_A, expected);
    expect(r).toMatchObject({ status: 'mismatch', reason: 'tx_reverted' });
  });

  it('flags a successful tx that emitted no USDC transfer', async () => {
    const r = await traceTransfer(clientReturning(receipt([])), TX_A, expected);
    expect(r).toMatchObject({ status: 'mismatch', reason: 'no_usdc_transfer' });
  });

  it('flags the wrong recipient', async () => {
    const client = clientReturning(
      receipt([transferLog({ from: AGENT_WALLET, to: BOB, amount: usdc('10') })]),
    );
    const r = await traceTransfer(client, TX_A, expected);
    expect(r).toMatchObject({ status: 'mismatch', reason: 'wrong_recipient' });
    expect(r.detail).toContain(BOB);
  });

  it('flags the wrong amount (too much AND too little)', async () => {
    for (const amount of ['10.000001', '9.999999']) {
      const client = clientReturning(
        receipt([transferLog({ from: AGENT_WALLET, to: ALICE, amount: usdc(amount) })]),
      );
      const r = await traceTransfer(client, TX_A, expected);
      expect(r).toMatchObject({ status: 'mismatch', reason: 'wrong_amount' });
    }
  });

  it('ignores Transfer events emitted by a different (fake) token contract', async () => {
    // Same event signature, same recipient, same amount, but not emitted by real USDC.
    const client = clientReturning(
      receipt([transferLog({ token: FAKE_TOKEN, from: MALLORY, to: ALICE, amount: usdc('10') })]),
    );
    const r = await traceTransfer(client, TX_A, expected);
    expect(r).toMatchObject({ status: 'mismatch', reason: 'no_usdc_transfer' });
  });

  it('finds the matching transfer among several in one transaction', async () => {
    const client = clientReturning(
      receipt([
        transferLog({ from: AGENT_WALLET, to: BOB, amount: usdc('3'), logIndex: 0 }),
        transferLog({ token: FAKE_TOKEN, from: MALLORY, to: ALICE, amount: usdc('10'), logIndex: 1 }),
        transferLog({ from: AGENT_WALLET, to: ALICE, amount: usdc('10'), logIndex: 2 }),
      ]),
    );
    const r = await traceTransfer(client, TX_A, expected);
    expect(r.status).toBe('confirmed');
  });

  describe('sender check (when the mandate has a wallet address)', () => {
    const withFrom: ExpectedTransfer = { ...expected, from: AGENT_WALLET };

    it('confirms when the sender matches', async () => {
      const client = clientReturning(
        receipt([transferLog({ from: AGENT_WALLET, to: ALICE, amount: usdc('10') })]),
      );
      expect((await traceTransfer(client, TX_A, withFrom)).status).toBe('confirmed');
    });

    it('flags a matching transfer that came from someone else', async () => {
      const client = clientReturning(
        receipt([transferLog({ from: MALLORY, to: ALICE, amount: usdc('10') })]),
      );
      const r = await traceTransfer(client, TX_A, withFrom);
      expect(r).toMatchObject({ status: 'mismatch', reason: 'wrong_sender' });
    });
  });
});
