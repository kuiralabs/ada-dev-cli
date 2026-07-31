// The devnet's pre-funded addresses, from its genesis.
//
// The devkit prints these to a log at startup, and scraping a log was rejected
// as too fragile — a format nobody promised to keep. But the same information is
// in the Shelley genesis as `initialFunds`, which the control API serves and
// which is the file the node itself was started from. That is not scraping; it
// is reading the source of truth.

import { AdaError } from './errors.ts';
import { EXIT_NETWORK } from './exit-codes.ts';
import { lovelaceToAda } from './amount.ts';

export interface FundedAddress {
  address: string;
  lovelace: string;
  ada: string;
}

interface ShelleyGenesis {
  initialFunds?: Record<string, number | string>;
  networkMagic?: number;
}

/**
 * Read the pre-funded addresses the devnet started with.
 *
 * `initialFunds` is keyed by the address in its raw binary form, hex-encoded —
 * header byte, payment credential, then staking credential — because that is
 * what the ledger works in. Bech32 is a presentation format, so it is applied
 * here rather than expected there.
 */
export async function fundedAddresses(adminUrl: string): Promise<FundedAddress[]> {
  const url = `${adminUrl.replace(/\/$/, '')}/local-cluster/api/admin/devnet/genesis/shelley`;

  let genesis: ShelleyGenesis;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      throw new AdaError('genesis_unavailable',
        `the devnet control API answered ${res.status} for its Shelley genesis`,
        EXIT_NETWORK, 'is the devnet running? try: ada localnet status');
    }
    genesis = await res.json() as ShelleyGenesis;
  } catch (err) {
    if (err instanceof AdaError) throw err;
    throw new AdaError('genesis_unavailable',
      `could not read the devnet genesis: ${(err as Error).message}`,
      EXIT_NETWORK, 'is the devnet running? try: ada localnet status');
  }

  const funds = genesis.initialFunds ?? {};
  const { Address } = await import('@meshsdk/core-cst');

  const out: FundedAddress[] = [];
  for (const [hex, amount] of Object.entries(funds)) {
    const lovelace = BigInt(amount);
    let address: string;
    try {
      address = Address.fromBytes(Buffer.from(hex, 'hex') as never).toBech32();
    } catch {
      // An entry we cannot decode is reported rather than dropped: a silently
      // shorter list would read as "the devnet has fewer funded addresses".
      address = `(undecodable: ${hex.slice(0, 16)}…)`;
    }
    out.push({ address, lovelace: lovelace.toString(), ada: lovelaceToAda(lovelace) });
  }

  // Richest first: the one you want is almost always the biggest.
  return out.sort((a, b) => Number(BigInt(b.lovelace) - BigInt(a.lovelace)));
}
