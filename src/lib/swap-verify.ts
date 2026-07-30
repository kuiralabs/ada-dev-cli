// What a swap transaction *actually* does, read from the transaction itself.
//
// This file exists because of a real vulnerability found while testing. An offer
// carries both a transaction and a description of it. The description is written
// by the sender, and the first implementation displayed and signed against the
// description — so editing one field of the JSON produced an offer that read
// "you give 0.000001 ADA" while the transaction took 50.
//
// A received offer is untrusted input, and that includes its account of itself.
// Everything shown to a user or checked before signing is now derived from the
// transaction, with the description treated as an unverified claim to be
// contradicted.

import { cst } from '@meshsdk/core';
import { AdaError } from './errors.ts';
import { EXIT_CHAIN_REJECTED } from './exit-codes.ts';
import { LOVELACE_UNIT } from './amount.ts';
import type { SwapOffer } from './swap-offer.ts';

export type Asset = { unit: string; quantity: string };

export interface NetEffect {
  /** Balance change per asset. Negative means it leaves this address. */
  deltas: Asset[];
  gains: Asset[];
  losses: Asset[];
  /**
   * Everything paid to this address, before subtracting what it put in.
   *
   * Kept separate from the net figures because the two answer different
   * questions, and conflating them produced a verifier that rejected honest
   * offers: an offer promises a **gross** output ("you receive 20 Silk"), while
   * what a user needs to see is the **net** ("your balance falls by 38 ADA and
   * gains 20 Silk"). Checking a gross promise against a net figure fails whenever
   * the receiver also funded part of the transaction, which in a swap is always.
   */
  grossReceived: Asset[];
}

/**
 * The net balance change this transaction causes for one address.
 *
 * Net rather than gross on purpose: an address usually appears on both sides of a
 * swap — its inputs are consumed and its change comes back — so "outputs to you"
 * alone would overstate what you receive by the size of your own change. The
 * number that matters is what your balance does.
 */
export async function netEffectFor(
  txHex: string,
  address: string,
  knownUtxos: ReadonlyArray<{ input: { txHash: string; outputIndex: number }; output: { address: string; amount: Asset[] } }>,
): Promise<NetEffect> {
  // Deserialised directly rather than through the transaction builder's parser:
  // that path is not implemented for this serializer and throws, which fails
  // closed but also blocks every honest offer.
  let body;
  try {
    body = cst.deserializeTx(txHex).body();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdaError(
      'offer_unreadable',
      `the offer's transaction could not be decoded: ${message}`,
      EXIT_CHAIN_REJECTED,
      'do not sign an offer whose transaction cannot be read',
    );
  }

  const totals = new Map<string, bigint>();
  const bump = (unit: string, delta: bigint) =>
    totals.set(unit, (totals.get(unit) ?? 0n) + delta);

  // Inputs belonging to this address leave it. The transaction names inputs by
  // reference only, so their value comes from the chain — which is why the known
  // outputs are passed in rather than taken on the offer's word.
  const byRef = new Map(
    knownUtxos.map((u) => [`${u.input.txHash}#${u.input.outputIndex}`, u]),
  );
  for (const input of body.inputs().values()) {
    const ref = `${input.transactionId().toString()}#${Number(input.index())}`;
    const known = byRef.get(ref);
    if (known?.output.address !== address) continue;
    for (const a of known.output.amount) bump(a.unit, -BigInt(a.quantity));
  }

  // Outputs to this address arrive. Tracked twice: into the net total, and gross,
  // because a promise is expressed in gross terms and a balance change is not.
  const received = new Map<string, bigint>();
  for (const output of body.outputs()) {
    if (output.address().toBech32() !== address) continue;
    const amount = output.amount();
    const coin = BigInt(amount.coin().toString());
    bump(LOVELACE_UNIT, coin);
    received.set(LOVELACE_UNIT, (received.get(LOVELACE_UNIT) ?? 0n) + coin);
    const multi = amount.multiasset();
    if (multi) {
      for (const [assetId, quantity] of multi) {
        const unit = String(assetId);
        const q = BigInt(quantity.toString());
        bump(unit, q);
        received.set(unit, (received.get(unit) ?? 0n) + q);
      }
    }
  }

  const deltas = [...totals]
    .filter(([, q]) => q !== 0n)
    .map(([unit, q]) => ({ unit, quantity: q.toString() }))
    .sort((a, b) => a.unit.localeCompare(b.unit));

  return {
    deltas,
    gains: deltas.filter((d) => BigInt(d.quantity) > 0n),
    losses: deltas
      .filter((d) => BigInt(d.quantity) < 0n)
      .map((d) => ({ unit: d.unit, quantity: (-BigInt(d.quantity)).toString() })),
    grossReceived: [...received]
      .filter(([, q]) => q > 0n)
      .map(([unit, q]) => ({ unit, quantity: q.toString() }))
      .sort((a, b) => a.unit.localeCompare(b.unit)),
  };
}

/**
 * Check the offer's description against what the transaction does.
 *
 * Returns the discrepancies rather than throwing, so `inspect` can show every
 * problem at once while `sign` refuses on any.
 */
export function claimMismatches(offer: SwapOffer, takerEffect: NetEffect): string[] {
  const problems: string[] = [];

  const claimedReceive = normalise(offer.maker.gives);
  const claimedGive = normalise(offer.taker.gives);
  const grossReceived = normalise(takerEffect.grossReceived);
  const netLost = normalise(takerEffect.losses);

  // You must receive at least what was promised. Gross, because that is the form
  // a promise takes.
  for (const [unit, claimed] of claimedReceive) {
    const actual = grossReceived.get(unit) ?? 0n;
    if (actual < claimed) {
      problems.push(
        `the offer promises you ${claimed} of ${short(unit)}, but the transaction pays you ${actual}`,
      );
    }
  }

  // And you must lose no more than you agreed to. Net, because that is what
  // actually leaves your balance — the check that catches an edited description.
  for (const [unit, actual] of netLost) {
    const claimed = claimedGive.get(unit) ?? 0n;
    if (actual > claimed) {
      problems.push(
        claimed === 0n
          ? `the transaction takes ${actual} of ${short(unit)}, which the offer does not mention`
          : `the offer says you give ${claimed} of ${short(unit)}, but the transaction takes ${actual}`,
      );
    }
  }
  return [...new Set(problems)];
}

export function assertClaimsMatch(offer: SwapOffer, takerEffect: NetEffect): void {
  const problems = claimMismatches(offer, takerEffect);
  if (problems.length > 0) {
    throw new AdaError(
      'offer_misrepresented',
      `this offer does not do what it says: ${problems[0]}`,
      EXIT_CHAIN_REJECTED,
      'refuse it — the description and the transaction disagree, which is deliberate or broken',
    );
  }
}

const normalise = (assets: ReadonlyArray<Asset>): Map<string, bigint> => {
  const m = new Map<string, bigint>();
  for (const a of assets) m.set(a.unit, (m.get(a.unit) ?? 0n) + BigInt(a.quantity));
  return m;
};

const short = (unit: string): string =>
  unit === LOVELACE_UNIT ? 'lovelace' : `${unit.slice(0, 12)}…`;
