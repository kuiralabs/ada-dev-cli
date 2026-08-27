// Taking an existing recovery phrase into the named-wallet model.
//
// The failure that matters here is quiet: a phrase with one word mistyped has
// the right word count, passes every shallow check, and derives a perfectly
// valid address — for a wallet nobody owns. Anything sent there is gone. So the
// checksum is enforced, and nothing is written until derivation has agreed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { parseArgs } from '../lib/argv.ts';
import wallet from '../commands/wallet.ts';

let home: string;
let realHome: string | undefined;

const feed = (text: string): void => {
  const stream = Readable.from([Buffer.from(text, 'utf8')]) as unknown as typeof process.stdin;
  (stream as { isTTY?: boolean }).isTTY = false;
  vi.spyOn(process, 'stdin', 'get').mockReturnValue(stream);
};

const run = (argv: string[]): Promise<void> => wallet(parseArgs(argv));

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ada-import-'));
  process.env.HOME = home;
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const walletsWritten = (): string[] => {
  const dir = join(home, '.ada', 'wallets');
  return existsSync(dir) ? readdirSync(dir) : [];
};

describe('importing a recovery phrase', () => {
  it('refuses a phrase that is not 24 words, naming the count it got', async () => {
    feed('one two three');
    await expect(run(['wallet', 'import', 'trader'])).rejects.toThrow(/24-word recovery phrase, got 3/);
    expect(walletsWritten()).toEqual([]);
  });

  it('refuses a phrase whose checksum does not match', async () => {
    // 24 real words in a valid-looking order, but not a phrase anyone generated.
    feed(Array(24).fill('abandon').join(' '));
    await expect(run(['wallet', 'import', 'trader'])).rejects.toThrow(/not a valid recovery phrase/);
  });

  // The bug this pins: an earlier version saved the wallet and derived
  // afterwards, so a refused phrase still left a file the user had to know to
  // delete — and `wallet list` would show a wallet that could not be opened.
  it('writes nothing when the phrase is refused', async () => {
    feed(Array(24).fill('abandon').join(' '));
    await expect(run(['wallet', 'import', 'trader'])).rejects.toThrow();
    expect(walletsWritten()).toEqual([]);
  });

  it('refuses an interactive terminal rather than hanging on a read', async () => {
    // The phrase is only ever piped in — an argument would land in shell history
    // and be visible in `ps`. A TTY means nobody piped anything, and silently
    // blocking on stdin looks like the tool has frozen.
    feed('');
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    await expect(run(['wallet', 'import', 'trader'])).rejects.toThrow(/read from stdin/);
    expect(walletsWritten()).toEqual([]);
  });
});
