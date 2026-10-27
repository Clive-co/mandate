import {
  TransactionReceiptNotFoundError,
  erc20Abi,
  isAddressEqual,
  parseEventLogs,
  type Address,
  type Hash,
  type TransactionReceipt,
} from 'viem';
import type { PaymentStatus } from './types';
import { formatUsdc } from './units';

/** The slice of viem's PublicClient we need. Keeping it narrow makes tests trivial. */
export interface ReceiptClient {
  getTransactionReceipt(args: { hash: Hash }): Promise<TransactionReceipt>;
}

export interface ExpectedTransfer {
  /** USDC contract address. Only Transfer events emitted BY this contract count. */
  token: Address;
  recipient: Address;
  /** USDC base units. */
  amount: bigint;
  /** If set, the transfer must come from this address. */
  from?: Address | null;
}

export type MismatchReason =
  | 'tx_reverted'
  | 'no_usdc_transfer'
  | 'wrong_recipient'
  | 'wrong_amount'
  | 'wrong_sender';

export interface TraceResult {
  status: PaymentStatus;
  blockNumber: bigint | null;
  /** Machine-readable reason when status is `mismatch`. */
  reason: MismatchReason | null;
  /** Human-readable summary. */
  detail: string;
  /** The transfer that matched (confirmed) or the closest candidate (mismatch). */
  actual: { from: Address; to: Address; amount: bigint } | null;
}

/**
 * Fetch a transaction receipt, decode its USDC Transfer events, and check that one of them
 * matches what was approved.
 *
 *   receipt not found yet      -> pending
 *   reverted                   -> mismatch (tx_reverted)
 *   no USDC Transfer in logs   -> mismatch (no_usdc_transfer)
 *   transfer(s) found, none match -> mismatch (wrong_recipient / wrong_amount / wrong_sender)
 *   a transfer matches         -> confirmed
 *
 * Security notes:
 *  - `parseEventLogs` decodes by event signature only. It does NOT check which contract emitted
 *    the log, and anyone can deploy a contract that emits a lookalike `Transfer`. So we filter
 *    on `log.address === token` ourselves.
 *  - A single transaction can contain several transfers (batching, routers). We accept the
 *    transaction if ANY USDC transfer matches exactly, and require exact amount equality.
 *  - Associating a tx with a request only once is enforced elsewhere (UNIQUE tx_hash).
 */
export async function traceTransfer(
  client: ReceiptClient,
  txHash: Hash,
  expected: ExpectedTransfer,
): Promise<TraceResult> {
  let receipt: TransactionReceipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError) {
      return {
        status: 'pending',
        blockNumber: null,
        reason: null,
        detail: 'Transaction not mined yet (or hash unknown to this RPC)',
        actual: null,
      };
    }
    throw err; // RPC/network errors are not a verdict about the payment
  }

  const blockNumber = receipt.blockNumber;

  if (receipt.status === 'reverted') {
    return {
      status: 'mismatch',
      blockNumber,
      reason: 'tx_reverted',
      detail: 'Transaction reverted onchain; no funds moved',
      actual: null,
    };
  }

  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: receipt.logs,
  }).filter((log) => isAddressEqual(log.address, expected.token));

  if (transfers.length === 0) {
    return {
      status: 'mismatch',
      blockNumber,
      reason: 'no_usdc_transfer',
      detail: 'Transaction succeeded but emitted no USDC Transfer event',
      actual: null,
    };
  }

  const decoded = transfers.map((t) => ({
    from: t.args.from,
    to: t.args.to,
    amount: t.args.value,
  }));

  const match = decoded.find(
    (t) =>
      isAddressEqual(t.to, expected.recipient) &&
      t.amount === expected.amount &&
      (expected.from == null || isAddressEqual(t.from, expected.from)),
  );

  if (match) {
    return {
      status: 'confirmed',
      blockNumber,
      reason: null,
      detail: `Transferred ${formatUsdc(match.amount)} USDC to ${match.to}`,
      actual: match,
    };
  }

  // Work out the most useful explanation, preferring the transfer closest to what was approved.
  const toRecipient = decoded.filter((t) => isAddressEqual(t.to, expected.recipient));
  if (toRecipient.length === 0) {
    const first = decoded[0]!;
    return {
      status: 'mismatch',
      blockNumber,
      reason: 'wrong_recipient',
      detail: `USDC went to ${first.to}, not the approved recipient ${expected.recipient}`,
      actual: first,
    };
  }

  const exactAmount = toRecipient.find((t) => t.amount === expected.amount);
  if (exactAmount) {
    // Right recipient, right amount, wrong sender.
    return {
      status: 'mismatch',
      blockNumber,
      reason: 'wrong_sender',
      detail: `Transfer was sent from ${exactAmount.from}, not the agent wallet ${expected.from}`,
      actual: exactAmount,
    };
  }

  const first = toRecipient[0]!;
  return {
    status: 'mismatch',
    blockNumber,
    reason: 'wrong_amount',
    detail: `Sent ${formatUsdc(first.amount)} USDC, but ${formatUsdc(expected.amount)} USDC was approved`,
    actual: first,
  };
}
