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
import { probeOgmios } from '../lib/ogmios.ts';
import { dim } from '../ui/colors.ts';
import { listWallets } from '../lib/wallet-store.ts';
import { devnetPid, isProcessAlive, devnetLogPath } from '../lib/yaci.ts';
import { PKG_VERSION } from '../lib/pkg.ts';
import { STALL_AFTER_MS } from '../lib/constants.ts';
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
  const ogmios = await probeOgmios(network);

  // Reachable is not the same as live. A chain whose producer has stopped answers
  // every query and advances nothing — `status` reported healthy through exactly
  // that state, which is the same mistake as treating a running process as a
  // serving API, one level up.
  const stallLimit = network.isLocal ? STALL_AFTER_MS.local : STALL_AFTER_MS.public;
  const tipAgeMs = tip?.time ? Date.now() - tip.time * 1000 : undefined;
  const stalled = reachable && tipAgeMs !== undefined && tipAgeMs > stallLimit;

  const wallets = listWallets();
  const activeWallet = config.activeWallet ?? null;
  const healthy = reachable && !stalled
    && (activeWallet === null || wallets.some((w) => w.name === activeWallet));

  if (json) {
    writeJson({
      version: PKG_VERSION,
      healthy,
      // Reported so its absence is visible rather than inferred. Nothing here
      // requires it; --verify-budget and mempool visibility use it when present.
      ogmios: { reachable: ogmios.reachable, ...(ogmios.url ? { url: ogmios.url } : {}),
                ...(ogmios.version ? { version: ogmios.version } : {}),
                ...(ogmios.reason ? { reason: ogmios.reason } : {}) },
      network: network.name,
      apiUrl: network.apiUrl,
      chainReachable: reachable,
      chainAdvancing: reachable ? !stalled : null,
      ...(stalled ? { stalledForSeconds: Math.round((tipAgeMs ?? 0) / 1000) } : {}),
      ...(reachError ? { chainError: reachError } : {}),
      tip: tip ? { height: tip.height, slot: tip.slot, epoch: tip.epoch, ageSeconds: Math.round((tipAgeMs ?? 0) / 1000) } : null,
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
    ['chain', !reachable
      ? `unreachable at ${network.apiUrl}`
      : stalled
        ? `STALLED — height ${tip?.height ?? '?'}, last block ${Math.round((tipAgeMs ?? 0) / 1000)}s ago`
        : `advancing, height ${tip?.height ?? '?'}`],
    ...(network.isLocal ? [['devnet', processAlive ? `running (pid ${pid})` : 'not running'] as [string, string]] : []),
    // Reported either way on a local chain, and this is the one place that is
    // right. `status` is a health report somebody asked for, so naming an
    // optional component that is not running is information rather than noise —
    // and it is the only place a developer who has never heard of Ogmios will
    // find out it exists. Public networks are not listed: we do not run their
    // infrastructure and an absence there says nothing.
    ...(network.isLocal
      ? [['ogmios', ogmios.reachable
          ? `answering at ${ogmios.url}`
          : dim('not running — optional second opinion on script costs, see docs/DEVNET.md')] as [string, string]]
      : ogmios.reachable ? [['ogmios', `answering at ${ogmios.url}`] as [string, string]] : []),
    ['wallet', activeWallet ?? 'none selected'],
    ['wallets', String(wallets.length)],
  ]) + '\n');

  if (!reachable) {
    process.stdout.write('\n' + warn(network.isLocal
      ? 'start the chain with: ada localnet up'
      : `could not reach ${network.name} — check the endpoint`) + '\n');
  } else if (stalled) {
    process.stdout.write('\n' + warn('the chain answers but is not producing blocks') + '\n');
    process.stdout.write(network.isLocal
      ? '  transactions will sit unconfirmed — restart it: ada localnet down && ada localnet up\n'
      : '  this is unusual on a public network; check its status page\n');
  } else if (activeWallet === null && wallets.length === 0) {
    process.stdout.write('\n' + warn('no wallets yet — create one with: ada wallet generate <name>') + '\n');
  } else if (healthy) {
    process.stdout.write('\n' + ok('ready to transact') + '\n');
  }
}
