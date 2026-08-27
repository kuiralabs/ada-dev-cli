// Shared transaction concerns.
//
// Extracted after review found the same logic in `transfer` and `asset` with
// divergent behaviour: two copies of the builder's failure-message patterns, two
// sign-and-submit paths with different error handling, and three "no unspent
// outputs" checks with three different messages. A set of related literals spread
// across files needs one source of truth — when the library rewords an error,
// one copy gets fixed and the others silently degrade.

import { getOutputMinLovelace, deserializeAddress, type UTxO } from '@meshsdk/core';
import { AdaError } from './errors.ts';
import { EXIT_CHAIN_REJECTED, EXIT_INVALID_ARGS } from './exit-codes.ts';
import { lovelaceToAda, formatAda, LOVELACE_UNIT } from './amount.ts';
import type { ActiveContext } from './active-wallet.ts';
import type { NetworkName } from './cli-config.ts';

/**
 * Patterns the transaction builder uses to report the two failures that actually
 * happen. Declared once so a library rewording is a single edit rather than a
 * silent regression in whichever file was missed.
 */
const BUILDER_FAILURES = {
  // `UTxO Fully Depleted` is what the builder says when coin selection ran out,
  // which is the same problem in different words — and it is what you get for
  // trying to send your whole balance, something everybody does once.
  insufficientFunds: /insufficient|not enough|UTxO Balance Insufficient|Fully Depleted/i,
  belowMinValue: /minimum|min.?ada|min.?utxo|too small/i,
} as const;

/**
 * Check an address we are about to send value to, properly.
 *
 * Every command that takes a recipient checked `startsWith('addr')` and no more,
 * so a truncated paste — `addr_test1qpf8cud6exc` — passed, reached the
 * transaction builder, and came back as `internal_error`. The tool blamed itself
 * for what was plainly a typo, and the one place that got this right,
 * `address inspect`, had the good message nobody else could reach:
 * **a checksum failure usually means a truncated copy-paste.**
 *
 * Three checks, in the order that gives the most useful answer first: the shape,
 * then the network, then the checksum. Network before checksum deliberately — a
 * mainnet address on a testnet decodes perfectly, so a checksum-first order
 * would report success on the check and leave the real mistake unmentioned.
 */
export function assertRecipient(
  address: string,
  options: { network?: NetworkName; what?: string } = {},
): void {
  const what = options.what ?? 'not a Cardano address';

  if (!address.startsWith('addr')) {
    throw new AdaError('invalid_args', `${what}: ${address}`, EXIT_INVALID_ARGS,
      'expected a bech32 address beginning with addr or addr_test');
  }

  if (options.network && options.network !== 'mainnet' && !address.startsWith('addr_test')) {
    throw new AdaError('invalid_args',
      `that is a mainnet address, but the active network is ${options.network}`,
      EXIT_INVALID_ARGS,
      'use an addr_test... address, or switch networks with --network');
  }

  try {
    deserializeAddress(address);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdaError('invalid_args', `could not decode the address: ${message}`,
      EXIT_INVALID_ARGS,
      'a checksum failure usually means a truncated copy-paste — `ada address inspect` '
      + 'reports what a good one contains');
  }
}

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

/**
 * Sign and submit, with one error shape rather than one per command.
 *
 * `rebuild` is how a caller recovers from a fee the ledger considers too small.
 * The builder computes a fee before it knows what the change output will finally
 * hold, so a transaction whose change carries native assets can be under-priced
 * — observed on a plain transfer from a wallet holding one token: the ledger
 * wanted 189,922 lovelace and the transaction offered 178,041.
 *
 * The node states the figure it requires, so this rebuilds at that price and
 * submits again. Once only: a second refusal is a different problem, and a loop
 * that keeps raising the fee would burn real coin chasing it.
 */
export async function signAndSubmit(
  ctx: ActiveContext,
  unsignedTx: string,
  rebuild?: (feeLovelace: string) => Promise<string>,
): Promise<string> {
  try {
    return await ctx.wallet.submitTx(await ctx.wallet.signTx(unsignedTx));
  } catch (err) {
    const required = requiredFeeFrom(err instanceof Error ? err.message : String(err));
    if (required === undefined || !rebuild) throw translateSubmitFailure(err);

    try {
      const repriced = await rebuild(required);
      return await ctx.wallet.submitTx(await ctx.wallet.signTx(repriced));
    } catch (retryErr) {
      throw translateSubmitFailure(retryErr);
    }
  }
}

/**
 * The fee the ledger says it wanted, when that is why it refused.
 *
 * Three spellings, because nodes of different vintages phrase it differently and
 * this must work on all of them:
 *
 *   FeeTooSmallUTxO (Coin 189922) (Coin 178041)
 *   FeeTooSmallUTxO (Mismatch {mismatchSupplied = Coin 171397, mismatchExpected = Coin 175328})
 *   FeeTooSmallUTxO Mismatch (RelGTEQ) {supplied: Coin 171397, expected: Coin 175328}
 *
 * **The order is not the same.** The positional form puts the required figure
 * first; both Mismatch forms put what was supplied first. Reading positionally
 * across all three would rebuild at the price that was just refused, and the
 * retry would fail identically — so the named forms are matched by name and only
 * the positional one is read by position.
 *
 * Found by running against preprod: the devnet ships an older node, so the
 * positional form was the only one this had ever seen.
 */
export function requiredFeeFrom(message: string): string | undefined {
  if (!/FeeTooSmallUTxO/.test(message)) return undefined;

  // Named first: unambiguous, and says which number is which.
  const named = message.match(/(?:mismatchExpected\s*=\s*|expected:\s*)Coin\s+(\d+)/);
  if (named) return named[1];

  // Positional, older nodes: required then supplied.
  const positional = message.match(/FeeTooSmallUTxO\s*\(Coin\s+(\d+)\)\s*\(Coin\s+(\d+)\)/);
  return positional ? positional[1] : undefined;
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

  const spent = translateInputsSpent(message);
  if (spent) return spent;

  return new AdaError(
    'submit_failed',
    `the chain rejected the transaction: ${summarise(message)}`,
    EXIT_CHAIN_REJECTED,
    'it was valid when built — the chain state may have moved since',
    chainDetail(message),
  );
}

/**
 * The inputs were spent between building and submitting.
 *
 * The commonest rejection there is, and it means something specific and
 * recoverable: another transaction from this wallet is still settling, and the
 * UTxOs it consumed were selected for this one too. Two sends in a row hit it
 * every time on a network with twenty-second blocks.
 *
 * Worth naming rather than leaving in the generic bucket, where it arrived as
 * four hundred characters of `ConwayMempoolFailure` inside four layers of JSON
 * and read like a fault. Nothing is wrong; the answer is to wait a block.
 */
export function translateInputsSpent(message: string): AdaError | undefined {
  if (!/All inputs are spent|BadInputsUTxO|already been included/i.test(message)) return undefined;
  return new AdaError('inputs_already_spent',
    'the outputs this transaction spends have already been spent',
    EXIT_CHAIN_REJECTED,
    'a previous transaction from this wallet is probably still settling and took the same '
    + 'UTxOs — wait for a block and run it again. `ada utxos` shows what is currently spendable');
}

/**
 * The end of a node's complaint, which is where it says what actually happened.
 *
 * A Conway node reporting a script failure writes the reason *last*: the script
 * bytes, then the hash, then the datum and redeemer, and only then the
 * evaluation error and any logs the validator emitted. Every summary that
 * truncates from the front therefore throws away the answer, which is why this
 * takes the tail rather than the head.
 *
 * The message arrives JSON-escaped through the submit API, so it is unescaped
 * first — otherwise it reads as `\\\\nThe PlutusV3 script failed:` and the
 * reader does the decoding by eye.
 */
const MAX_CHAIN_DETAIL = 600;
function chainDetail(message: string): string | undefined {
  const unescaped = message
    .replace(/\\+n/g, '\n')
    .replace(/\\+"/g, '"')
    .replace(/\\+\\/g, '\\')
    // Blobs are stripped wherever they sit, not only when they occupy a line of
    // their own: a node sometimes runs the script bytes into the surrounding
    // prose, and a line-level filter then keeps two thousand characters of
    // base64 and pushes the reason past the length limit.
    .replace(ENCODED_BLOB, '…');

  const meaningful = unescaped
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    // Encoded data: the script, the hash, the raw datum. Named by the line above
    // them, so dropping them loses nothing a reader wanted.
    .filter((l) => !/^"?[A-Za-z0-9+/=]{60,}"?,?$/.test(l))
    .filter((l) => !/^Base64-encoded script bytes:?$/i.test(l));

  if (meaningful.length === 0) return undefined;

  // The reason is neither at the front nor at the very back: a node writes the
  // script bytes first and the cost model last, with the evaluation error
  // between them. So the explaining lines are selected rather than sliced —
  // found by reading a real rejection whose useful sentence sat at character
  // 4,000 of 7,000.
  // Only the lines that genuinely explain, and only the strong signals. Weak
  // ones like "error" match the JSON envelope every rejection is wrapped in, so
  // `detail` filled up with CORS headers and said nothing the message had not.
  const explains = meaningful.filter((l) =>
    EXPLAINS.test(l) && !/^\(?\[?[0-9,\s\]\[]+\)?$/.test(l));

  // Nothing specific to add is a good enough answer. A detail that merely
  // repeats the message costs the reader a second pass for nothing.
  if (explains.length === 0) return undefined;

  const chosen = explains.join('\n');
  return chosen.length > MAX_CHAIN_DETAIL ? `${chosen.slice(0, MAX_CHAIN_DETAIL)}…` : chosen;
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

/**
 * Anything long enough and uniform enough to be encoded data rather than prose.
 *
 * A Conway node reporting a failed script leads with the whole compiled
 * validator in base64 — several thousand characters before it says anything —
 * and puts the evaluation logs and the actual reason at the *end*. Truncating
 * the front therefore kept the one part that explains nothing and dropped the
 * only part that explains anything. Observed on a rejected settle, where the
 * message was cut at four hundred characters of base64.
 */
const ENCODED_BLOB = /[A-Za-z0-9+/=\\]{80,}/g;

/**
 * What counts as an explanation, as opposed to the envelope around one.
 *
 * Deliberately narrow: these are the phrases a Plutus VM uses when it says why
 * it stopped. Anything broader matches the JSON wrapper and the HTTP headers
 * that arrive with every rejection alike.
 */
const EXPLAINS = /terminated|overspending|budget|CekError|evaluation error|trace|logs?:|script failed/i;

function summarise(message: string): string {
  const collapsed = message
    .replace(ENCODED_BLOB, '…')
    .replace(/\s+/g, ' ')
    .trim();
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
      'every transaction pays a fee from the same balance, so the whole of it can never be sent — '
      + 'leave a little behind, or fund the wallet with: ada airdrop 1000',
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
      `collateral needs ${formatAda(requiredLovelace)}; largest pure-ADA UTxO holds ${formatAda(largest)}`,
      EXIT_CHAIN_REJECTED,
      'collateral is a percentage of the fee and is only taken if the script fails');
  }

  return sufficient[0];
}

const lovelaceOf = (u: UTxO): bigint =>
  BigInt(u.output.amount.find((a) => a.unit === LOVELACE_UNIT)?.quantity ?? '0');
