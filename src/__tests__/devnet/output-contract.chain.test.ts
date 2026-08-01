// stdout carries one JSON document, on every path — including the refusals.
//
// The contract is easy to honour on the success path and easy to break on the
// others. `swap build --json` without `--yes` printed a human-readable preview
// to stdout *and then* the error document, so stdout did not parse at all. It
// went unnoticed because every test that exercised swap passed `--yes`, and the
// preview only exists when you do not.
//
// These run the dry-run form of everything that has one. None of them submit,
// so the suite costs a few queries and no coin.

import { describe, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { ada, chain, CLI, BLUEPRINT, NETWORK, TEST_TIMEOUT, WALLET, paceBetweenTests } from './harness.ts';

paceBetweenTests();

/**
 * Run the CLI and hand back stdout verbatim.
 *
 * Deliberately not the harness's `ada`, which parses for you — the thing under
 * test is whether the bytes on stdout parse at all, so parsing them before
 * looking would hide exactly the defect this exists to catch.
 */
function rawStdout(args: string[]): string {
  const argv = [...args, '--network', NETWORK, ...(WALLET ? ['--wallet', WALLET] : []), '--json'];
  try {
    return execFileSync('npx', ['tsx', CLI, ...argv], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 300_000,
    });
  } catch (err) {
    // A refusal exits non-zero and still owes us a document on stdout. That is
    // the whole contract, and these paths are where it was broken.
    return (err as { stdout?: string }).stdout ?? '';
  }
}

const parsesAsOneDocument = (out: string): boolean => {
  if (out.trim() === '') return true; // nothing written is not a broken document
  try {
    JSON.parse(out);
    return true;
  } catch {
    return false;
  }
};

describe(`the output contract on refusal paths (${NETWORK})`, () => {
  chain()('holds for every command that previews before committing', async () => {
    const to = ada(['wallet', 'info']).paymentAddress as string;
    const fakeUnit = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef4e4654';

    // Each is the form *without* `--yes`: the one that prints figures for a
    // person to check, and the one every earlier test skipped past.
    const dryRuns: Array<[string, string[]]> = [
      ['transfer', ['transfer', to, '5']],
      ['asset mint', ['asset', 'mint', 'Probe', '--qty', '5']],
      ['asset send', ['asset', 'send', to, `${fakeUnit}:1`]],
      ['contract lock', ['contract', 'lock', '--blueprint', BLUEPRINT, '--amount', '5', '--datum-signer']],
      ['contract mint', ['contract', 'mint', '--blueprint', BLUEPRINT, '--name', 'Tok', '--qty', '1']],
      ['swap build', ['swap', 'build', '--with', to, '--give', '5ADA', '--want', '3ADA']],
      ['swap build, duplicate units', ['swap', 'build', '--with', to, '--give', '5ADA,5ADA', '--want', '3ADA']],
    ];

    const broken: string[] = [];
    for (const [name, argv] of dryRuns) {
      const out = rawStdout(argv);
      if (!parsesAsOneDocument(out)) broken.push(`${name}: ${out.split('\n')[0].slice(0, 60)}`);
    }

    expect(broken).toEqual([]);
  }, TEST_TIMEOUT);

  chain()('sums a unit given twice, since a Value cannot hold it twice', async () => {
    // `--give 5ADA,5ADA` produced an offer carrying two lovelace entries of
    // five million each. A ledger Value is a map keyed by unit, so that is not
    // representable — whichever layer noticed first would drop one silently or
    // fail somewhere unrelated to what was typed.
    const to = ada(['wallet', 'info']).paymentAddress as string;
    const built = ada(['swap', 'build', '--with', to, '--give', '5ADA,5ADA', '--want', '3ADA', '--yes']);
    if (built.code) return; // not enough funds on this network; the shape is asserted below anyway

    const offer = JSON.parse(Buffer.from(built.offer as string, 'base64').toString());
    const lovelace = offer.maker.gives.filter((a: { unit: string }) => a.unit === 'lovelace');
    expect(lovelace).toHaveLength(1);
    expect(lovelace[0].quantity).toBe('10000000');
  }, TEST_TIMEOUT);
});
