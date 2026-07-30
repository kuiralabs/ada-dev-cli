// The one command table.
//
// Both entry points — the CLI and the MCP server — dispatch from here. They each
// had their own copy, and they diverged exactly as you would expect: `asset` and
// `swap` were added to the CLI's table and not the server's, so seven MCP tools
// routed to commands the server could not load and failed with `internal_error`.
//
// The tools were tested, the commands were tested, and the wiring between them was
// not. One table removes the class of bug rather than the instance.

import type { Args } from './argv.ts';

export type CommandModule = { default: (args: Args) => Promise<void> };
export type CommandLoader = () => Promise<CommandModule>;

export const COMMAND_LOADERS: Record<string, CommandLoader> = {
  localnet: () => import('../commands/localnet.ts'),
  wallet: () => import('../commands/wallet.ts'),
  balance: () => import('../commands/balance.ts'),
  utxos: () => import('../commands/utxos.ts'),
  airdrop: () => import('../commands/airdrop.ts'),
  transfer: () => import('../commands/transfer.ts'),
  asset: () => import('../commands/asset.ts'),
  swap: () => import('../commands/swap.ts'),
  tip: () => import('../commands/tip.ts'),
  params: () => import('../commands/params.ts'),
  address: () => import('../commands/address.ts'),
  status: () => import('../commands/status.ts'),
  info: () => import('../commands/info.ts'),
  config: () => import('../commands/config.ts'),
  help: () => import('../commands/help.ts'),
  manual: () => import('../commands/manual.ts'),
};

export const commandNames = (): string[] => Object.keys(COMMAND_LOADERS).sort();
export const loaderFor = (name: string): CommandLoader | undefined => COMMAND_LOADERS[name];
