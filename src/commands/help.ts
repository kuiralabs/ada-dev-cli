// Usage. Kept as data so `help` and the eventual `manual` cannot drift apart.

import type { Args } from '../lib/argv.ts';
import { hasFlag } from '../lib/argv.ts';
import { writeJson } from '../lib/json-output.ts';
import { usageError } from '../lib/errors.ts';
import { PKG_VERSION } from '../lib/pkg.ts';
import { EXIT_INVALID_ARGS } from '../lib/exit-codes.ts';
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
  { name: 'wallet', usage: 'ada wallet <generate|list|use|info|remove> [name]', summary: 'Manage wallets', implemented: true },
  { name: 'balance', usage: 'ada balance [wallet|address]', summary: 'ADA and native assets held', implemented: true },
  { name: 'utxos', usage: 'ada utxos [wallet|address]', summary: 'Unspent outputs behind a balance', implemented: true },
  { name: 'airdrop', usage: 'ada airdrop <ada> [--address <addr>]', summary: 'Fund from the devnet faucet', implemented: true },
  { name: 'transfer', usage: 'ada transfer <to> <ada> [--yes]', summary: 'Send ADA — dry run without --yes', implemented: true },
  // Designed in docs/COMMANDS.md and not yet built. Listed so an agent reading
  // this surface learns what is coming instead of concluding the tool is
  // finished — an empty planned list is a claim, and it was a false one.
  { name: 'params', usage: 'ada params', summary: 'Protocol parameters — fee coefficients, min-UTxO, limits', implemented: false },
  { name: 'asset', usage: 'ada asset <mint|send>', summary: 'Native assets and bundles', implemented: false },
  { name: 'swap', usage: 'ada swap <build|inspect|sign|submit>', summary: 'Two-party atomic swap', implemented: false },
  { name: 'address', usage: 'ada address <derive|inspect>', summary: 'Derive or decode an address', implemented: false },
  { name: 'status', usage: 'ada status', summary: 'Overall health of the configured network', implemented: false },
  { name: 'manual', usage: 'ada manual', summary: 'Full reference — every command, every flag', implemented: false },
];

const GLOBAL_FLAGS: Array<[string, string]> = [
  ['--json', 'machine-readable output on stdout, nothing else'],
  ['--network <name>', 'override the configured network for this run'],
  ['--wallet <name>', 'act on a named wallet instead of the active one'],
  ['--yes', 'confirm an action that moves money or deletes keys'],
  ['--version, -v', 'print the version'],
  ['--help, -h', 'this message'],
];

export default async function help(args: Args): Promise<void> {
  const [topic] = args.positionals;

  if (hasFlag(args, 'json')) {
    // A topic must narrow the result. The first version ignored it and returned
    // every command, so an agent asking about one command got ten and had to
    // filter — and an agent asking about a command that does not exist got a
    // success. Both are the kind of quiet wrongness the output contract exists
    // to prevent.
    if (topic) {
      const doc = COMMANDS.find((c) => c.name === topic);
      if (!doc) {
        throw usageError(`no such command: ${topic}`, 'run `ada help --json` for the command list');
      }
      writeJson({ version: PKG_VERSION, command_info: doc });
      return;
    }
    writeJson({
      version: PKG_VERSION,
      commands: COMMANDS.map(({ name, usage, summary, implemented }) => ({ name, usage, summary, implemented })),
      globalFlags: GLOBAL_FLAGS.map(([flag, description]) => ({ flag, description })),
    });
    return;
  }

  if (topic) {
    const doc = COMMANDS.find((c) => c.name === topic);
    if (!doc) {
      process.stderr.write(`no such command: ${topic}\n`);
      process.exitCode = EXIT_INVALID_ARGS;
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
