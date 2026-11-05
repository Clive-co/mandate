import {
  TransactionReceiptNotFoundError,
  erc20Abi,
  isAddressEqual,
  parseEventLogs,
  type Address,
  type Hash,
  type TransactionReceipt,
} from 'viem';
import type { ReconStatus } from './types';
import { formatUsdc } from './units';

/** The slice of viem's PublicClient we need. Keeping it narrow makes tests trivial. */
export interface ReceiptClient {
  getTransactionReceipt(args: { hash: Hash }): Promise<TransactionReceipt>;
}

/** What the verdict says should have been paid. */
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

export interface ReconcileResult {
  status: ReconStatus;
  blockNumber: bigint | null;
  /** Machine-readable reason when status is `mismatch`. */
  reason: MismatchReason | null;
  /** Human-readable summary. */
  detail: string;
  /** The transfer that matched, or the closest candidate when there is a mismatch. */
  actual: { from: Address; to: Address; amount: bigint } | null;
}

/**
 * Fetch a transaction receipt, decode its USDC Transfer events, and compare them to the verdict.
 *
 *   receipt not found yet         -> pending
 *   reverted                      -> mismatch (tx_reverted)
 *   no USDC Transfer in the logs  -> mismatch (no_usdc_transfer)
 *   transfer(s) found, none fit   -> mismatch (wrong_recipient | wrong_amount | wrong_sender)
 *   a transfer fits exactly       -> matched
 *
 * Why it is written this way:
 *  - `parseEventLogs` decodes by event signature only; it does NOT check which contract emitted
 *    the log, and anyone can deploy a contract that emits a lookalike `Transfer`. So we filter on
 *    `log.address === token` ourselves.
 *  - Amounts are bigint (the log's `value` is a uint256), compared with `===`. No floats, no rounding.
 *  - One transaction can hold several transfers (routers, batching): any one that fits exactly is
 *    enough, but the amount must be EXACTLY the verdict's, not "at least".
 *  - A network error is not a verdict about the payment: it propagates, and nothing is recorded.
 */
export async function reconcileTransfer(
  client: ReceiptClient,
  txHash: Hash,
  expected: ExpectedTransfer,
): Promise<ReconcileResult> {
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
    throw err;
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

  const decoded = transfers.map((t) => ({ from: t.args.from, to: t.args.to, amount: t.args.value }));

  const match = decoded.find(
    (t) =>
      isAddressEqual(t.to, expected.recipient) &&
      t.amount === expected.amount &&
      (expected.from == null || isAddressEqual(t.from, expected.from)),
  );
  if (match) {
    return {
      status: 'matched',
      blockNumber,
      reason: null,
      detail: `Transferred ${formatUsdc(match.amount)} USDC to ${match.to}`,
      actual: match,
    };
  }

  // No exact match: explain the most informative way it differs.
  const toRecipient = decoded.filter((t) => isAddressEqual(t.to, expected.recipient));
  if (toRecipient.length === 0) {
    const first = decoded[0]!;
    return {
      status: 'mismatch',
      blockNumber,
      reason: 'wrong_recipient',
      detail: `USDC went to ${first.to}, not the authorized recipient ${expected.recipient}`,
      actual: first,
    };
  }

  const exactAmount = toRecipient.find((t) => t.amount === expected.amount);
  if (exactAmount) {
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
    detail: `Sent ${formatUsdc(first.amount)} USDC, but ${formatUsdc(expected.amount)} USDC was authorized`,
    actual: first,
  };
}
