// Resolving "which wallet and which network am I acting on" — the preamble almost
// every money command shares.
//
// Extracted because five commands needed the same six steps, and a copy in each
// would drift. It also means the mainnet refusal and the address caching happen
// once rather than per command.

import type { Args } from './argv.ts';
import { flagValue } from './argv.ts';
import { loadConfig, resolveNetwork, type ResolvedNetwork } from './cli-config.ts';
import { configError } from './errors.ts';
import { loadWallet, rememberAddresses, type StoredWallet } from './wallet-store.ts';
import { makeProvider, openWallet, addressesOf, type Provider } from './mesh.ts';
import type { MeshWallet } from '@meshsdk/core';

export interface ActiveContext {
  network: ResolvedNetwork;
  provider: Provider;
  stored: StoredWallet;
  wallet: MeshWallet;
  payment: string;
  stake: string;
}

/**
 * Open the wallet this command should act on: an explicit name if given, otherwise
 * the active one.
 */
export async function openActive(args: Args, explicitName?: string): Promise<ActiveContext> {
  const config = loadConfig();
  const network = resolveNetwork(config, flagValue(args, 'network'));
  const name = explicitName ?? config.activeWallet;
  if (!name) {
    throw configError(
      'no wallet selected',
      'create one with: ada wallet generate <name>, or select one with: ada wallet use <name>',
    );
  }

  const stored = loadWallet(name);
  const provider = makeProvider(network);
  const wallet = await openWallet(stored, network, provider);
  const { payment, stake } = await addressesOf(wallet);
  rememberAddresses(stored, network.name, payment, stake);

  return { network, provider, stored, wallet, payment, stake };
}

/** Network and provider only, for commands that take a raw address. */
export function openNetwork(args: Args): { network: ResolvedNetwork; provider: Provider } {
  const network = resolveNetwork(loadConfig(), flagValue(args, 'network'));
  return { network, provider: makeProvider(network) };
}
