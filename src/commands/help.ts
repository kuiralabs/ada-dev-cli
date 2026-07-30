// Usage. Kept as data so `help` and the eventual `manual` cannot drift apart.

import type { Args } from '../lib/argv.ts';
import { hasFlag } from '../lib/argv.ts';
import { writeJson } from '../lib/json-output.ts';
import { usageError } from '../lib/errors.ts';
import { PKG_VERSION } from '../lib/pkg.ts';
import { EXIT_INVALID_ARGS } from '../lib/exit-codes.ts';
import { bold, dim } from '../ui/colors.ts';
import { COMMANDS, GLOBAL_FLAGS, findCommand } from '../lib/reference.ts';

export default async function help(args: Args): Promise<void> {
  const [topic] = args.positionals;

  if (hasFlag(args, 'json')) {
    // A topic must narrow the result. The first version ignored it and returned
    // every command, so an agent asking about one command got ten and had to
    // filter — and an agent asking about a command that does not exist got a
    // success. Both are the kind of quiet wrongness the output contract exists
    // to prevent.
    if (topic) {
      const doc = findCommand(topic);
      if (!doc) {
        throw usageError(`no such command: ${topic}`, 'run `ada help --json` for the command list');
      }
      writeJson({ version: PKG_VERSION, command_info: doc });
      return;
    }
    writeJson({
      version: PKG_VERSION,
      commands: COMMANDS.map(({ name, usage, summary, implemented }) => ({ name, usage, summary, implemented })),
      globalFlags: GLOBAL_FLAGS,
    });
    return;
  }

  if (topic) {
    const doc = findCommand(topic);
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
  const flagWidth = GLOBAL_FLAGS.reduce((max, f) => Math.max(max, f.flag.length), 0);
  for (const f of GLOBAL_FLAGS) out.push(`  ${f.flag.padEnd(flagWidth)}  ${f.description}`);
  out.push('');

  process.stdout.write(out.join('\n'));
}
