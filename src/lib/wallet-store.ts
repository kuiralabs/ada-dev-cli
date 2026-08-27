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
// Encryption is now available and works exactly that way — see lib/keystore.ts.
// `ada wallet encrypt <name>` seals the phrase with a passphrase read from
// ADA_WALLET_PASSPHRASE. An encrypted wallet is the only kind allowed on
// mainnet: the refusal below exists because the phrase is readable, so it lifts
// precisely when it no longer is.

import { homedir } from 'node:os';
import { writeFileAtomic } from './atomic-write.ts';
import { join } from 'node:path';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  renameSync, unlinkSync, readdirSync,
} from 'node:fs';
import { usageError, configError, AdaError } from './errors.ts';
import { open as openSealed, passphraseFromEnv, type SealedSecret } from './keystore.ts';
import { EXIT_INVALID_ARGS } from './exit-codes.ts';
import type { NetworkName } from './cli-config.ts';

const WALLETS_DIR_NAME = 'wallets';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Names become filenames, so they are constrained rather than sanitised. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/i;

export interface StoredWallet {
  name: string;
  /**
   * BIP-39 recovery phrase.
   *
   * Plaintext unless {@link StoredWallet.sealed} is present, in which case this
   * holds the phrase only in memory after being opened, and never on disk.
   */
  mnemonic: string;
  /** Set when the phrase is encrypted at rest. Mutually exclusive with a stored `mnemonic`. */
  sealed?: SealedSecret;
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
 * Refuse to use a *readable* key on mainnet.
 *
 * The original rule was that mainnet is refused outright, because storage was
 * unencrypted and a real-money key sitting readable in a home directory is a
 * real risk. That reasoning was never about mainnet as such — it was about the
 * phrase being readable. So the rule now says what it always meant: an encrypted
 * wallet may be used on mainnet, and a plaintext one may not.
 *
 * `wallet` is optional so callers with no key in hand (an address lookup) are
 * unaffected — those never reach here.
 */
export function assertNotMainnet(network: NetworkName, wallet?: StoredWallet): void {
  if (network !== 'mainnet') return;
  if (wallet?.sealed !== undefined) return;
  throw new AdaError(
    'mainnet_refused',
    'this tool will not use a plaintext wallet on mainnet',
    EXIT_INVALID_ARGS,
    'the recovery phrase is stored in the clear. Encrypt it first — '
    + '`ada wallet encrypt <name>` with ADA_WALLET_PASSPHRASE set — or use devnet, preprod or preview',
  );
}

/**
 * A wallet with its phrase available, decrypting if it is sealed.
 *
 * Every consumer needs the phrase and none of them should each learn how the
 * keystore works, so this is the one place that opens one.
 */
export function unsealWallet(wallet: StoredWallet): StoredWallet {
  if (wallet.sealed === undefined) return wallet;
  return { ...wallet, mnemonic: openSealed(wallet.sealed, passphraseFromEnv()) };
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
    // A wallet is its key material: either a readable phrase or a sealed one.
    // Requiring the phrase specifically is what made an encrypted wallet read as
    // no wallet at all — the guard is against a half-written file, and a sealed
    // wallet is not one.
    if (!parsed.mnemonic && !parsed.sealed) return undefined;
    return {
      name,
      mnemonic: parsed.mnemonic ?? '',
      ...(parsed.sealed ? { sealed: parsed.sealed } : {}),
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
  // read as a wallet with no mnemonic. Every command that opens a wallet rewrites
  // it to cache the derived address, so concurrent writers are ordinary here.
  const { name: _name, ...body } = wallet;
  writeFileAtomic(path, JSON.stringify(body, null, 2) + '\n', FILE_MODE);
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
