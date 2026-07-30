// The unspent outputs behind a balance.
//
// A first-class command rather than a debugging flag. On this ledger a balance is a
// sum over a set, so when a number looks wrong the next question is always which
// outputs produced it — and the answer should be one command away.

import type { Args } from '../lib/argv.ts';
import { hasFlag } from '../lib/argv.ts';
import { writeJson } from '../lib/json-output.ts';
import { openActive, openNetwork } from '../lib/active-wallet.ts';
import { formatAda, sumLovelace, lovelaceToAda, LOVELACE_UNIT } from '../lib/amount.ts';
import { heading, fields } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

export default async function utxos(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const [target] = args.positionals;
  const isAddress = target?.startsWith('addr') === true;

  const { address, list, networkName, label } = isAddress
    ? await forAddress(args, target)
    : await forWallet(args, target);

  // Sorted by transaction hash then index: a stable order makes two runs
  // diffable, which is part of the output contract.
  const rows = list
    .map((u) => {
      const amount = u.output.amount as Array<{ unit: string; quantity: string }>;
      const lovelace = sumLovelace(amount);
      const assets = amount.filter((a) => a.unit !== LOVELACE_UNIT && a.unit !== '');
      return {
        txHash: u.input.txHash,
        outputIndex: u.input.outputIndex,
        lovelace: lovelace.toString(),
        ada: lovelaceToAda(lovelace),
        assets,
      };
    })
    .sort((a, b) => a.txHash.localeCompare(b.txHash) || a.outputIndex - b.outputIndex);

  const total = rows.reduce((sum, r) => sum + BigInt(r.lovelace), 0n);

  if (json) {
    writeJson({
      network: networkName,
      wallet: isAddress ? null : label,
      address,
      count: rows.length,
      totalLovelace: total.toString(),
      totalAda: lovelaceToAda(total),
      utxos: rows,
    });
    return;
  }

  process.stdout.write(heading(`UTxOs — ${label} (${networkName})`) + '\n');
  process.stdout.write(fields([
    ['count', String(rows.length)],
    ['total', formatAda(total)],
  ]) + '\n');

  if (rows.length === 0) {
    process.stdout.write('\n' + dim('  no unspent outputs — fund it with: ada airdrop <amount>') + '\n');
    return;
  }

  process.stdout.write('\n');
  for (const r of rows) {
    const extra = r.assets.length > 0 ? dim(`  +${r.assets.length} asset(s)`) : '';
    process.stdout.write(`  ${r.txHash}#${r.outputIndex}  ${formatAda(BigInt(r.lovelace))}${extra}\n`);
  }
}

async function forAddress(args: Args, address: string) {
  const { network, provider } = openNetwork(args);
  return {
    address,
    list: await provider.fetchAddressUTxOs(address),
    networkName: network.name,
    label: 'address',
  };
}

async function forWallet(args: Args, name?: string) {
  const ctx = await openActive(args, name);
  return {
    address: ctx.payment,
    list: await ctx.wallet.getUtxos(),
    networkName: ctx.network.name,
    label: ctx.stored.name,
  };
}
