// One command that answers "is everything actually working".
//
// Composes what info, tip and localnet status each report separately, because when
// something is wrong the useful question is not "which of three commands should I
// run" — it is "what is broken". Never throws for an unreachable chain: an
// unreachable chain is the answer, not an error.

import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { loadConfig, resolveNetwork, configPath } from '../lib/cli-config.ts';
import { makeProvider, fetchTip } from '../lib/mesh.ts';
import { writeJson } from '../lib/json-output.ts';
import { listWallets } from '../lib/wallet-store.ts';
import { devnetPid, isProcessAlive, devnetLogPath } from '../lib/yaci.ts';
import { PKG_VERSION } from '../lib/pkg.ts';
import { fields, heading, ok, warn } from '../ui/format.ts';

export default async function status(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const config = loadConfig();
  const network = resolveNetwork(config, flagValue(args, 'network'));

  // Reported separately on purpose: a live process with a dead API and a dead
  // process both mean "not usable", but only one of them means "wait a moment".
  const pid = network.isLocal ? devnetPid() : undefined;
  const processAlive = pid !== undefined && isProcessAlive(pid);

  let tip: Awaited<ReturnType<typeof fetchTip>> | undefined;
  let reachError: string | undefined;
  try {
    tip = await fetchTip(makeProvider(network));
  } catch (err) {
    reachError = err instanceof Error ? err.message : String(err);
  }

  const reachable = tip !== undefined;
  const wallets = listWallets();
  const activeWallet = config.activeWallet ?? null;
  const healthy = reachable && (activeWallet === null || wallets.some((w) => w.name === activeWallet));

  if (json) {
    writeJson({
      version: PKG_VERSION,
      healthy,
      network: network.name,
      apiUrl: network.apiUrl,
      chainReachable: reachable,
      ...(reachError ? { chainError: reachError } : {}),
      tip: tip ? { height: tip.height, slot: tip.slot, epoch: tip.epoch } : null,
      devnet: network.isLocal
        ? { processAlive, pid: pid ?? null, logPath: devnetLogPath() }
        : null,
      activeWallet,
      walletCount: wallets.length,
      configPath: configPath(),
    });
    return;
  }

  process.stdout.write(heading(`ada ${PKG_VERSION} — ${healthy ? 'healthy' : 'not ready'}`) + '\n');
  process.stdout.write(fields([
    ['network', network.name],
    ['chain', reachable ? `reachable, height ${tip?.height ?? '?'}` : `unreachable at ${network.apiUrl}`],
    ...(network.isLocal ? [['devnet', processAlive ? `running (pid ${pid})` : 'not running'] as [string, string]] : []),
    ['wallet', activeWallet ?? 'none selected'],
    ['wallets', String(wallets.length)],
  ]) + '\n');

  if (!reachable) {
    process.stdout.write('\n' + warn(network.isLocal
      ? 'start the chain with: ada localnet up'
      : `could not reach ${network.name} — check the endpoint and API key`) + '\n');
  } else if (activeWallet === null && wallets.length === 0) {
    process.stdout.write('\n' + warn('no wallets yet — create one with: ada wallet generate <name>') + '\n');
  } else if (healthy) {
    process.stdout.write('\n' + ok('ready to transact') + '\n');
  }
}
