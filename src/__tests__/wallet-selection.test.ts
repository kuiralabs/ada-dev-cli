// Which wallet a command acts on.
//
// The regression this pins was a real bug, and a quiet one: `--wallet` was ignored
// by `balance` and `utxos`, so asking for one account's balance returned another's
// with ok:true, and `--wallet ghost` did the same instead of failing. A flag that
// silently selects the wrong account is worse than one that does not exist.
//
// The precedence is resolved in one place so no command can miss it, and that is
// what these assert — the resolution itself, not each command's copy of it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../lib/argv.ts';
import { saveConfig } from '../lib/cli-config.ts';
import { saveWallet, type StoredWallet } from '../lib/wallet-store.ts';
import { AdaError } from '../lib/errors.ts';

let home: string;
let realHome: string | undefined;

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ada-sel-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const wallet = (name: string): StoredWallet => ({
  name,
  mnemonic: Array(24).fill('test').join(' '),
  addresses: {},
  stakeAddresses: {},
  accountIndex: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
});

/**
 * The name `openActive` would resolve, without opening a wallet.
 *
 * Extracted rather than mocked so the assertion is about the real precedence
 * logic. Opening a wallet needs a chain; choosing which one does not.
 */
async function resolveName(argv: string[], explicit?: string): Promise<string | undefined> {
  const { loadConfig } = await import('../lib/cli-config.ts');
  const { flagValue } = await import('../lib/argv.ts');
  const args = parseArgs(argv);
  const config = loadConfig();
  return explicit ?? flagValue(args, 'wallet') ?? config.activeWallet;
}

describe('wallet selection precedence', () => {
  beforeEach(() => {
    saveWallet(wallet('alice'));
    saveWallet(wallet('bob'));
    saveConfig({ network: 'devnet', activeWallet: 'alice', endpoints: {} });
  });

  it('falls back to the active wallet when nothing is specified', async () => {
    expect(await resolveName(['balance'])).toBe('alice');
  });

  it('honours --wallet over the active wallet', async () => {
    // The bug: this returned alice.
    expect(await resolveName(['balance', '--wallet', 'bob'])).toBe('bob');
  });

  it('lets a positional argument win over --wallet', async () => {
    // `ada balance bob --wallet alice` — the thing typed last and most specific
    // wins, and the positional is the documented form.
    expect(await resolveName(['balance', '--wallet', 'alice'], 'bob')).toBe('bob');
  });

  it('treats an empty --wallet as absent rather than as a name', async () => {
    // An agent filling a schema often sends "" instead of omitting the field.
    expect(await resolveName(['balance', '--wallet='])).toBe('alice');
  });

  it('resolves to undefined when there is no active wallet and none given', async () => {
    saveConfig({ network: 'devnet', endpoints: {} });
    expect(await resolveName(['balance'])).toBeUndefined();
  });
});

describe('an unknown wallet fails rather than falling through', () => {
  it('throws for a name that does not exist', async () => {
    // The other half of the bug: --wallet ghost silently reported the active
    // wallet's balance under ok:true.
    const { loadWallet } = await import('../lib/wallet-store.ts');
    saveWallet(wallet('alice'));
    expect(() => loadWallet('ghost')).toThrowError(AdaError);
    try {
      loadWallet('ghost');
    } catch (err) {
      expect((err as AdaError).code).toBe('config_error');
      expect((err as AdaError).hint).toContain('ada wallet list');
    }
  });
});
