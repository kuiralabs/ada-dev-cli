// The only place MeshJS is instantiated.
//
// Same discipline as http.ts and yaci.ts: one file owns one boundary. Commands ask
// for a wallet or a provider and never construct one, so network selection,
// provider choice and the mainnet refusal are decided once.

import { MeshWallet, YaciProvider, BlockfrostProvider, MeshTxBuilder } from '@meshsdk/core';
import type { NetworkName, ResolvedNetwork } from './cli-config.ts';
import { configError, AdaError } from './errors.ts';
import { EXIT_INTERNAL } from './exit-codes.ts';
import { assertNotMainnet, type StoredWallet } from './wallet-store.ts';

/**
 * Cardano's network discriminator: 0 for every test network, 1 for mainnet.
 *
 * Kept as a mapping rather than a boolean so an address built for one network is
 * structurally incapable of being used on another — the type-level property the
 * API design calls for.
 */
export function networkId(network: NetworkName): 0 | 1 {
  return network === 'mainnet' ? 1 : 0;
}

/** What MeshJS calls the network, for the tx builder's cost models. */
export function meshNetworkName(network: NetworkName): 'mainnet' | 'preprod' | 'preview' | 'testnet' {
  switch (network) {
    case 'mainnet': return 'mainnet';
    case 'preprod': return 'preprod';
    case 'preview': return 'preview';
    // A local devnet is its own chain with its own magic; 'testnet' is the closest
    // cost-model set and is what the devkit's own tooling assumes.
    case 'devnet': return 'testnet';
  }
}

export type Provider = YaciProvider | BlockfrostProvider;

/**
 * Build a chain provider for the resolved network.
 *
 * The devnet gets YaciProvider, which takes both the query URL and the control
 * URL — the same two-API split this tool already models, and it is what makes the
 * faucet reachable through the same object.
 *
 * Public networks get BlockfrostProvider, which needs a project key. There is no
 * key handling yet, so this fails with the exact command to configure one rather
 * than producing a provider that will 403 later at a confusing point.
 */
export function makeProvider(network: ResolvedNetwork): Provider {
  if (network.isLocal) {
    return new YaciProvider(`${network.apiUrl}/api/v1/`, network.adminUrl);
  }

  const key = process.env.ADA_BLOCKFROST_KEY;
  if (!key) {
    throw configError(
      `no API key available for ${network.name}`,
      'set ADA_BLOCKFROST_KEY in the environment — a key must never be passed as an argument',
    );
  }
  return new BlockfrostProvider(key);
}

/** The faucet, which only a local devnet has. */
export function faucetOf(provider: Provider): YaciProvider {
  if (!(provider instanceof YaciProvider)) {
    throw configError(
      'this network has no faucet',
      'airdrop only works on the local devnet — you cannot ask a public network for free ADA',
    );
  }
  return provider;
}

/**
 * Build a wallet from a stored mnemonic, ready to query and sign.
 *
 * `init()` is awaited here because every consumer needs it and forgetting it
 * produces confusing empty results rather than an error.
 */
export async function openWallet(
  stored: StoredWallet,
  network: ResolvedNetwork,
  provider: Provider,
): Promise<MeshWallet> {
  assertNotMainnet(network.name);

  const words = stored.mnemonic.trim().split(/\s+/);
  const wallet = new MeshWallet({
    networkId: networkId(network.name),
    fetcher: provider,
    submitter: provider,
    key: { type: 'mnemonic', words },
    accountIndex: stored.accountIndex,
  });

  try {
    await wallet.init();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdaError('wallet_open_failed', `could not open wallet ${stored.name}: ${message}`,
      EXIT_INTERNAL, 'the stored recovery phrase may be corrupt');
  }
  return wallet;
}

export interface TxBuilderOptions {
  /**
   * Only set this when the transaction contains a Plutus script.
   *
   * With an evaluator present, Mesh runs redeemer evaluation on **every** build —
   * including a plain payment that has no redeemers to evaluate. The devnet's
   * evaluate endpoint answers 500 for such a transaction, so a simple transfer
   * failed with "Evaluate redeemers failed" and a wall of CBOR. Omitting the
   * evaluator skips a step a script-free transaction never needed.
   */
  withScripts?: boolean;
}

/** A transaction builder wired to the same provider, so fees and coin selection
 *  use the live protocol parameters rather than defaults. */
export function makeTxBuilder(provider: Provider, opts: TxBuilderOptions = {}): MeshTxBuilder {
  return new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    ...(opts.withScripts ? { evaluator: provider } : {}),
    verbose: false,
  });
}

/** Payment and stake address for a wallet, as a pair, because a Cardano wallet has
 *  both and confusing them produces confident nonsense. */
export async function addressesOf(wallet: MeshWallet): Promise<{ payment: string; stake: string }> {
  const payment = await wallet.getChangeAddress();
  const rewards = await wallet.getRewardAddresses();
  return { payment, stake: rewards[0] ?? '' };
}
