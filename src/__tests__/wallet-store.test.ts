// Wallet storage, against a real temporary HOME so file modes and atomic writes
// are genuinely exercised.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertWalletName, assertNotMainnet, saveWallet, loadWallet, listWallets,
  removeWallet, walletExists, walletPath, walletsDir, rememberAddresses,
  type StoredWallet,
} from '../lib/wallet-store.ts';
import { AdaError } from '../lib/errors.ts';

let home: string;
let realHome: string | undefined;

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ada-wallets-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

const sample = (name: string): StoredWallet => ({
  name,
  mnemonic: 'test '.repeat(23).trim() + ' word',
  addresses: {},
  stakeAddresses: {},
  accountIndex: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
});

describe('names are constrained because they become filenames', () => {
  it('accepts ordinary names', () => {
    for (const n of ['alice', 'bob-2', 'my_wallet', 'A1']) expect(assertWalletName(n)).toBe(n);
  });

  it('rejects path traversal and separators outright', () => {
    // Sanitising would be a guess; rejecting is unambiguous.
    for (const n of ['../escape', 'a/b', 'a\\b', '.hidden', '', 'x'.repeat(33), 'a b']) {
      expect(() => assertWalletName(n), n).toThrowError(AdaError);
    }
  });
});

describe('mainnet refuses a READABLE key, not mainnet as such', () => {
  const wallet = (sealed?: object): StoredWallet => ({
    name: 'w', mnemonic: sealed ? '' : Array(24).fill('test').join(' '),
    ...(sealed ? { sealed: sealed as never } : {}),
    addresses: {}, stakeAddresses: {}, accountIndex: 0, createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('throws for a plaintext wallet on mainnet, and says how to proceed', () => {
    try {
      assertNotMainnet('mainnet', wallet());
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AdaError);
      expect((err as AdaError).code).toBe('mainnet_refused');
      expect((err as AdaError).hint).toContain('encrypt');
    }
  });

  it('throws for mainnet when no wallet is offered at all', () => {
    expect(() => assertNotMainnet('mainnet')).toThrowError(AdaError);
  });

  // The rule was never about mainnet: it was about the phrase being readable.
  // So it lifts exactly when the phrase stops being readable, and not before.
  it('allows an ENCRYPTED wallet on mainnet', () => {
    expect(() => assertNotMainnet('mainnet', wallet({ kdf: 'scrypt' }))).not.toThrow();
  });

  it('allows every test network, encrypted or not', () => {
    for (const n of ['devnet', 'preprod', 'preview'] as const) {
      expect(() => assertNotMainnet(n)).not.toThrow();
      expect(() => assertNotMainnet(n, wallet())).not.toThrow();
    }
  });
});

describe('storage round-trip', () => {
  it('saves and loads a wallet', () => {
    saveWallet(sample('alice'));
    const loaded = loadWallet('alice');
    expect(loaded.name).toBe('alice');
    expect(loaded.mnemonic.split(' ')).toHaveLength(24);
    expect(loaded.accountIndex).toBe(0);
  });

  it('writes the key file 0600 and the directory 0700', () => {
    saveWallet(sample('alice'));
    // A recovery phrase in plaintext must at least not be world-readable.
    expect(statSync(walletPath('alice')).mode & 0o777).toBe(0o600);
    expect(statSync(walletsDir()).mode & 0o777).toBe(0o700);
  });

  it('leaves no temporary file behind', () => {
    saveWallet(sample('alice'));
    expect(existsSync(`${walletPath('alice')}.tmp`)).toBe(false);
  });

  it('fails with an actionable message for a missing wallet', () => {
    try {
      loadWallet('nobody');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AdaError).code).toBe('config_error');
      expect((err as AdaError).hint).toContain('ada wallet list');
    }
  });

  it('reports existence without throwing', () => {
    expect(walletExists('alice')).toBe(false);
    saveWallet(sample('alice'));
    expect(walletExists('alice')).toBe(true);
  });
});

describe('listing', () => {
  it('is empty before anything is created', () => {
    expect(listWallets()).toEqual([]);
  });

  it('returns wallets in a deterministic order', () => {
    // Stable ordering is part of the output contract: two runs must diff cleanly.
    for (const n of ['zoe', 'alice', 'mike']) saveWallet(sample(n));
    expect(listWallets().map((w) => w.name)).toEqual(['alice', 'mike', 'zoe']);
  });

  it('skips a file with no mnemonic rather than returning a broken wallet', () => {
    saveWallet(sample('alice'));
    mkdirSync(walletsDir(), { recursive: true });
    writeFileSync(join(walletsDir(), 'broken.json'), '{"addresses":{}}');
    writeFileSync(join(walletsDir(), 'garbage.json'), 'not json at all');
    expect(listWallets().map((w) => w.name)).toEqual(['alice']);
  });
});

describe('address caching', () => {
  it('remembers derived addresses per network', () => {
    const w = sample('alice');
    saveWallet(w);
    rememberAddresses(w, 'devnet', 'addr_test1payment', 'stake_test1stake');
    const loaded = loadWallet('alice');
    expect(loaded.addresses.devnet).toBe('addr_test1payment');
    expect(loaded.stakeAddresses.devnet).toBe('stake_test1stake');
  });

  it('does not lose another network when caching one', () => {
    const w = sample('alice');
    saveWallet(w);
    rememberAddresses(w, 'devnet', 'addr_devnet', 'stake_devnet');
    rememberAddresses(loadWallet('alice'), 'preprod', 'addr_preprod', 'stake_preprod');
    const loaded = loadWallet('alice');
    expect(loaded.addresses.devnet).toBe('addr_devnet');
    expect(loaded.addresses.preprod).toBe('addr_preprod');
  });

  it('preserves the mnemonic through a cache update', () => {
    const w = sample('alice');
    saveWallet(w);
    rememberAddresses(w, 'devnet', 'a', 's');
    expect(loadWallet('alice').mnemonic).toBe(w.mnemonic);
  });
});

describe('removal', () => {
  it('deletes the key file', () => {
    saveWallet(sample('alice'));
    removeWallet('alice');
    expect(existsSync(walletPath('alice'))).toBe(false);
  });

  it('fails rather than silently succeeding for a missing wallet', () => {
    expect(() => removeWallet('nobody')).toThrowError(AdaError);
  });
});

describe('an encrypted wallet survives the round trip to disk', () => {
  // This was broken and the unit tests could not see it: the keystore was
  // correct, and the store dropped the wallet on the way back in because the
  // half-written-file guard demanded a readable phrase.
  const sealed = {
    kdf: 'scrypt' as const, n: 16384, r: 8, p: 1, cipher: 'aes-256-gcm' as const,
    salt: 'aa'.repeat(16), iv: 'bb'.repeat(12), tag: 'cc'.repeat(16), ciphertext: 'dd'.repeat(40),
  };

  it('loads a wallet that has no readable phrase', () => {
    saveWallet({
      name: 'sealed-one', mnemonic: '', sealed,
      addresses: {}, stakeAddresses: {}, accountIndex: 0, createdAt: '2026-01-01T00:00:00.000Z',
    });
    const back = loadWallet('sealed-one');
    expect(back.sealed).toEqual(sealed);
    expect(back.mnemonic).toBe('');
  });

  it('still refuses a file with neither a phrase nor a seal', () => {
    mkdirSync(walletsDir(), { recursive: true });
    writeFileSync(join(walletsDir(), 'empty.json'), JSON.stringify({ name: 'empty' }));
    expect(() => loadWallet('empty')).toThrowError(AdaError);
  });
});
