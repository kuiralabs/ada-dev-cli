// Rejecting flags nobody implemented.
//
// The parser accepts any `--name` it sees, which is what a dependency-free parser
// does by default. Every command then reads the handful it cares about and ignores
// the rest — so a flag that does not exist costs nothing, changes nothing, and is
// reported as `ok: true`.
//
// That is the same failure the rest of this tool is built to avoid. Three of the
// shapes it takes, all observed:
//
//   ada swap build … --out offer.txt   nothing is written; the offer is lost
//   ada balance --wallett alice        the ACTIVE wallet's balance, labelled ok
//   ada transfer … --yess              no confirmation flag, so nothing is sent
//
// The middle one is the dangerous one: a caller asked about one wallet and was
// told about another, with no indication anything was wrong. For a tool whose
// second audience is a program parsing stdout, silence is the worst answer
// available — which is exactly the argument argv.ts already makes for `--json`
// and for negative numbers. Unknown flags are the general case of it.

import type { Args } from './argv.ts';
import { AdaError } from './errors.ts';
import { EXIT_INVALID_ARGS } from './exit-codes.ts';

/**
 * Accepted everywhere, because every command can be asked to explain itself.
 *
 * `--quiet` and `--verbose` were here and were read by nothing — parsed, ignored,
 * reported as ok. That is the failure this module exists to end, so they are not
 * accepted rather than being documented into existence.
 */
const UNIVERSAL: readonly string[] = ['json', 'help', 'h', 'version', 'v'];

/**
 * Commands that resolve a wallet through `active-wallet`, which reads both
 * `--wallet` and `--network`. Kept separate from the per-command lists because it
 * is a property of the helper rather than of any one command — listing it by hand
 * nineteen times is how the two drift apart.
 */
const WALLET_AWARE: readonly string[] = ['airdrop', 'asset', 'balance', 'contract', 'swap', 'transfer', 'utxos'];

/** Commands that resolve a network but no wallet. */
const NETWORK_AWARE: readonly string[] = [
  'address', 'config', 'info', 'localnet', 'params', 'slot', 'status', 'tip', 'wallet',
];

/**
 * What each command actually reads, by union across its subcommands.
 *
 * Union rather than per-subcommand: it catches every case this exists for — a
 * flag that exists nowhere, a misspelling, a flag borrowed from another command —
 * without the risk that an over-tight list rejects a working invocation. The cost
 * is that `contract build --tx-in …` passes validation and then goes unused, which
 * is a harmless kind of wrong compared with rejecting something correct.
 */
const COMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  address: ['account', 'index', 'role'],
  airdrop: ['address'],
  asset: ['description', 'name', 'qty', 'yes'],
  balance: [],
  config: [],
  contract: [
    'amount', 'blueprint', 'continue', 'continue-datum', 'cross-check', 'datum', 'datum-hash', 'datum-signer',
    'mint', 'mint-redeemer', 'module', 'name', 'params', 'path', 'pay', 'qty', 'read-only',
    'redeemer', 'redeemer-message', 'signer', 'spend', 'to-self', 'tx-in',
    'valid-for', 'valid-from', 'valid-until', 'validator', 'verify-budget', 'yes',
  ],
  hash: ['algo', 'hex'],
  help: [],
  info: [],
  localnet: ['block-time', 'yes'],
  manual: [],
  params: [],
  slot: [],
  status: [],
  swap: ['give', 'offer', 'want', 'with', 'yes'],
  tip: [],
  transfer: ['lovelace', 'yes'],
  utxos: [],
  wallet: ['force', 'show-mnemonic', 'wallet', 'yes'],
};

/** Every flag a command accepts, including the ones it inherits. */
export function acceptedFlags(command: string): readonly string[] | undefined {
  const own = COMMAND_FLAGS[command];
  if (!own) return undefined;
  return [
    ...UNIVERSAL,
    ...(WALLET_AWARE.includes(command) ? ['wallet', 'network'] : []),
    ...(NETWORK_AWARE.includes(command) ? ['network'] : []),
    ...own,
  ];
}

/** Levenshtein distance, iterative single-row. */
function distance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * The closest accepted name, when one is close enough to be worth naming.
 *
 * A distance of two covers the mistakes people actually make — a doubled letter,
 * a transposition, a missing dash — while staying far enough from unrelated names
 * that the suggestion is not noise.
 */
export function nearest(name: string, candidates: readonly string[]): string | undefined {
  const budget = Math.min(2, Math.max(1, Math.floor(name.length / 3)));
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const d = distance(name, candidate);
    if (d <= budget && d < bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Reject any flag the command does not implement.
 *
 * Unknown commands pass through untouched: the dispatcher reports those, and
 * guessing at a flag set for a command that does not exist would replace a clear
 * error with a confusing one.
 */
export function validateFlags(command: string, args: Args): void {
  const accepted = acceptedFlags(command);
  if (!accepted) return;

  const unknown = Object.keys(args.flags).filter((name) => !accepted.includes(name));
  if (unknown.length === 0) return;

  const [first] = unknown;
  const suggestion = nearest(first, accepted);
  const plural = unknown.length > 1;

  throw new AdaError(
    'unknown_flag',
    `${plural ? 'unknown flags' : 'unknown flag'} for \`ada ${command}\`: ${unknown.map((n) => `--${n}`).join(', ')}`,
    EXIT_INVALID_ARGS,
    suggestion
      ? `did you mean --${suggestion}? \`ada ${command} --help\` lists them all`
      : `\`ada ${command} --help\` lists the flags it takes`,
  );
}
