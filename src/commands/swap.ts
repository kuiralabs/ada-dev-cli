// Two-party atomic swap.
//
// The capability this tool exists for. On Cardano a swap needs **no smart
// contract**: one transaction is built from both parties' inputs and requires both
// signatures, so either both sides move or nothing does. That is a ledger
// primitive, not something to deploy.
//
// The flow, and why it is four commands rather than one:
//
//   build    the maker constructs the transaction and partially signs it
//   inspect  the taker sees exactly what it does — separate from signing on
//            purpose, because a received offer is untrusted input and
//            understanding one must be possible repeatedly, from a script, with
//            no signature anywhere near it
//   sign     the taker adds their signature
//   submit   either party sends it
//
// Transport is not this tool's problem. The offer is a blob; moving it between
// parties is the calling application's decision.

import type { Args } from '../lib/argv.ts';
import { hasFlag, flagValue } from '../lib/argv.ts';
import { writeJson } from '../lib/json-output.ts';
import { usageError, AdaError } from '../lib/errors.ts';
import { EXIT_CHAIN_REJECTED } from '../lib/exit-codes.ts';
import { openActive } from '../lib/active-wallet.ts';
import { makeTxBuilder, meshNetworkName, withoutCostModelNoise } from '../lib/mesh.ts';
import { noUtxosError, translateBuildFailure, assertMeetsMinValue, withMinValue } from '../lib/tx-common.ts';
import { adaToLovelace, lovelaceToAda, formatAda, LOVELACE_UNIT } from '../lib/amount.ts';
import {
  encodeOffer, decodeOffer, isExpired, OFFER_VERSION,
  type SwapOffer,
} from '../lib/swap-offer.ts';
import { netEffectFor, claimMismatches, assertClaimsMatch } from '../lib/swap-verify.ts';
import { fields, heading, ok, warn, emphasis } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

const SUBCOMMANDS = ['build', 'inspect', 'sign', 'submit'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/** How long an offer stays signable. Long enough to have a conversation, short
 *  enough that the chain state it was built against has not moved on. */
const OFFER_TTL_SECONDS = 15 * 60;

type Asset = { unit: string; quantity: string };
type Utxo = Awaited<ReturnType<Awaited<ReturnType<typeof openActive>>['wallet']['getUtxos']>>[number];

export default async function swap(args: Args): Promise<void> {
  const [sub] = args.positionals;
  if (!sub) throw usageError('swap needs a subcommand', `one of: ${SUBCOMMANDS.join(', ')}`);
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw usageError(`unknown swap subcommand: ${sub}`, `one of: ${SUBCOMMANDS.join(', ')}`);
  }
  switch (sub as Subcommand) {
    case 'build': return build(args);
    case 'inspect': return inspect(args);
    case 'sign': return sign(args);
    case 'submit': return submit(args);
  }
}

// ── build ───────────────────────────────────────────────────────────────────

async function build(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const counterparty = flagValue(args, 'with');
  const giveSpec = flagValue(args, 'give');
  const wantSpec = flagValue(args, 'want');

  if (!counterparty || !giveSpec || !wantSpec) {
    throw usageError(
      'swap build needs --with, --give and --want',
      'example: ada swap build --with addr_test1... --give 10ADA --want <policy><hex>:5',
    );
  }
  if (!counterparty.startsWith('addr')) {
    throw usageError(`not a Cardano address: ${counterparty}`);
  }

  const gives = parseAssetSpec(giveSpec);
  const wants = parseAssetSpec(wantSpec);
  const ctx = await openActive(args, flagValue(args, 'wallet'));

  const myUtxos = await ctx.wallet.getUtxos();
  if (myUtxos.length === 0) throw noUtxosError(ctx.stored.name);

  // The counterparty's outputs are public chain data, so the maker can build the
  // whole transaction without the taker being online. That is what makes this a
  // one-round-trip protocol rather than a negotiation.
  const theirUtxos = await ctx.provider.fetchAddressUTxOs(counterparty);
  if (theirUtxos.length === 0) {
    throw new AdaError(
      'counterparty_empty',
      `${counterparty.slice(0, 24)}… holds no unspent outputs`,
      EXIT_CHAIN_REJECTED,
      'they cannot give anything until they hold something',
    );
  }

  const mine = selectFor(myUtxos, gives, 'you');
  const theirs = selectFor(theirUtxos, wants, 'the counterparty');

  const params = await ctx.provider.fetchProtocolParameters();

  // Every output must carry ADA, so an asset-only side is topped up to the floor.
  // The top-up comes out of the giver's pocket, so it is surfaced rather than
  // folded in silently — offering "20 Silk" really offers 20 Silk plus about an ADA.
  const toTaker = withMinValue(counterparty, gives, params.coinsPerUtxoSize);
  const toMaker = withMinValue(ctx.payment, wants, params.coinsPerUtxoSize);

  // The counterparty's leftover has to be returned explicitly: the builder has one
  // change address and it belongs to the maker, who is paying the fee.
  const theirChangeRaw = subtract(theirs.total, toMaker.amount);
  const theirChange = withMinValue(counterparty, theirChangeRaw, params.coinsPerUtxoSize);
  assertMeetsMinValue(counterparty, theirChange.amount, params.coinsPerUtxoSize);

  const builder = makeTxBuilder(ctx.provider);
  for (const u of [...mine.chosen, ...theirs.chosen]) {
    builder.txIn(u.input.txHash, u.input.outputIndex, u.output.amount, u.output.address);
  }
  builder
    .txOut(counterparty, toTaker.amount)      // what the maker gives
    .txOut(ctx.payment, toMaker.amount)       // what the maker receives
    .txOut(counterparty, theirChange.amount)  // the taker's leftover, returned
    .changeAddress(ctx.payment)          // the maker's leftover, and the fee
    .setNetwork(meshNetworkName(ctx.network.name));

  let unsignedTx: string;
  try {
    unsignedTx = await withoutCostModelNoise(() => builder.complete());
  } catch (err) {
    throw translateBuildFailure(err, { what: 'swap' });
  }

  // Guarded like any other command that can cost you something. Building an offer
  // partially signs it, and a partial signature over your inputs is a commitment:
  // anyone who receives the offer and signs completes the swap. Reviewing the
  // figures before that signature exists is the point.
  if (!hasFlag(args, 'yes')) {
    process.stdout.write(heading('Swap offer — not yet signed') + '\n');
    process.stdout.write(fields([
      ['you would give', describe(toTaker.amount)],
      ['you would receive', describe(toMaker.amount)],
      ['counterparty', counterparty],
    ]) + '\n');
    throw usageError(
      'building this offer signs it, committing your side if the counterparty accepts',
      'pass --yes once the figures above are right',
    );
  }

  // Partial: the maker's signature alone does not make this submittable, which is
  // exactly the property that makes an offer safe to hand over.
  const partiallySigned = await ctx.wallet.signTx(unsignedTx, true);
  const now = Math.floor(Date.now() / 1000);

  const offer: SwapOffer = {
    version: OFFER_VERSION,
    network: ctx.network.name,
    tx: partiallySigned,
    maker: { address: ctx.payment, gives: toTaker.amount },
    taker: { address: counterparty, gives: toMaker.amount },
    makerSigned: true,
    createdAt: now,
    expiresAt: now + OFFER_TTL_SECONDS,
  };
  const encoded = encodeOffer(offer);
  const fee = builder.getActualFee();

  if (json) {
    writeJson({
      offer: encoded,
      network: ctx.network.name,
      maker: offer.maker, taker: offer.taker,
      adaAttachedToYourSide: toTaker.adaAttached.toString(),
      feeLovelace: fee.toString(), feeAda: lovelaceToAda(fee),
      expiresAt: new Date(offer.expiresAt * 1000).toISOString(),
      next: 'send the offer to the counterparty — they run `ada swap inspect`, then `ada swap sign`',
    });
    return;
  }

  process.stdout.write(heading('Swap offer built') + '\n');
  process.stdout.write(fields([
    ['you give', describe(toTaker.amount)],
    ['you receive', describe(toMaker.amount)],
    ['counterparty', counterparty],
    ['fee', `${formatAda(fee)} (paid by you)`],
    ['expires', new Date(offer.expiresAt * 1000).toLocaleTimeString()],
  ]) + '\n');
  process.stdout.write('\n' + dim('  send this to the counterparty:\n\n'));
  process.stdout.write(encoded + '\n');
}

// ── inspect ─────────────────────────────────────────────────────────────────

/**
 * What this offer would do, from the reader's point of view.
 *
 * Separate from `sign` on purpose. A received offer is untrusted input: the sender
 * describes it, and the receiver must be able to check that description against the
 * transaction itself, as many times as they like, without a signature anywhere
 * near the operation.
 */
async function inspect(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const offer = decodeOffer(requireOfferArg(args));
  const ctx = await openActive(args, flagValue(args, 'wallet'));

  const expired = isExpired(offer);
  const iAmTaker = offer.taker.address === ctx.payment;
  const iAmMaker = offer.maker.address === ctx.payment;
  const networkMatches = offer.network === ctx.network.name;

  // Everything that would make signing a mistake, gathered rather than thrown, so
  // inspect always answers instead of failing at the first problem.
  const warnings: string[] = [];
  if (expired) warnings.push('this offer has expired and can no longer be signed');
  if (!networkMatches) warnings.push(`built for ${offer.network}, but you are on ${ctx.network.name}`);
  if (!iAmTaker && !iAmMaker) warnings.push('neither side of this offer is your active wallet');
  if (!offer.makerSigned) warnings.push('the maker has not signed — do not sign an unsigned offer');

  // Read from the transaction, not from the offer's account of itself. An offer
  // whose description was edited otherwise reads as a bargain while the
  // transaction takes everything — which is exactly what this command exists to
  // catch.
  const myUtxos = await ctx.wallet.getUtxos();
  const theirUtxos = await ctx.provider.fetchAddressUTxOs(
    iAmTaker ? offer.maker.address : offer.taker.address,
  );
  const effect = await netEffectFor(offer.tx, ctx.payment, [...myUtxos, ...theirUtxos]);
  const youGive = effect.losses;
  const youGet = effect.gains;

  if (iAmTaker) {
    for (const problem of claimMismatches(offer, effect)) {
      warnings.push(`MISREPRESENTED: ${problem}`);
    }
  }

  if (json) {
    writeJson({
      network: offer.network,
      role: iAmTaker ? 'taker' : iAmMaker ? 'maker' : 'observer',
      youGive, youReceive: youGet,
      // Named so it is obvious these came from the transaction rather than from
      // the sender's description.
      derivedFrom: 'transaction',
      claimedByOffer: { youGive: iAmTaker ? offer.taker.gives : offer.maker.gives,
                        youReceive: iAmTaker ? offer.maker.gives : offer.taker.gives },
      makerAddress: offer.maker.address,
      takerAddress: offer.taker.address,
      makerSigned: offer.makerSigned,
      expired,
      expiresAt: new Date(offer.expiresAt * 1000).toISOString(),
      safeToSign: !expired && networkMatches && iAmTaker && offer.makerSigned
        && warnings.every((w) => !w.startsWith('MISREPRESENTED')),
      warnings,
    });
    return;
  }

  process.stdout.write(heading('Swap offer') + '\n');
  process.stdout.write(fields([
    ['network', offer.network],
    ['your role', iAmTaker ? 'taker' : iAmMaker ? 'maker' : 'neither party'],
    ['you give', youGive.length ? describe(youGive) : dim('nothing')],
    ['you receive', youGet.length ? describe(youGet) : dim('nothing')],
    ['maker signed', offer.makerSigned ? 'yes' : 'NO'],
    ['expires', expired ? 'EXPIRED' : new Date(offer.expiresAt * 1000).toLocaleTimeString()],
  ]) + '\n');

  if (warnings.length > 0) {
    process.stdout.write('\n');
    for (const w of warnings) process.stdout.write(warn(w) + '\n');
  } else {
    process.stdout.write('\n' + ok('safe to sign — run: ada swap sign <offer>') + '\n');
  }
}

// ── sign ────────────────────────────────────────────────────────────────────

async function sign(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const offer = decodeOffer(requireOfferArg(args));
  const ctx = await openActive(args, flagValue(args, 'wallet'));

  // Each of these is an adversarial case. They are refused rather than warned
  // about, because by this point a signature is about to exist.
  if (isExpired(offer)) {
    throw new AdaError('offer_expired', 'this offer has expired', EXIT_CHAIN_REJECTED,
      'ask the maker for a fresh one — the chain state it was built against has moved');
  }
  if (offer.network !== ctx.network.name) {
    throw new AdaError('network_mismatch',
      `the offer is for ${offer.network} but you are on ${ctx.network.name}`,
      EXIT_CHAIN_REJECTED, 'switch with --network, or refuse the offer');
  }
  if (!offer.makerSigned) {
    throw new AdaError('maker_not_signed',
      'the maker has not signed this offer',
      EXIT_CHAIN_REJECTED,
      'signing first would let them take your side without giving theirs');
  }
  if (offer.taker.address !== ctx.payment) {
    throw new AdaError('not_the_taker',
      'this offer is not addressed to your active wallet',
      EXIT_CHAIN_REJECTED,
      `it is for ${offer.taker.address.slice(0, 24)}… — select that wallet, or refuse`);
  }
  // The description is checked against the transaction before a signature exists.
  // Everything above this point trusts the offer's metadata; from here nothing
  // does.
  const myUtxos = await ctx.wallet.getUtxos();
  const theirUtxos = await ctx.provider.fetchAddressUTxOs(offer.maker.address);
  const effect = await netEffectFor(offer.tx, ctx.payment, [...myUtxos, ...theirUtxos]);
  assertClaimsMatch(offer, effect);

  if (!hasFlag(args, 'yes')) {
    throw usageError(
      `signing gives up ${describe(effect.losses)} for ${describe(effect.gains)}`,
      'run `ada swap inspect` first, then pass --yes to sign',
    );
  }

  const signed = await ctx.wallet.signTx(offer.tx, true);
  const completed = encodeOffer({ ...offer, tx: signed });

  if (json) {
    writeJson({
      offer: completed,
      signed: true,
      youGave: effect.losses,
      youReceive: effect.gains,
      next: 'submit it with `ada swap submit <offer>` — either party may',
    });
    return;
  }
  process.stdout.write(ok('signed') + '\n');
  process.stdout.write(fields([
    ['you give', describe(effect.losses)],
    ['you receive', describe(effect.gains)],
  ]) + '\n');
  process.stdout.write('\n' + dim('  submit it:\n\n') + completed + '\n');
}

// ── submit ──────────────────────────────────────────────────────────────────

async function submit(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const offer = decodeOffer(requireOfferArg(args));
  const ctx = await openActive(args, flagValue(args, 'wallet'));

  if (isExpired(offer)) {
    throw new AdaError('offer_expired', 'this offer has expired', EXIT_CHAIN_REJECTED,
      'the chain will refuse it — ask for a fresh offer');
  }

  let txHash: string;
  try {
    txHash = await ctx.wallet.submitTx(offer.tx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The most common cause is a missing second signature, which is worth naming
    // rather than leaving as a wall of chain error.
    const missingWitness = /witness|signature|MissingVKey/i.test(message);
    throw new AdaError(
      missingWitness ? 'incomplete_signatures' : 'submit_failed',
      missingWitness
        ? 'the transaction is missing a signature — both parties must sign'
        : `the chain rejected the swap: ${message}`,
      EXIT_CHAIN_REJECTED,
      missingWitness ? 'the taker signs with: ada swap sign <offer> --yes' : undefined,
    );
  }

  if (json) {
    writeJson({ submitted: true, txHash, network: offer.network,
      maker: offer.maker, taker: offer.taker });
    return;
  }
  process.stdout.write(ok(`swap submitted — ${emphasis(txHash)}`) + '\n');
  process.stdout.write('\n  it needs one block to confirm — then: ada balance\n');
}

// ── helpers ─────────────────────────────────────────────────────────────────

function requireOfferArg(args: Args): string {
  const offer = args.positionals[1] ?? flagValue(args, 'offer');
  if (!offer) {
    throw usageError('this subcommand needs an offer', 'pass the blob from `ada swap build`');
  }
  return offer;
}

/**
 * `10ADA` or `<unit>:<qty>`, comma-separated.
 *
 * ADA is spelled out rather than expressed in lovelace because a swap is typed by
 * a human under time pressure, and `10ADA` cannot be misread as 10 lovelace.
 */
export function parseAssetSpec(spec: string): Asset[] {
  const parts = spec.split(',').map((p) => p.trim()).filter((p) => p !== '');
  if (parts.length === 0) throw usageError(`empty asset specification: ${spec}`);

  return parts.map((part) => {
    const ada = /^([\d_]+(?:\.[\d]+)?)\s*ADA$/i.exec(part);
    if (ada) return { unit: LOVELACE_UNIT, quantity: adaToLovelace(ada[1]).toString() };

    const at = part.lastIndexOf(':');
    if (at <= 0) {
      throw usageError(
        `malformed asset: ${part}`,
        'expected `10ADA` or `<policyIdHexName>:<quantity>`',
      );
    }
    const unit = part.slice(0, at);
    const qty = part.slice(at + 1).trim();
    if (!/^\d+$/.test(qty) || BigInt(qty) <= 0n) {
      throw usageError(`not a valid quantity in ${part}`, 'quantities are whole numbers above zero');
    }
    return { unit, quantity: qty };
  });
}

/** Total every asset across a set of outputs. */
export function totalOf(utxos: ReadonlyArray<{ output: { amount: Asset[] } }>): Asset[] {
  const totals = new Map<string, bigint>();
  for (const u of utxos) {
    for (const a of u.output.amount) {
      totals.set(a.unit, (totals.get(a.unit) ?? 0n) + BigInt(a.quantity));
    }
  }
  return [...totals].map(([unit, quantity]) => ({ unit, quantity: quantity.toString() }));
}

/** `a` minus `b`, dropping anything that reaches zero. */
export function subtract(a: Asset[], b: Asset[]): Asset[] {
  const totals = new Map(a.map((x) => [x.unit, BigInt(x.quantity)]));
  for (const x of b) {
    totals.set(x.unit, (totals.get(x.unit) ?? 0n) - BigInt(x.quantity));
  }
  return [...totals]
    .filter(([, q]) => q > 0n)
    .map(([unit, q]) => ({ unit, quantity: q.toString() }))
    .sort((x, y) => x.unit.localeCompare(y.unit));
}

/**
 * Choose enough outputs to cover what a side is giving.
 *
 * Deliberately simple: take outputs until everything required is covered. A
 * cleverer selector would reduce change, and change is not what a swap is
 * optimising for — being obviously correct is.
 */
function selectFor(utxos: Utxo[], required: Asset[], who: string): { chosen: Utxo[]; total: Asset[] } {
  const need = new Map(required.map((a) => [a.unit, BigInt(a.quantity)]));
  const chosen: Utxo[] = [];

  for (const u of utxos) {
    if ([...need.values()].every((q) => q <= 0n)) break;
    let useful = false;
    for (const a of u.output.amount as Asset[]) {
      if (need.has(a.unit) && (need.get(a.unit) ?? 0n) > 0n) useful = true;
    }
    // Always take at least one output: even an asset-only swap needs ADA present
    // to satisfy the minimum-value rule on the returned change.
    if (useful || chosen.length === 0) {
      chosen.push(u);
      for (const a of u.output.amount as Asset[]) {
        if (need.has(a.unit)) need.set(a.unit, (need.get(a.unit) ?? 0n) - BigInt(a.quantity));
      }
    }
  }

  const short = [...need].filter(([, q]) => q > 0n);
  if (short.length > 0) {
    const [unit, missing] = short[0];
    throw new AdaError(
      'insufficient_for_swap',
      `${who} cannot cover the swap: short ${missing} of ${unit === LOVELACE_UNIT ? 'lovelace' : unit}`,
      EXIT_CHAIN_REJECTED,
      who === 'you' ? 'fund the wallet with: ada airdrop 1000' : 'they do not hold enough',
    );
  }
  return { chosen, total: totalOf(chosen) };
}

/** Human rendering of an asset list. */
export function describe(assets: Asset[]): string {
  if (assets.length === 0) return 'nothing';
  return assets
    .map((a) => (a.unit === LOVELACE_UNIT
      ? formatAda(BigInt(a.quantity))
      : `${a.quantity} ${shortUnit(a.unit)}`))
    .join(' + ');
}

/** Policy ids are 56 hex characters; the readable part is the name after it. */
function shortUnit(unit: string): string {
  if (unit.length <= 56) return unit;
  const nameHex = unit.slice(56);
  try {
    const name = Buffer.from(nameHex, 'hex').toString('utf-8');
    return /^[\x20-\x7e]+$/.test(name) ? name : `${unit.slice(0, 12)}…`;
  } catch {
    return `${unit.slice(0, 12)}…`;
  }
}
