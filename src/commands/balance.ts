// ADA and every native asset held.
//
// Reports both, because a wallet holding tokens and an ADA figure alone is the
// first thing that confuses someone arriving from an account-model chain. The UTxO
// count comes along too: on this ledger a balance is a sum over a set, and knowing
// how many outputs produced it is the first question when a number looks wrong.

import type { Args } from '../lib/argv.ts';
import { hasFlag } from '../lib/argv.ts';
import { writeJson } from '../lib/json-output.ts';
import { openActive, openNetwork } from '../lib/active-wallet.ts';
import { formatAda, lovelaceToAda, sumLovelace, LOVELACE_UNIT } from '../lib/amount.ts';
import { summariseAssets, formatAsset } from '../lib/assets.ts';
import { fields, heading } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

export default async function balance(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const [target] = args.positionals;
  const isAddress = target?.startsWith('addr') === true;

  let label: string;
  let address: string;
  let assets: Array<{ unit: string; quantity: string }>;
  let networkName: string;

  if (isAddress) {
    // A raw address needs no wallet — useful for checking a counterparty or one of
    // the devnet's pre-funded addresses.
    const { network, provider } = openNetwork(args);
    const utxos = await provider.fetchAddressUTxOs(target);
    assets = utxos.flatMap((u) => u.output.amount);
    address = target;
    label = 'address';
    networkName = network.name;
  } else {
    const ctx = await openActive(args, target);
    assets = await ctx.wallet.getBalance();
    address = ctx.payment;
    label = ctx.stored.name;
    networkName = ctx.network.name;
  }

  const lovelace = sumLovelace(assets);
  const native = summariseAssets(assets);

  if (json) {
    writeJson({
      network: networkName,
      wallet: isAddress ? null : label,
      address,
      lovelace: lovelace.toString(),
      ada: lovelaceToAda(lovelace),
      assets: native,
      assetCount: native.length,
    });
    return;
  }

  process.stdout.write(heading(`Balance — ${label} (${networkName})`) + '\n');
  process.stdout.write(fields([
    ['ada', formatAda(lovelace)],
    ['lovelace', lovelace.toString()],
    ['assets', native.length === 0 ? dim('none') : String(native.length)],
    ['address', address],
  ]) + '\n');

  if (native.length > 0) {
    process.stdout.write('\n' + heading('Native assets') + '\n');
    for (const a of native) {
      process.stdout.write(`  ${a.quantity.padStart(12)}  ${formatAsset(a.unit)}\n`);
    }
    process.stdout.write(dim('  names are decoded from the unit; --json carries the full unit') + '\n');
  }
}
