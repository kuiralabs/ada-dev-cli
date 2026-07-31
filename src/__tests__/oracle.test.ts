// Second opinions: cardano-cli on a script hash, Ogmios on an execution budget.
//
// Both exist for the same reason the whole stack was chosen. A reference built
// from the code under test can only confirm that code's own bugs, so the value is
// in asking something that shares no implementation with us — and the answer that
// matters is a disagreement, because a confidently wrong script address strands
// funds where nobody can reach them.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crossCheckScriptHash, resolveCardanoCliBin } from '../lib/cardano-cli.ts';
import { ogmiosUrl, DEFAULT_OGMIOS_URL } from '../lib/ogmios.ts';

afterEach(() => {
  delete process.env.ADA_CARDANO_CLI;
  delete process.env.ADA_OGMIOS_URL;
});

/** A stand-in cardano-cli that answers with whatever hash we choose. */
function fakeCli(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ada-cli-'));
  const bin = join(dir, 'cardano-cli');
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "cardano-cli 0.0.0-fake"; exit 0; fi\n${body}\n`);
  chmodSync(bin, 0o755);
  process.env.ADA_CARDANO_CLI = bin;
  return bin;
}

const HASH = '61862d972a99950111010c9ce8c16765d62855cb6e1cc1b8bc6d4505';

describe('cross-checking a script hash', () => {
  it('honours an explicit binary, so a specific build can be pinned', () => {
    process.env.ADA_CARDANO_CLI = '/somewhere/cardano-cli-11';
    expect(resolveCardanoCliBin()).toBe('/somewhere/cardano-cli-11');
  });

  it('reports agreement when the two match', () => {
    fakeCli(`echo ${HASH}`);
    const r = crossCheckScriptHash('59010959…', 'V3', HASH);
    expect(r.available).toBe(true);
    expect(r.agrees).toBe(true);
    expect(r.hash).toBe(HASH);
  });

  it('reports disagreement rather than shrugging', () => {
    // The whole point. A wrong address is not a warning, it is stranded funds.
    fakeCli('echo 00000000000000000000000000000000000000000000000000000000');
    expect(crossCheckScriptHash('59010959…', 'V3', HASH).agrees).toBe(false);
  });

  it('says why when the tool cannot answer, rather than claiming agreement', () => {
    fakeCli('echo "bad envelope" >&2; exit 1');
    const r = crossCheckScriptHash('nonsense', 'V3', HASH);
    expect(r.available).toBe(true);
    expect(r.agrees).toBeUndefined();
    expect(r.unavailable).toBeTruthy();
  });

  it('treats an absent cardano-cli as absent, not as a failure', () => {
    process.env.ADA_CARDANO_CLI = '/nonexistent/cardano-cli';
    const r = crossCheckScriptHash('59010959…', 'V3', HASH);
    expect(r.available).toBe(false);
    expect(r.agrees).toBeUndefined();
  });
});

describe('finding an Ogmios', () => {
  const local = { name: 'devnet', isLocal: true } as any;
  const public_ = { name: 'preprod', isLocal: false } as any;

  it('probes the devkit default on a local chain', () => {
    // If one is running against a devnet at all, it is on the port the devkit's
    // own generated launcher uses.
    expect(ogmiosUrl(local)).toBe(DEFAULT_OGMIOS_URL);
  });

  it('never guesses at localhost for a public network', () => {
    // Probing localhost for preprod asks a question about the wrong machine.
    expect(ogmiosUrl(public_)).toBeUndefined();
  });

  it('lets an explicit URL win, in the environment rather than on argv', () => {
    // Same shape as ADA_BLOCKFROST_KEY: command lines land in shell history.
    process.env.ADA_OGMIOS_URL = 'https://preprod.koios.rest/api/v1/ogmios';
    expect(ogmiosUrl(public_)).toBe('https://preprod.koios.rest/api/v1/ogmios');
    expect(ogmiosUrl(local)).toBe('https://preprod.koios.rest/api/v1/ogmios');
  });

  it('ignores an empty value rather than treating it as a URL', () => {
    process.env.ADA_OGMIOS_URL = '   ';
    expect(ogmiosUrl(public_)).toBeUndefined();
  });
});

describe('derivation is delegated, and cross-checked', () => {
  // The highest-consequence cryptography in the stack. It does not fail loudly
  // when wrong — it succeeds at the wrong address, and funds sent there are gone.
  // So it is delegated to IntersectMBO's own tool and never reimplemented, which
  // also makes every derivation a comparison against the reference.
  it('honours an explicit binary', async () => {
    const { resolveBin } = await import('../lib/cardano-address.ts');
    process.env.ADA_CARDANO_ADDRESS = '/somewhere/cardano-address';
    expect(resolveBin()).toBe('/somewhere/cardano-address');
    delete process.env.ADA_CARDANO_ADDRESS;
  });

  it('names how to get it when absent, rather than failing obscurely', async () => {
    const { notInstalled } = await import('../lib/cardano-address.ts');
    const e = notInstalled();
    expect(e.code).toBe('tool_missing');
    expect(e.hint).toMatch(/prebuilt binary|releases page/);
  });
});

describe('genesis addresses come from the genesis, not a log', () => {
  // Log-scraping was rejected as too fragile — a format nobody promised to keep.
  // The same information is in the Shelley genesis the node was started from,
  // which the control API serves.
  it('reads initialFunds and reports the richest first', async () => {
    const { fundedAddresses } = await import('../lib/genesis.ts');
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      initialFunds: {
        '00c8c47610a36034aac6fc58848bdae5c278d994ff502c05455e3b3ee8f8ed3a0eea0ef835ffa7bbfcde55f7fe9d2cc5d55ea62cecb42bab3c': 1_000_000,
        '00d8c47610a36034aac6fc58848bdae5c278d994ff502c05455e3b3ee8f8ed3a0eea0ef835ffa7bbfcde55f7fe9d2cc5d55ea62cecb42bab3c': 9_000_000,
      },
    }), { status: 200 })) as typeof fetch;
    try {
      const funded = await fundedAddresses('http://localhost:10000');
      expect(funded).toHaveLength(2);
      expect(BigInt(funded[0].lovelace)).toBeGreaterThan(BigInt(funded[1].lovelace));
      expect(funded[0].address).toMatch(/^addr_test1/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reports an entry it cannot decode rather than dropping it', async () => {
    // A silently shorter list reads as "the devnet has fewer funded addresses".
    const { fundedAddresses } = await import('../lib/genesis.ts');
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({
      initialFunds: { 'not-an-address': 5 },
    }), { status: 200 })) as typeof fetch;
    try {
      const funded = await fundedAddresses('http://localhost:10000');
      expect(funded).toHaveLength(1);
      expect(funded[0].address).toContain('undecodable');
    } finally {
      globalThis.fetch = original;
    }
  });

  it('says the devnet may not be running when the API cannot answer', async () => {
    const { fundedAddresses } = await import('../lib/genesis.ts');
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    try {
      await expect(fundedAddresses('http://localhost:10000')).rejects.toThrow(/genesis|devnet/i);
    } finally {
      globalThis.fetch = original;
    }
  });
});
