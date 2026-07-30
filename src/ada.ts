// ada-wallet-cli entry point.
// Usage: ada <command> [args] [--flags]
//
// Commands are loaded by dynamic import so a single fast command does not pay
// the parse cost of every other one.

import { parseArgs, hasFlag } from './lib/argv.ts';
import { toAdaError } from './lib/errors.ts';
import { EXIT_INVALID_ARGS } from './lib/exit-codes.ts';
import { writeJsonError, setCurrentCommand } from './lib/json-output.ts';
import { PKG_VERSION } from './lib/pkg.ts';
import { errorBlock } from './ui/format.ts';

type CommandModule = { default: (args: ReturnType<typeof parseArgs>) => Promise<void> };

const COMMAND_LOADERS: Record<string, () => Promise<CommandModule>> = {
  localnet: () => import('./commands/localnet.ts'),
  wallet: () => import('./commands/wallet.ts'),
  balance: () => import('./commands/balance.ts'),
  utxos: () => import('./commands/utxos.ts'),
  airdrop: () => import('./commands/airdrop.ts'),
  transfer: () => import('./commands/transfer.ts'),
  tip: () => import('./commands/tip.ts'),
  params: () => import('./commands/params.ts'),
  address: () => import('./commands/address.ts'),
  status: () => import('./commands/status.ts'),
  info: () => import('./commands/info.ts'),
  config: () => import('./commands/config.ts'),
  help: () => import('./commands/help.ts'),
};

const args = parseArgs();
const jsonMode = hasFlag(args, 'json');

if (hasFlag(args, 'version') || hasFlag(args, 'v')) {
  process.stdout.write(PKG_VERSION + '\n');
  process.exit(0);
}

// `--help` anywhere routes to help rather than to the named command, so a
// half-remembered invocation explains itself instead of doing something.
if (hasFlag(args, 'help') || hasFlag(args, 'h')) {
  args.positionals = args.command ? [args.command] : [];
  args.command = 'help';
}

const command = args.command ?? 'help';
// Stamped once so every document this run emits carries it.
setCurrentCommand(command);
const loader = COMMAND_LOADERS[command];

if (!loader) {
  const message = `unknown command: ${command}`;
  const hint = 'run `ada help` for the command list';
  if (jsonMode) writeJsonError('unknown_command', message, hint);
  else process.stderr.write(errorBlock(message, hint) + '\n');
  process.exit(EXIT_INVALID_ARGS);
}

try {
  const mod = await loader();
  await mod.default(args);
} catch (err) {
  const adaErr = toAdaError(err);
  if (jsonMode) {
    writeJsonError(adaErr.code, adaErr.message, adaErr.hint);
  } else {
    process.stderr.write(errorBlock(adaErr.message, adaErr.hint) + '\n');
  }
  process.exit(adaErr.exitCode);
}
