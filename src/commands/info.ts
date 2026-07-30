// What the tool thinks its world looks like: active network, resolved
// endpoints, config location, devnet reachability. The first thing to run when
// something behaves unexpectedly.

import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { loadConfig, resolveNetwork, configPath } from '../lib/cli-config.ts';
import { writeJson } from '../lib/json-output.ts';
import { isReachable } from '../lib/http.ts';
import { ENDPOINTS } from '../lib/constants.ts';
import { PKG_VERSION } from '../lib/pkg.ts';
import { fields, heading } from '../ui/format.ts';

export default async function info(args: Args): Promise<void> {
  const config = loadConfig();
  const network = resolveNetwork(config, flagValue(args, 'network'));
  const reachable = await isReachable(network.apiUrl, ENDPOINTS.latestBlock);

  if (hasFlag(args, 'json')) {
    writeJson({
      ok: true,
      version: PKG_VERSION,
      network: network.name,
      apiUrl: network.apiUrl,
      adminUrl: network.adminUrl ?? null,
      apiReachable: reachable,
      activeWallet: config.activeWallet ?? null,
      configPath: configPath(),
    });
    return;
  }

  process.stdout.write(heading(`ada ${PKG_VERSION}`) + '\n');
  process.stdout.write(
    fields([
      ['network', network.name],
      ['api', `${network.apiUrl} (${reachable ? 'reachable' : 'unreachable'})`],
      ['wallet', config.activeWallet ?? 'none set'],
      ['config', configPath()],
    ]) + '\n',
  );
}
