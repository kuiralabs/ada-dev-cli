// Derivation, delegated to the authoritative implementation.
//
// This is the highest-consequence cryptography in the stack: an address derived
// wrongly does not fail, it succeeds at the wrong place, and funds sent there are
// gone. A second implementation of it could only ever disagree with the official
// one, so this tool's job is to make that one convenient rather than to compete
// with it.
//
// `cardano-address` is IntersectMBO's, and it is what the CIP-1852 and CIP-19
// test vectors are written against.

import { spawnSync } from 'node:child_process';
import { toolMissingError, AdaError } from './errors.ts';
import { EXIT_INTERNAL } from './exit-codes.ts';
import type { NetworkName } from './cli-config.ts';

const BIN = 'cardano-address';

/** `ADA_CARDANO_ADDRESS` wins, so a specific build can be pinned. */
export function resolveBin(): string {
  return process.env.ADA_CARDANO_ADDRESS ?? BIN;
}

export function version(): string | undefined {
  const r = spawnSync(resolveBin(), ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return undefined;
  return (r.stdout || '').trim().split('\n')[0];
}

export function notInstalled(): AdaError {
  return toolMissingError(
    'cardano-address is not installed',
    'it is a prebuilt binary — download it from the IntersectMBO/cardano-addresses '
    + 'releases page and put it on your PATH, or set ADA_CARDANO_ADDRESS',
  );
}

/** One step of the pipeline, with the previous step's output as stdin. */
function step(args: string[], input: string): string {
  const r = spawnSync(resolveBin(), args, { input, encoding: 'utf8' });
  if (r.error) {
    if ((r.error as NodeJS.ErrnoException).code === 'ENOENT') throw notInstalled();
    throw new AdaError('derive_failed', `cardano-address failed: ${r.error.message}`, EXIT_INTERNAL);
  }
  if (r.status !== 0) {
    throw new AdaError('derive_failed',
      `cardano-address ${args.join(' ')} failed`, EXIT_INTERNAL,
      (r.stderr || '').trim().split('\n')[0] || undefined);
  }
  return (r.stdout || '').trim();
}

/** CIP-19 network tags. Every test network shares one; mainnet is its own. */
const networkTag = (network: NetworkName): string => (network === 'mainnet' ? 'mainnet' : 'testnet');

export interface Derived {
  path: string;
  paymentAddress: string;
  stakeAddress: string;
  /** Payment only, no delegation part. Useful for scripts and one-off outputs. */
  enterpriseAddress: string;
  tool: string;
}

/**
 * Derive from a recovery phrase, through the official binary.
 *
 * The staking key is always taken from role 2 at index 0, which is what CIP-1852
 * specifies and what every wallet does — a base address pairs one payment key
 * with the account's single staking key, so the role-2 path does not vary with
 * the payment index.
 */
export function derive(
  mnemonic: string,
  network: NetworkName,
  account = 0,
  index = 0,
  role = 0,
): Derived {
  const tool = version();
  if (!tool) throw notInstalled();

  const tag = networkTag(network);
  const root = step(['key', 'from-recovery-phrase', 'Shelley'], mnemonic.trim());

  const paymentXpub = step(['key', 'public', '--with-chain-code'],
    step(['key', 'child', `1852H/1815H/${account}H/${role}/${index}`], root));
  const stakeXpub = step(['key', 'public', '--with-chain-code'],
    step(['key', 'child', `1852H/1815H/${account}H/2/0`], root));

  const enterprise = step(['address', 'payment', '--network-tag', tag], paymentXpub);
  const payment = step(['address', 'delegation', stakeXpub], enterprise);
  const stake = step(['address', 'stake', '--network-tag', tag], stakeXpub);

  return {
    path: `m/1852'/1815'/${account}'/${role}/${index}`,
    paymentAddress: payment,
    stakeAddress: stake,
    enterpriseAddress: enterprise,
    tool,
  };
}
