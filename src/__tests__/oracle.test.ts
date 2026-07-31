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
