// Current chain tip. The simplest end-to-end proof that config, endpoint
// resolution and the chain connection all agree.

import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { loadConfig, resolveNetwork } from '../lib/cli-config.ts';
import { getJson } from '../lib/http.ts';
import { ENDPOINTS } from '../lib/constants.ts';
import { writeJson } from '../lib/json-output.ts';
import { fields, heading } from '../ui/format.ts';

interface LatestBlock {
  height: number | null;
  hash: string;
  slot: number | null;
  epoch: number | null;
  time: number;
  tx_count?: number;
}

export default async function tip(args: Args): Promise<void> {
  const config = loadConfig();
  const network = resolveNetwork(config, flagValue(args, 'network'));

  const block = await getJson<LatestBlock>(network.apiUrl, ENDPOINTS.latestBlock, {
    local: network.isLocal,
  });

  if (hasFlag(args, 'json')) {
    writeJson({
      ok: true,
      network: network.name,
      height: block.height,
      slot: block.slot,
      epoch: block.epoch,
      hash: block.hash,
      time: block.time,
      txCount: block.tx_count ?? null,
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
