// Usage. Kept as data so `help` and the eventual `manual` cannot drift apart.

import type { Args } from '../lib/argv.ts';
import { hasFlag } from '../lib/argv.ts';
import { writeJson } from '../lib/json-output.ts';
import { PKG_VERSION } from '../lib/pkg.ts';
import { bold, dim } from '../ui/colors.ts';

interface CommandDoc {
  name: string;
  usage: string;
  summary: string;
  implemented: boolean;
}

export const COMMANDS: CommandDoc[] = [
  { name: 'localnet', usage: 'ada localnet <up|down|status|logs>', summary: 'Manage the local devnet', implemented: true },
  { name: 'tip', usage: 'ada tip', summary: 'Current chain tip', implemented: true },
  { name: 'info', usage: 'ada info', summary: 'Active network, endpoints and config location', implemented: true },
  { name: 'config', usage: 'ada config <list|get|set|unset> [key] [value]', summary: 'Persistent configuration', implemented: true },
  { name: 'help', usage: 'ada help [command]', summary: 'This message', implemented: true },
  { name: 'wallet', usage: 'ada wallet <generate|list|use|info|remove>', summary: 'Manage wallets', implemented: false },
  { name: 'balance', usage: 'ada balance [address]', summary: 'ADA and native assets held', implemented: false },
  { name: 'utxos', usage: 'ada utxos [address]', summary: 'Unspent outputs behind a balance', implemented: false },
  { name: 'airdrop', usage: 'ada airdrop <amount>', summary: 'Fund an address from the devnet faucet', implemented: false },
  { name: 'transfer', usage: 'ada transfer <to> <amount>', summary: 'Send ADA', implemented: false },
];

const GLOBAL_FLAGS: Array<[string, string]> = [
  ['--json', 'machine-readable output on stdout, nothing else'],
  ['--network <name>', 'override the configured network for this run'],
  ['--version, -v', 'print the version'],
  ['--help, -h', 'this message'],
];

export default async function help(args: Args): Promise<void> {
  if (hasFlag(args, 'json')) {
    writeJson({
      ok: true,
      version: PKG_VERSION,
      commands: COMMANDS.map(({ name, usage, summary, implemented }) => ({ name, usage, summary, implemented })),
      globalFlags: GLOBAL_FLAGS.map(([flag, description]) => ({ flag, description })),
    });
    return;
  }

  const [topic] = args.positionals;
  if (topic) {
    const doc = COMMANDS.find((c) => c.name === topic);
    if (!doc) {
      process.stderr.write(`no such command: ${topic}\n`);
      process.exitCode = 2;
      return;
    }
    process.stdout.write(`${bold(doc.usage)}\n  ${doc.summary}\n`);
    if (!doc.implemented) process.stdout.write(`  ${dim('not implemented yet')}\n`);
    return;
  }

  const available = COMMANDS.filter((c) => c.implemented);
  const planned = COMMANDS.filter((c) => !c.implemented);
  const width = COMMANDS.reduce((max, c) => Math.max(max, c.name.length), 0);

  const out: string[] = [];
  out.push(bold(`ada ${PKG_VERSION}`) + ' — Cardano CLI wallet');
  out.push('');
  out.push(bold('Usage'));
  out.push('  ada <command> [args] [--flags]');
  out.push('');
  out.push(bold('Commands'));
  for (const c of available) out.push(`  ${c.name.padEnd(width)}  ${c.summary}`);
  if (planned.length) {
    out.push('');
    out.push(bold('Planned'));
    for (const c of planned) out.push(`  ${dim(c.name.padEnd(width))}  ${dim(c.summary)}`);
  }
  out.push('');
  out.push(bold('Global flags'));
  const flagWidth = GLOBAL_FLAGS.reduce((max, [f]) => Math.max(max, f.length), 0);
  for (const [flag, description] of GLOBAL_FLAGS) out.push(`  ${flag.padEnd(flagWidth)}  ${description}`);
  out.push('');

  process.stdout.write(out.join('\n'));
}
