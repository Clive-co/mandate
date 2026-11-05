import { TransactionReceiptNotFoundError } from 'viem';
import { describe, expect, it } from 'vitest';
import { reconcileTransfer, type ExpectedTransfer, type ReceiptClient } from '../src/reconcile';
import { parseUsdc as usdc } from '../src/units';
import { AGENT_WALLET, ALICE, BOB, FAKE_TOKEN, MALLORY, TX_A, USDC, receipt, transferLog } from './helpers';

const expected: ExpectedTransfer = { token: USDC, recipient: ALICE, amount: usdc('10') };

const clientReturning = (r: ReturnType<typeof receipt>): ReceiptClient => ({ getTransactionReceipt: async () => r });
const paid = (to = ALICE, amount = '10', from = AGENT_WALLET) => receipt([transferLog({ from, to, amount: usdc(amount) })]);

describe('reconcileTransfer', () => {
  it('matches a USDC transfer that fits the verdict exactly', async () => {
    const r = await reconcileTransfer(clientReturning(paid()), TX_A, expected);
    expect(r.status).toBe('matched');
    expect(r.blockNumber).toBe(123n);
    expect(r.actual).toEqual({ from: AGENT_WALLET, to: ALICE, amount: usdc('10') });
  });

  it('is pending while the receipt does not exist yet', async () => {
    const client: ReceiptClient = {
      getTransactionReceipt: async () => {
        throw new TransactionReceiptNotFoundError({ hash: TX_A });
      },
    };
    const r = await reconcileTransfer(client, TX_A, expected);
    expect(r).toMatchObject({ status: 'pending', blockNumber: null });
  });

  it('propagates unexpected RPC errors instead of guessing a verdict', async () => {
    const client: ReceiptClient = {
      getTransactionReceipt: async () => {
        throw new Error('rpc exploded');
      },
    };
    await expect(reconcileTransfer(client, TX_A, expected)).rejects.toThrow('rpc exploded');
  });

  it('flags a reverted transaction', async () => {
    const r = await reconcileTransfer(clientReturning(receipt([], 'reverted')), TX_A, expected);
    expect(r).toMatchObject({ status: 'mismatch', reason: 'tx_reverted' });
  });

  it('flags a successful tx that emitted no USDC transfer', async () => {
    const r = await reconcileTransfer(clientReturning(receipt([])), TX_A, expected);
    expect(r).toMatchObject({ status: 'mismatch', reason: 'no_usdc_transfer' });
  });

  it('flags the wrong recipient', async () => {
    const r = await reconcileTransfer(clientReturning(paid(BOB)), TX_A, expected);
    expect(r).toMatchObject({ status: 'mismatch', reason: 'wrong_recipient' });
    expect(r.detail).toContain(BOB);
  });

  it.each(['10.000001', '9.999999'])('flags the wrong amount (%s): exact equality, not "at least"', async (amount) => {
    const r = await reconcileTransfer(clientReturning(paid(ALICE, amount)), TX_A, expected);
    expect(r).toMatchObject({ status: 'mismatch', reason: 'wrong_amount' });
  });

  it('compares large amounts exactly, past the 2^53 float limit', async () => {
    const big = 2n ** 64n + 1n;
    const client = clientReturning(receipt([transferLog({ from: AGENT_WALLET, to: ALICE, amount: big })]));
    expect((await reconcileTransfer(client, TX_A, { ...expected, amount: big })).status).toBe('matched');
    expect((await reconcileTransfer(client, TX_A, { ...expected, amount: big - 1n })).reason).toBe('wrong_amount');
  });

  it('ignores Transfer events emitted by a lookalike (fake) token contract', async () => {
    const client = clientReturning(
      receipt([transferLog({ token: FAKE_TOKEN, from: MALLORY, to: ALICE, amount: usdc('10') })]),
    );
    expect(await reconcileTransfer(client, TX_A, expected)).toMatchObject({ status: 'mismatch', reason: 'no_usdc_transfer' });
  });

  it('finds the matching transfer among several in one transaction', async () => {
    const client = clientReturning(
      receipt([
        transferLog({ from: AGENT_WALLET, to: BOB, amount: usdc('3'), logIndex: 0 }),
        transferLog({ token: FAKE_TOKEN, from: MALLORY, to: ALICE, amount: usdc('10'), logIndex: 1 }),
        transferLog({ from: AGENT_WALLET, to: ALICE, amount: usdc('10'), logIndex: 2 }),
      ]),
    );
    expect((await reconcileTransfer(client, TX_A, expected)).status).toBe('matched');
  });

  describe('sender check (when the mandate names a payer wallet)', () => {
    const withFrom: ExpectedTransfer = { ...expected, from: AGENT_WALLET };

    it('matches when the sender is the payer', async () => {
      expect((await reconcileTransfer(clientReturning(paid()), TX_A, withFrom)).status).toBe('matched');
    });

    it('flags an otherwise-matching transfer from someone else', async () => {
      const r = await reconcileTransfer(clientReturning(paid(ALICE, '10', MALLORY)), TX_A, withFrom);
      expect(r).toMatchObject({ status: 'mismatch', reason: 'wrong_sender' });
    });
  });
});
