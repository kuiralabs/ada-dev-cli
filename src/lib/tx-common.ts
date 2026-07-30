// Shared transaction concerns.
//
// Extracted after review found the same logic in `transfer` and `asset` with
// divergent behaviour: two copies of the builder's failure-message patterns, two
// sign-and-submit paths with different error handling, and three "no unspent
// outputs" checks with three different messages. A set of related literals spread
// across files needs one source of truth — when the library rewords an error,
// one copy gets fixed and the others silently degrade.

import { getOutputMinLovelace } from '@meshsdk/core';
import { AdaError } from './errors.ts';
import { EXIT_CHAIN_REJECTED } from './exit-codes.ts';
import { lovelaceToAda, LOVELACE_UNIT } from './amount.ts';
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

/** Sign and submit, with one error shape rather than one per command. */
export async function signAndSubmit(ctx: ActiveContext, unsignedTx: string): Promise<string> {
  try {
    return await ctx.wallet.submitTx(await ctx.wallet.signTx(unsignedTx));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdaError(
      'submit_failed',
      `the chain rejected the transaction: ${message}`,
      EXIT_CHAIN_REJECTED,
      'it was valid when built — the chain state may have moved since',
    );
  }
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
