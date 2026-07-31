// The only place MeshJS is instantiated.
//
// Same discipline as http.ts and yaci.ts: one file owns one boundary. Commands ask
// for a wallet or a provider and never construct one, so network selection,
// provider choice and the mainnet refusal are decided once.

import { MeshWallet, YaciProvider, BlockfrostProvider, KoiosProvider, MeshTxBuilder } from '@meshsdk/core';
import type { OfflineEvaluatorScalus } from '@meshsdk/core-cst';
import type { NetworkName, ResolvedNetwork } from './cli-config.ts';
import { configError, networkError, AdaError } from './errors.ts';
import { EXIT_INTERNAL } from './exit-codes.ts';
import { assertNotMainnet, type StoredWallet } from './wallet-store.ts';
import { dim } from '../ui/colors.ts';
import { resolveSlotConfig, describeSlotConfig } from './slot-config.ts';

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

export type Provider = YaciProvider | BlockfrostProvider | KoiosProvider;

/**
 * Build a chain provider for the resolved network.
 *
 * **No signup is required to use a public network.** Koios is a free,
 * community-run Cardano API and is the default for preprod, preview and mainnet.
 * Requiring an account before a developer can read a testnet balance is a bad
 * first experience, and it is avoidable.
 *
 * Blockfrost stays available as an opt-in for anyone who wants higher rate limits
 * or already has a key: set `ADA_BLOCKFROST_KEY`. In the environment, never as an
 * argument — command lines land in shell history and process listings.
 *
 * The devnet gets YaciProvider, which takes both the query URL and the control
 * URL — the same two-API split this tool already models, and what makes the faucet
 * reachable through the same object.
 */
export function makeProvider(network: ResolvedNetwork): Provider {
  if (network.isLocal) {
    return new YaciProvider(`${network.apiUrl}/api/v1/`, network.adminUrl);
  }

  const blockfrostKey = process.env.ADA_BLOCKFROST_KEY;
  if (blockfrostKey) return new BlockfrostProvider(blockfrostKey);

  // The network-name form is the one that works anonymously. Passing a base URL
  // instead makes the provider send an empty auth header, which Koios rejects with
  // 403 — a confusing failure for something that needs no credentials at all.
  return new KoiosProvider(koiosNetwork(network.name));
}

/** Koios names its networks the same way we do, except mainnet is 'api'. */
function koiosNetwork(name: NetworkName): 'api' | 'preprod' | 'preview' {
  switch (name) {
    case 'mainnet': return 'api';
    case 'preview': return 'preview';
    default: return 'preprod';
  }
}

/** Which provider answered, for reporting. */
export function providerName(provider: Provider): 'yaci' | 'blockfrost' | 'koios' {
  if (provider instanceof YaciProvider) return 'yaci';
  if (provider instanceof BlockfrostProvider) return 'blockfrost';
  return 'koios';
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
   * including a plain payment that has no redeemers to evaluate, which is wasted
   * work and once broke a simple transfer outright. Omitting it skips a step a
   * script-free transaction never needed.
   */
  withScripts?: boolean;
  /** The evaluator, when the transaction contains a script. See {@link makeEvaluator}. */
  evaluator?: OfflineEvaluatorScalus;
  /**
   * The chain's cost models, for the script integrity hash.
   *
   * Required whenever a script runs: the hash is computed over them, so the
   * builder's defaults produce a transaction the ledger refuses.
   */
  costModels?: number[][];
}

export interface CostModelResult {
  models?: number[][];
  /** Why they were not usable, when they were not. */
  rejected?: string;
}

/**
 * Cost models for the chain we are actually on.
 *
 * MeshJS's own `fetchCostModels` is a stub that throws on **both** providers we
 * default to, so without this the builder silently uses its built-in mainnet
 * defaults — and that is not a cosmetic problem. The **script integrity hash**
 * a transaction carries is computed over the cost models of the languages it
 * uses, so wrong models produce a hash the ledger disagrees with and the
 * transaction is rejected with `ScriptIntegrityHashMismatch`. Confirmed on
 * preprod, where the defaults fail and the chain's own models succeed.
 *
 * **The counts vary by network and protocol version.** A devnet from an older
 * genesis reports 166/175/297; preprod reports 332/332/350. An earlier version of
 * this function rejected the larger figures as implausible, on the false premise
 * that the ledger fixes them — that guard would have blocked the very models that
 * make preprod work. Whatever the chain reports about itself is what the chain
 * uses to check the hash.
 *
 * The two providers differ only in key type: Yaki names each parameter, Koios
 * numbers them. Both enumerate in the canonical order, which is what matters.
 */
export async function fetchCostModels(network: ResolvedNetwork): Promise<CostModelResult> {
  const url = network.isLocal
    ? `${network.apiUrl}/api/v1/epochs/latest/parameters`
    : `https://${koiosNetwork(network.name)}.koios.rest/api/v1/epoch_params`;

  let params: Record<string, unknown>;
  try {
    const res = await fetch(url);
    if (!res.ok) return { rejected: `${network.name} answered ${res.status} for protocol parameters` };
    const body = await res.json() as Record<string, unknown> | Record<string, unknown>[];
    // Koios answers with an array of epochs; Yaci with a single object.
    params = (Array.isArray(body) ? body[0] : body) as Record<string, unknown>;
  } catch (err) {
    return { rejected: `could not read cost models from ${network.name}: ${(err as Error).message}` };
  }

  const raw = params?.cost_models as Record<string, Record<string, number>> | undefined;
  if (!raw) return { rejected: `${network.name} returned no cost models` };

  const models = (['PlutusV1', 'PlutusV2', 'PlutusV3'] as const)
    .map((v) => Object.values(raw[v] ?? {}));

  if (models.every((m) => m.length === 0)) {
    return { rejected: `${network.name} returned empty cost models` };
  }

  return { models };
}

/**
 * The script evaluator — offline, on every network.
 *
 * Evaluation means running the Plutus VM to discover the execution budget a
 * script needs, because the ledger requires that budget declared up front: too
 * low and the script aborts mid-execution and forfeits collateral, too high and
 * you overpay or breach the per-transaction cap.
 *
 * We run it in-process rather than asking a provider. Yaci's evaluate endpoint
 * delegates to Ogmios, which the native devkit distribution never installs; Koios
 * can evaluate but cannot supply cost models. One local path avoids branching on
 * provider capability and needs nothing extra installed.
 */
export async function makeEvaluator(
  provider: Provider,
  network: ResolvedNetwork,
): Promise<OfflineEvaluatorScalus> {
  // Imported here rather than at module scope. The evaluator pulls in a whole
  // Plutus VM, and loading it took ~16s — a cost every command touching this file
  // paid, including ones that never evaluate anything.
  const { OfflineEvaluatorScalus } = await import('@meshsdk/core-cst');
  const { models, rejected } = await costModelsFor(network);

  if (rejected) {
    // Not silent: a fallback the caller cannot see is how a wrong number becomes
    // a mystery later.
    process.stderr.write(dim(`  note: using built-in cost models — ${rejected}\n`));
  }

  // **The slot config matters as much as the cost models, and for the same
  // reason.** A validator reads its validity window in POSIX time while the
  // transaction declares it in slots, so a wrong conversion asks the script a
  // different question than the ledger will. MeshJS's `testnet` entry maps every
  // slot to 1970, which is what passing nothing here used to mean.
  let tip: ChainTip | undefined;
  try {
    tip = await fetchTip(provider);
  } catch {
    // Unverifiable rather than wrong; resolveSlotConfig says so.
  }
  const slots = await resolveSlotConfig(network, tip ? { slot: tip.slot, time: tip.time } : undefined);

  if (slots.verified === false) {
    process.stderr.write(dim(`  note: slot conversion — ${describeSlotConfig(slots)}\n`));
  }

  return new OfflineEvaluatorScalus(provider, meshNetworkName(network.name), slots.config, models);
}

/** A transaction builder wired to the same provider, so fees and coin selection
 *  use the live protocol parameters rather than defaults. */
export function makeTxBuilder(provider: Provider, opts: TxBuilderOptions = {}): MeshTxBuilder {
  const b = new MeshTxBuilder({
    fetcher: provider,
    submitter: provider,
    ...(opts.withScripts && opts.evaluator ? { evaluator: opts.evaluator } : {}),
    verbose: false,
  });

  // **The builder needs the chain's cost models, not only the evaluator.**
  //
  // The script integrity hash a transaction carries is computed over the cost
  // models of the languages it uses. Leave the builder to its built-in defaults
  // and the hash disagrees with the ledger's, which rejects the transaction with
  // ScriptIntegrityHashMismatch — regardless of whether the script itself would
  // have passed. This is not the same set the evaluator uses for budgets, and
  // getting one right while leaving the other wrong looks like a validator bug.
  if (opts.costModels) b.setCostModels(opts.costModels);

  return b;
}

export interface ChainTip {
  height: number | null;
  slot: number | null;
  epoch: number | null;
  hash: string;
  time: number;
  txCount: number | null;
}

/**
 * The chain tip, through the provider rather than a raw HTTP call.
 *
 * There must be exactly one path to a public network, and it is the provider —
 * because the provider is the thing that holds the API key. An earlier version
 * fetched the tip over plain HTTP, which worked on the devnet and returned
 * Blockfrost's HTML error page on preprod, surfacing as "Unexpected token '<'".
 *
 * Raw HTTP remains correct for devnet *lifecycle* probes (readiness, port checks):
 * those talk to localhost, need no credentials, and must not require building a
 * provider to answer "is it up yet".
 */
export async function fetchTip(provider: Provider): Promise<ChainTip> {
  // The providers genuinely disagree here, so the difference is handled once, in
  // the file that owns this boundary. Koios is not Blockfrost-shaped: it answers
  // `tip` with an array, and has no `blocks/latest` at all.
  if (provider instanceof KoiosProvider) {
    const rows = (await provider.get('tip')) as Array<Record<string, unknown>>;
    const row = rows[0] ?? {};
    return {
      height: numberOrNull(row.block_no),
      slot: numberOrNull(row.abs_slot),
      epoch: numberOrNull(row.epoch_no),
      hash: String(row.hash ?? ''),
      time: numberOrNull(row.block_time) ?? 0,
      txCount: null, // Koios's tip does not carry it; fetch the block for that.
    };
  }

  const block = (await provider.get('blocks/latest')) as Record<string, unknown>;
  return {
    height: numberOrNull(block.height),
    slot: numberOrNull(block.slot),
    epoch: numberOrNull(block.epoch),
    hash: String(block.hash ?? ''),
    time: numberOrNull(block.time) ?? 0,
    txCount: numberOrNull(block.tx_count),
  };
}

const numberOrNull = (v: unknown): number | null =>
  typeof v === 'number' ? v : v === null || v === undefined ? null : Number(v);

/**
 * Messages Mesh emits that carry no information for a caller of this tool.
 *
 * The devnet provider does not implement `fetchCostModels`, so Mesh logs a stack
 * trace and falls back to defaults on every build. The fallback is correct —
 * `setNetwork()` has already supplied cost models — but a stack trace on every
 * transfer is noise, and noise on a money path teaches people to ignore stderr.
 */
const SUPPRESSED_PROVIDER_WARNINGS = [
  'Failed to fetch cost models',
  'fetchCostModels returned an invalid value',
];

/**
 * Run a build without Mesh's cost-model chatter.
 *
 * Both `console.warn` and `console.error` are filtered: Node routes **warn to
 * stderr as well**, and the first version of this patched only `error` and
 * therefore suppressed nothing. Only the messages listed above are dropped —
 * anything else Mesh says still reaches stderr.
 */
export async function withoutCostModelNoise<T>(run: () => Promise<T>): Promise<T> {
  const isSuppressed = (parts: unknown[]): boolean =>
    typeof parts[0] === 'string' && SUPPRESSED_PROVIDER_WARNINGS.some((m) => (parts[0] as string).includes(m));

  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...parts: unknown[]) => { if (!isSuppressed(parts)) originalWarn(...(parts as [])); };
  console.error = (...parts: unknown[]) => { if (!isSuppressed(parts)) originalError(...(parts as [])); };

  try {
    return await run();
  } finally {
    // Restored in a finally so a thrown build cannot leave the console patched for
    // the rest of the process.
    console.warn = originalWarn;
    console.error = originalError;
  }
}

/** Payment and stake address for a wallet, as a pair, because a Cardano wallet has
 *  both and confusing them produces confident nonsense. */
export async function addressesOf(wallet: MeshWallet): Promise<{ payment: string; stake: string }> {
  const payment = await wallet.getChangeAddress();
  const rewards = await wallet.getRewardAddresses();
  return { payment, stake: rewards[0] ?? '' };
}

/**
 * Cost models, fetched once per network and remembered.
 *
 * Both the evaluator and the transaction builder need them, and the builder needs
 * them for a reason easy to miss: the script integrity hash it computes covers
 * them, so a transaction built with the wrong ones is rejected outright regardless
 * of whether the script would have passed.
 */
const costModelCache = new Map<string, CostModelResult>();

export async function costModelsFor(network: ResolvedNetwork): Promise<CostModelResult> {
  const cached = costModelCache.get(network.name);
  if (cached) return cached;
  const result = await fetchCostModels(network);
  costModelCache.set(network.name, result);
  return result;
}
