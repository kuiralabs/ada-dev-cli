// Named wallets on disk, at ~/.ada/wallets/<name>.json.
//
// **These are development keys and the mnemonic is stored in plaintext.** That is
// a deliberate trade-off, matching what midnight-wallet-cli does, and the reason
// is the agent contract: encryption-at-rest means a passphrase, a passphrase means
// a prompt, and no path an agent needs may block on a prompt. Requiring one per
// command would also destroy the fast local loop this tool exists to provide.
//
// What is done instead:
//   - files are written 0600 and the directory 0700
//   - mnemonics are never printed unless explicitly asked for
//   - **mainnet is refused outright** — see assertNotMainnet
//
// If encryption is wanted later, the passphrase must arrive by environment
// variable rather than argument, because command lines appear in shell history
// and in process listings.

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  renameSync, unlinkSync, readdirSync,
} from 'node:fs';
import { usageError, configError, AdaError } from './errors.ts';
import { EXIT_INVALID_ARGS } from './exit-codes.ts';
import type { NetworkName } from './cli-config.ts';

const WALLETS_DIR_NAME = 'wallets';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Names become filenames, so they are constrained rather than sanitised. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export interface StoredWallet {
  name: string;
  /** BIP-39 recovery phrase. Plaintext — see the file header. */
  mnemonic: string;
  /** Payment address per network, cached so `wallet list` needs no key work. */
  addresses: Partial<Record<NetworkName, string>>;
  /** Stake address per network. */
  stakeAddresses: Partial<Record<NetworkName, string>>;
  accountIndex: number;
  createdAt: string;
}

export const walletsDir = (): string => join(homedir(), '.ada', WALLETS_DIR_NAME);
export const walletPath = (name: string): string => join(walletsDir(), `${name}.json`);

export function assertWalletName(name: string): string {
  if (!NAME_PATTERN.test(name)) {
    throw usageError(
      `invalid wallet name: ${name}`,
      'use letters, digits, dashes or underscores, up to 32 characters',
    );
  }
  return name;
}

/**
 * Refuse to hold or use a key on mainnet.
 *
 * Storage is unencrypted, so a mainnet key here would be a real risk sitting in a
 * developer's home directory. Refusing is honest; pretending otherwise is not.
 */
export function assertNotMainnet(network: NetworkName): void {
  if (network === 'mainnet') {
    throw new AdaError(
      'mainnet_refused',
      'this tool will not hold or use a wallet on mainnet',
      EXIT_INVALID_ARGS,
      'wallet keys are stored unencrypted; use devnet, preprod or preview',
    );
  }
}

export function listWallets(): StoredWallet[] {
  const dir = walletsDir();
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .sort(); // deterministic ordering — part of the output contract
  return names.map(readWallet).filter((w): w is StoredWallet => w !== undefined);
}

export function walletExists(name: string): boolean {
  return existsSync(walletPath(assertWalletName(name)));
}

function readWallet(name: string): StoredWallet | undefined {
  try {
    const raw = readFileSync(walletPath(name), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoredWallet>;
    if (!parsed.mnemonic) return undefined;
    return {
      name,
      mnemonic: parsed.mnemonic,
      addresses: parsed.addresses ?? {},
      stakeAddresses: parsed.stakeAddresses ?? {},
      accountIndex: parsed.accountIndex ?? 0,
      createdAt: parsed.createdAt ?? 'unknown',
    };
  } catch {
    return undefined;
  }
}

/** Load a wallet, failing with an actionable message rather than undefined. */
export function loadWallet(name: string): StoredWallet {
  assertWalletName(name);
  const wallet = readWallet(name);
  if (!wallet) {
    throw configError(
      `no wallet named ${name}`,
      'list them with: ada wallet list',
    );
  }
  return wallet;
}

export function saveWallet(wallet: StoredWallet): void {
  assertWalletName(wallet.name);
  const dir = walletsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  const path = walletPath(wallet.name);
  // Write-then-rename so an interrupted write cannot leave a half file that would
  // read as a wallet with no mnemonic.
  const tmp = `${path}.tmp`;
  const { name: _name, ...body } = wallet;
  writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: FILE_MODE });
  renameSync(tmp, path);
}

export function removeWallet(name: string): void {
  assertWalletName(name);
  const path = walletPath(name);
  if (!existsSync(path)) {
    throw configError(`no wallet named ${name}`, 'list them with: ada wallet list');
  }
  unlinkSync(path);
}

/** Cache derived addresses so `wallet list` does no key work. */
export function rememberAddresses(
  wallet: StoredWallet,
  network: NetworkName,
  payment: string,
  stake: string,
): void {
  const updated: StoredWallet = {
    ...wallet,
    addresses: { ...wallet.addresses, [network]: payment },
    stakeAddresses: { ...wallet.stakeAddresses, [network]: stake },
  };
  saveWallet(updated);
}
