// Current chain tip.
//
// Goes through the provider, not a raw HTTP call: the provider is what holds an
// API key, so this is the only shape that works on a public network as well as the
// devnet. See lib/mesh.ts fetchTip.

import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { loadConfig, resolveNetwork } from '../lib/cli-config.ts';
import { makeProvider, fetchTip } from '../lib/mesh.ts';
import { networkError, AdaError } from '../lib/errors.ts';
import { notRunningError } from '../lib/errors.ts';
import { writeJson } from '../lib/json-output.ts';
import { fields, heading } from '../ui/format.ts';

export default async function tip(args: Args): Promise<void> {
  const config = loadConfig();
  const network = resolveNetwork(config, flagValue(args, 'network'));
  const provider = makeProvider(network);

  let block;
  try {
    block = await fetchTip(provider);
  } catch (err) {
    if (err instanceof AdaError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    // A local failure almost always means the devnet is not up, which has a
    // one-command fix; a remote failure does not.
    throw network.isLocal
      ? notRunningError(`cannot reach the devnet at ${network.apiUrl}`, 'start it with: ada localnet up')
      : networkError(`could not read the tip from ${network.name}: ${message}`);
  }

  if (hasFlag(args, 'json')) {
    writeJson({
      network: network.name,
      height: block.height,
      slot: block.slot,
      epoch: block.epoch,
      hash: block.hash,
      time: block.time,
      txCount: block.txCount,
    });
    return;
  }

  process.stdout.write(heading('Chain tip') + '\n');
  process.stdout.write(
    fields([
      ['network', network.name],
      ['height', String(block.height ?? 'unknown')],
      ['slot', String(block.slot ?? 'unknown')],
      ['epoch', String(block.epoch ?? 'unknown')],
      ['hash', block.hash],
    ]) + '\n',
  );
}
