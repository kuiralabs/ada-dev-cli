// Shared transaction concerns.
//
// Extracted after review found the same logic in `transfer` and `asset` with
// divergent behaviour: two copies of the builder's failure-message patterns, two
// sign-and-submit paths with different error handling, and three "no unspent
// outputs" checks with three different messages. A set of related literals spread
// across files needs one source of truth — when the library rewords an error,
// one copy gets fixed and the others silently degrade.

import { getOutputMinLovelace, type UTxO } from '@meshsdk/core';
import { AdaError } from './errors.ts';
import { EXIT_CHAIN_REJECTED } from './exit-codes.ts';
import { lovelaceToAda, formatAda, LOVELACE_UNIT } from './amount.ts';
import type { ActiveContext } from './active-wallet.ts';

/**
 * Patterns the transaction builder uses to report the two failures that actually
 * happen. Declared once so a library rewording is a single edit rather than a
 * silent regression in whichever file was missed.
 */
const BUILDER_FAILURES = {
  insufficientFunds: /insufficient|not enough|UTxO Balance Insufficient/i,
  belowMinValue: /minimum|min.?ada|min.?utxo|too small/i,
} as const;

export function noUtxosError(walletName: string): AdaError {
  return new AdaError(
    'no_utxos',
    `wallet ${walletName} has no unspent outputs to spend`,
    EXIT_CHAIN_REJECTED,
    'fund it with: ada airdrop 1000',
  );
}

/**
 * Reject an output the ledger will reject, *before* submitting.
 *
 * Found by review: sending one lovelace built cleanly, reported `ok` in the dry
 * run, and was refused by the chain on submit. A dry run whose whole purpose is
 * "see what will happen" must not approve something that cannot happen.
 *
 * The floor is computed by the library's own calculator against the live
 * protocol parameter rather than approximated, because it depends on the
 * serialized size of the specific output — an output carrying assets needs more
 * than a plain one.
 */
export function assertMeetsMinValue(
  address: string,
  amount: ReadonlyArray<{ unit: string; quantity: string }>,
  coinsPerUtxoSize: number,
): void {
  const required = getOutputMinLovelace({ address, amount: [...amount] }, coinsPerUtxoSize);
  const provided = amount
    .filter((a) => a.unit === LOVELACE_UNIT || a.unit === '')
    .reduce((total, a) => total + BigInt(a.quantity), 0n);

  if (provided < required) {
    throw new AdaError(
      'output_below_min_value',
      `an output of ${lovelaceToAda(provided)} ADA is below the ledger minimum of `
      + `${lovelaceToAda(required)} ADA for an output of this size`,
      EXIT_CHAIN_REJECTED,
      `send at least ${lovelaceToAda(required)} ADA — every output must hold a minimum `
      + 'proportional to its size, and one carrying assets needs more than a plain one',
    );
  }
}

/**
 * Top an output up to the ledger's minimum, returning what was added.
 *
 * Every Cardano output must carry ADA, so an asset-only output is invalid. When a
 * caller constructs outputs explicitly — as a swap does — nothing attaches that
 * ADA for them, and the transaction fails on a rule the user never asked about.
 *
 * The top-up is returned separately rather than folded in silently: the ADA comes
 * out of the giver's pocket, so both sides need to see it. Someone offering "20
 * Silk" is really offering 20 Silk plus roughly one ADA, and hiding that would
 * make the offer a lie by omission.
 */
export function withMinValue(
  address: string,
  amount: ReadonlyArray<{ unit: string; quantity: string }>,
  coinsPerUtxoSize: number,
): { amount: Array<{ unit: string; quantity: string }>; adaAttached: bigint } {
  const present = amount
    .filter((a) => a.unit === LOVELACE_UNIT || a.unit === '')
    .reduce((total, a) => total + BigInt(a.quantity), 0n);

  // Computed against a candidate that already holds the floor, because the
  // required minimum depends on the serialized size and a zero-lovelace entry
  // serializes smaller than a real one.
  const others = amount.filter((a) => a.unit !== LOVELACE_UNIT && a.unit !== '');
  const probe = [{ unit: LOVELACE_UNIT, quantity: '1000000' }, ...others];
  const required = getOutputMinLovelace({ address, amount: probe }, coinsPerUtxoSize);

  if (present >= required) {
    return { amount: [...amount], adaAttached: 0n };
  }
  return {
    amount: [{ unit: LOVELACE_UNIT, quantity: required.toString() }, ...others],
    adaAttached: required - present,
  };
}

/** Sign and submit, with one error shape rather than one per command. */
export async function signAndSubmit(ctx: ActiveContext, unsignedTx: string): Promise<string> {
  try {
    return await ctx.wallet.submitTx(await ctx.wallet.signTx(unsignedTx));
  } catch (err) {
    throw translateSubmitFailure(err);
  }
}

/**
 * Shape a chain rejection into something readable.
 *
 * A Cardano node's rejections arrive as a Haskell error value serialised through
 * four layers of JSON — several thousand characters of source locations and era
 * summaries around a handful of useful words. Emitting that verbatim is bad for a
 * person and worse for an agent, whose context it floods.
 *
 * So: translate the ones we recognise, and truncate the rest while keeping the
 * beginning, which is where the error constructor sits.
 */
export function translateSubmitFailure(err: unknown): AdaError {
  const message = err instanceof Error ? err.message : String(err);

  const horizon = translateHorizon(message);
  if (horizon) return horizon;

  return new AdaError(
    'submit_failed',
    `the chain rejected the transaction: ${summarise(message)}`,
    EXIT_CHAIN_REJECTED,
    'it was valid when built — the chain state may have moved since',
  );
}

/**
 * A validity bound the chain cannot place in time.
 *
 * A node knows the slot schedule only a bounded distance ahead; past the next
 * hard-fork boundary the slot-to-time mapping is unknowable, so it refuses rather
 * than guessing. That horizon is short on a devnet with small epochs and roughly
 * a day and a half on mainnet — so a window that is fine in production can be
 * rejected locally, which is exactly the confusion worth removing.
 */
export function translateHorizon(message: string): AdaError | undefined {
  if (!/PastHorizon|TimeTranslation/i.test(message)) return undefined;
  const slot = message.match(/SlotNo (\d+)/)?.[1];
  return new AdaError('validity_past_horizon',
    slot
      ? `slot ${slot} is further ahead than this chain can place in time`
      : 'the validity window reaches further ahead than this chain can place in time',
    EXIT_CHAIN_REJECTED,
    'a node knows the slot schedule only a bounded distance ahead — shorten the window with '
    + '--valid-for, or set --valid-until nearer the tip. The limit is much shorter on a devnet '
    + 'than on a public network');
}

/** Keep the first line and the leading text; drop the wall of source locations. */
const MAX_CHAIN_ERROR = 400;
function summarise(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_CHAIN_ERROR
    ? `${collapsed.slice(0, MAX_CHAIN_ERROR)}… (${collapsed.length} chars, truncated)`
    : collapsed;
}

/**
 * Turn a builder failure into something actionable.
 *
 * `context` names what was being attempted, so one function serves a transfer, a
 * mint and an asset send without three copies of the same regexes.
 */
export function translateBuildFailure(
  err: unknown,
  context: { what: string; detail?: string; minValueHint?: string },
): AdaError {
  const message = err instanceof Error ? err.message : String(err);

  if (BUILDER_FAILURES.insufficientFunds.test(message)) {
    return new AdaError(
      'insufficient_funds',
      context.detail ?? `not enough ADA to cover the ${context.what} and its fee`,
      EXIT_CHAIN_REJECTED,
      'fund the wallet with: ada airdrop 1000',
    );
  }

  if (BUILDER_FAILURES.belowMinValue.test(message)) {
    return new AdaError(
      'output_below_min_value',
      `an output is below the ledger's minimum value: ${message}`,
      EXIT_CHAIN_REJECTED,
      context.minValueHint
        ?? 'every output must hold a minimum amount of ADA proportional to its size',
    );
  }

  return new AdaError(
    'build_failed',
    `could not build the ${context.what}: ${message}`,
    EXIT_CHAIN_REJECTED,
  );
}

/**
 * Pick a UTxO to pledge as collateral for a script transaction.
 *
 * Collateral is forfeited only when a script fails *after* passing the ledger's
 * cheap checks — the chain's defence against being spammed with expensive
 * failures. It must be **pure ADA**: an output carrying native assets does not
 * qualify.
 *
 * That last rule is the trap. A wallet that has minted or received any token may
 * have every output carrying one, at which point every script transaction fails
 * for a reason that looks nothing like its cause. So the error says how to make a
 * suitable UTxO rather than only what was missing.
 */
export interface CollateralParams {
  minFeeA: number;
  minFeeB: number;
  maxTxSize: number;
  collateralPercent: number;
}

/**
 * How much collateral a script transaction must pledge.
 *
 * Derived from the chain's own parameters rather than picked: the ledger requires
 * `collateralPercent` of the fee, and the largest fee a transaction could carry is
 * bounded by the linear fee model at the maximum transaction size. Pledging
 * against that bound means the number is always sufficient and never invented.
 *
 * Collateral is not spent on success — it is only forfeited when a script fails
 * after the ledger's cheap checks pass — so erring high costs nothing but a
 * temporarily unavailable UTxO.
 */
export function requiredCollateral(p: CollateralParams): bigint {
  const maxFee = BigInt(Math.ceil(p.minFeeA * p.maxTxSize + p.minFeeB));
  return (maxFee * BigInt(Math.ceil(p.collateralPercent)) + 99n) / 100n;
}

export function selectCollateral(utxos: UTxO[], requiredLovelace: bigint): UTxO {
  const pure = utxos.filter(
    (u) => u.output.amount.length === 1 && u.output.amount[0].unit === LOVELACE_UNIT,
  );

  if (pure.length === 0) {
    throw new AdaError('no_collateral',
      'no pure-ADA UTxO available to pledge as collateral',
      EXIT_CHAIN_REJECTED,
      'every output in this wallet carries a native asset. Send yourself some ADA '
      + 'to create one: ada transfer <your-address> 5 --yes');
  }

  // Smallest that clears the requirement, so a large output is not tied up.
  const sufficient = pure
    .filter((u) => lovelaceOf(u) >= requiredLovelace)
    .sort((a, b) => Number(lovelaceOf(a) - lovelaceOf(b)));

  if (sufficient.length === 0) {
    const largest = pure.map(lovelaceOf).reduce((a, b) => (a > b ? a : b), 0n);
    throw new AdaError('insufficient_collateral',
      `collateral needs ${formatAda(requiredLovelace)} ADA; largest pure-ADA UTxO holds ${formatAda(largest)}`,
      EXIT_CHAIN_REJECTED,
      'collateral is a percentage of the fee and is only taken if the script fails');
  }

  return sufficient[0];
}

const lovelaceOf = (u: UTxO): bigint =>
  BigInt(u.output.amount.find((a) => a.unit === LOVELACE_UNIT)?.quantity ?? '0');
