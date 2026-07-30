// ADA <-> lovelace, with integer arithmetic only.
//
// 1 ADA = 1,000,000 lovelace. Every amount is carried as a bigint of lovelace and
// rendered as ADA only for display.
//
// No floating point appears in this file and none may be introduced.
// `parseFloat("0.1") * 1e6` is 100000.00000000001, and a rounding error in a
// money path is the kind of bug a user finds rather than a test.

import { usageError } from './errors.ts';

export const LOVELACE_PER_ADA = 1_000_000n;
const ADA_DECIMALS = 6;

/** The unit name the ledger uses for lovelace in an asset list. */
export const LOVELACE_UNIT = 'lovelace';

/**
 * Parse a human ADA amount into lovelace.
 *
 * Accepts `"1"`, `"1.5"`, `"0.000001"`, and underscores for readability
 * (`"1_000"`). Rejects more than six decimal places rather than silently rounding
 * them away — a truncated amount is a wrong amount.
 */
export function adaToLovelace(input: string): bigint {
  const cleaned = input.trim().replace(/_/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) {
    throw usageError(
      `not a valid ADA amount: ${input}`,
      'expected a positive decimal number, for example 1.5',
    );
  }

  const [whole, fraction = ''] = cleaned.split('.');
  if (fraction.length > ADA_DECIMALS) {
    throw usageError(
      `too many decimal places in ${input}`,
      `ADA has ${ADA_DECIMALS} decimal places; the smallest unit is 0.000001`,
    );
  }

  return BigInt(whole) * LOVELACE_PER_ADA + BigInt(fraction.padEnd(ADA_DECIMALS, '0') || '0');
}

/** Parse a raw lovelace amount. Integer only — lovelace is not divisible. */
export function parseLovelace(input: string): bigint {
  const cleaned = input.trim().replace(/_/g, '');
  if (!/^\d+$/.test(cleaned)) {
    throw usageError(
      `not a valid lovelace amount: ${input}`,
      'lovelace is an integer; pass a decimal amount without --lovelace to use ADA',
    );
  }
  return BigInt(cleaned);
}

/**
 * Render lovelace as ADA, exactly.
 *
 * Trailing zeros are trimmed, so 1_500_000 reads as "1.5" rather than "1.500000",
 * and a whole number carries no decimal point at all.
 */
export function lovelaceToAda(lovelace: bigint): string {
  const negative = lovelace < 0n;
  const value = negative ? -lovelace : lovelace;
  const whole = value / LOVELACE_PER_ADA;
  const fraction = value % LOVELACE_PER_ADA;
  const sign = negative ? '-' : '';
  if (fraction === 0n) return `${sign}${whole}`;
  const fractionText = fraction.toString().padStart(ADA_DECIMALS, '0').replace(/0+$/, '');
  return `${sign}${whole}.${fractionText}`;
}

/** Display form with the unit, for human output. */
export const formatAda = (lovelace: bigint): string => `${lovelaceToAda(lovelace)} ADA`;

/**
 * Sum the lovelace entries of an asset list.
 *
 * Non-lovelace entries are ignored deliberately: native assets are counted
 * separately, because adding a token quantity to a coin balance produces a
 * meaningless number.
 */
export function sumLovelace(assets: ReadonlyArray<{ unit: string; quantity: string }>): bigint {
  return assets
    .filter((a) => a.unit === LOVELACE_UNIT || a.unit === '')
    .reduce((total, a) => total + BigInt(a.quantity), 0n);
}
