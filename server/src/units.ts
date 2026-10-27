import { formatUnits, parseUnits } from 'viem';

export const USDC_DECIMALS = 6;

const DECIMAL_RE = /^\d+(\.\d{1,6})?$/;

/** Parse a human string like "12.5" into USDC base units (12_500_000n). Throws on bad input. */
export function parseUsdc(value: string): bigint {
  const trimmed = value.trim();
  if (!DECIMAL_RE.test(trimmed)) {
    throw new Error(`Invalid USDC amount "${value}": use a decimal with at most 6 places`);
  }
  return parseUnits(trimmed, USDC_DECIMALS);
}

/** Format base units as a human string: 12_500_000n -> "12.5". */
export function formatUsdc(value: bigint): string {
  return formatUnits(value, USDC_DECIMALS);
}

/** Start of the UTC day containing `now`, in epoch milliseconds. */
export function utcDayStart(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}
