// Turning slots into time, correctly, and proving it.
//
// A transaction declares its validity in **slots**; a validator reads that same
// window in **POSIX milliseconds**. Something has to convert, and if it converts
// wrongly nothing fails loudly — the script simply gets asked a different
// question than the ledger will ask, and the two disagree at submission.
//
// That is not hypothetical. MeshJS's built-in config for `testnet` is
// `{ zeroTime: 0, zeroSlot: 0, slotLength: 0 }`, which maps **every slot to
// 1970**. Passing no config, as this tool did, meant a deadline validator
// evaluated against a validity range at time zero: transactions that the node
// would reject were built happily, and transactions the node would accept were
// refused before they were built. Both were observed.
//
// So the config is derived from the chain rather than assumed, and then checked
// against the chain's own tip before it is trusted.

import { SLOT_CONFIG_NETWORK, slotToBeginUnixTime } from '@meshsdk/common';
import type { NetworkName, ResolvedNetwork } from './cli-config.ts';

export interface SlotConfig {
  /** POSIX milliseconds at `zeroSlot`. */
  zeroTime: number;
  zeroSlot: number;
  /** Milliseconds per slot. */
  slotLength: number;
}

export interface SlotConfigResult {
  config: SlotConfig;
  source: 'genesis' | 'built-in';
  /** Whether it predicts the chain's own tip. Undefined when no tip was available. */
  verified?: boolean;
  /** How far the prediction was out, in seconds. */
  driftSeconds?: number;
}

/**
 * A prediction this far from the tip's own timestamp means the config is wrong.
 *
 * A few seconds of slack absorbs the gap between when a block's slot begins and
 * when the indexer records having seen it. Anything larger is not jitter — the
 * failure this exists to catch was off by fifty-six years.
 */
const DRIFT_TOLERANCE_SECONDS = 30;

/** What MeshJS calls the network, for its built-in table. */
const meshName = (n: NetworkName): 'mainnet' | 'preprod' | 'preview' | 'testnet' =>
  n === 'mainnet' ? 'mainnet' : n === 'preprod' ? 'preprod' : n === 'preview' ? 'preview' : 'testnet';

/**
 * The slot config for a chain, derived and then verified.
 *
 * A local devnet has its own genesis, so its config is read from the Shelley
 * genesis the node was actually started from — the control API serves it. Public
 * networks use MeshJS's built-in values, which are correct for preprod today and
 * are verified anyway, because a hard fork is exactly the kind of event that
 * makes a hardcoded table quietly wrong.
 */
export async function resolveSlotConfig(
  network: ResolvedNetwork,
  tip?: { slot: number | null; time: number },
): Promise<SlotConfigResult> {
  const derived = network.isLocal && network.adminUrl
    ? await fromGenesis(network.adminUrl)
    : undefined;

  const config = derived ?? { ...SLOT_CONFIG_NETWORK[meshName(network.name)] };
  const source: SlotConfigResult['source'] = derived ? 'genesis' : 'built-in';

  if (!tip || tip.slot === null) return { config, source };

  // The check: what time does this config say the tip's slot began at, and does
  // the chain agree? One sample is enough — the mapping is linear, so a config
  // that is right at the tip is right everywhere.
  const predicted = slotToBeginUnixTime(tip.slot, { ...config, startEpoch: 0, epochLength: 0 } as never);
  const driftSeconds = Math.round((predicted - tip.time * 1000) / 1000);

  return {
    config, source,
    verified: Math.abs(driftSeconds) <= DRIFT_TOLERANCE_SECONDS,
    driftSeconds,
  };
}

/** Read the Shelley genesis the devnet was started from. */
async function fromGenesis(adminUrl: string): Promise<SlotConfig | undefined> {
  try {
    const url = `${adminUrl.replace(/\/$/, '')}/local-cluster/api/admin/devnet/genesis/shelley`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return undefined;

    const g = await res.json() as { systemStart?: string; slotLength?: number };
    if (!g.systemStart || !g.slotLength) return undefined;

    const zeroTime = Date.parse(g.systemStart);
    if (Number.isNaN(zeroTime)) return undefined;

    // A devnet's genesis is slot zero by construction; there is no preceding era
    // to offset against, which is what `zeroSlot` exists for on a public chain.
    return { zeroTime, zeroSlot: 0, slotLength: g.slotLength * 1000 };
  } catch {
    // No genesis means the built-in is used, and the verification below will say
    // whether that was good enough.
    return undefined;
  }
}

/** A one-line account of what was used and whether it holds up. */
export function describeSlotConfig(r: SlotConfigResult): string {
  const base = `${r.source} (slot ${r.config.slotLength}ms from ${r.config.zeroTime})`;
  if (r.verified === undefined) return `${base}, unverified`;
  return r.verified
    ? `${base}, agrees with the tip`
    : `${base}, DISAGREES with the tip by ${r.driftSeconds}s`;
}
