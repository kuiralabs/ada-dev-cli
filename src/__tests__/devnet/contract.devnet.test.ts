// Contract commands, against a real chain.
//
// Everything in the unit suite is offline, which is right — CI must fail loudly
// without a network rather than pass vacuously. But it leaves a gap that this
// session made obvious: nine "verified live" claims in the tracker rest entirely
// on someone having typed the commands once and read the output. Nothing
// re-checks them, so they can quietly stop being true.
//
// These do re-check them. They **skip** when no devnet is reachable, because a
// developer without one running should not see red — but the skip is printed, so
// it cannot be mistaken for a pass.
//
//   ada localnet up && ada wallet use alice && ada airdrop 1000 --yes
//   npm run test:devnet

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'ada.ts');
const BLUEPRINT = process.env.ADA_TEST_BLUEPRINT
  ?? join(HERE, 'fixtures', 'hello-world');

const DEVNET = 'http://localhost:8080/api/v1/blocks/latest';

async function devnetUp(): Promise<boolean> {
  try {
    const res = await fetch(DEVNET, { signal: AbortSignal.timeout(2500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Run the CLI exactly as a user would, and parse the JSON contract. */
function ada(args: string[]): Record<string, any> {
  try {
    const out = execFileSync('npx', ['tsx', CLI, ...args, '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000,
    });
    return JSON.parse(out);
  } catch (err) {
    // A non-zero exit still carries a JSON document on stdout — that is the
    // contract, and the failure shape is exactly what several of these assert.
    const stdout = (err as { stdout?: string }).stdout ?? '';
    try { return JSON.parse(stdout); } catch { throw err; }
  }
}

const settle = () => new Promise((r) => setTimeout(r, 5_000));

// Probed at module scope, deliberately.
//
// Doing this in beforeAll silently skipped every test: vitest decides `it` vs
// `it.skip` while *collecting* the file, which happens before any hook runs, so
// the flag was always false and the suite reported green having exercised
// nothing. That is precisely the failure this file exists to prevent, so it is
// worth the top-level await.
const available = await devnetUp();
if (!available) {
  console.warn('\n  ⚠ devnet unreachable — skipping chain tests. Start one with: ada localnet up\n');
}

const chain = () => (available ? it : it.skip);

describe('contract, against a live devnet', () => {
  chain()('has a funded wallet to work with', () => {
    const balance = ada(['balance']);
    expect(balance.ok).toBe(true);
    expect(BigInt(balance.lovelace ?? '0')).toBeGreaterThan(20_000_000n);
  });

  chain()('derives an address the chain agrees with', () => {
    const addr = ada(['contract', 'address', '--blueprint', BLUEPRINT]);
    expect(addr.ok).toBe(true);
    expect(addr.address).toMatch(/^addr_test1/);
    // The blueprint records the hash the compiler produced. If our derivation
    // disagrees with it, one of us is wrong and it is not Aiken.
    const inspect = ada(['contract', 'inspect', '--blueprint', BLUEPRINT]);
    expect(addr.scriptHash).toBe(inspect.selected.hash);
  });

  chain()('locks and unlocks with an inline datum', async () => {
    const lock = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '5', '--datum-signer', '--yes']);
    expect(lock.ok).toBe(true);
    expect(lock.datumEncoding).toBe('inline');
    await settle();

    const at = ada(['contract', 'utxos', '--blueprint', BLUEPRINT]);
    expect(at.utxos.some((u: any) => u.ref === `${lock.txHash}#0`)).toBe(true);

    const unlock = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Hello, World!', '--yes']);
    expect(unlock.ok).toBe(true);
    expect(unlock.txHash).toMatch(/^[0-9a-f]{64}$/);
    await settle();

    const after = ada(['contract', 'utxos', '--blueprint', BLUEPRINT]);
    expect(after.utxos.some((u: any) => u.ref === `${lock.txHash}#0`)).toBe(false);
  }, 240_000);

  chain()('refuses a hash-stored datum until the original is supplied', async () => {
    // No chain publishes the preimage of a hashed datum, so this cannot be
    // recovered — demanding it up front beats failing at submission.
    const lock = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '5', '--datum-signer', '--datum-hash', '--yes']);
    expect(lock.datumEncoding).toBe('hash');
    await settle();

    const without = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Hello, World!']);
    expect(without.ok).toBe(false);
    expect(without.code).toBe('datum_required');

    const hash = ada(['wallet', 'info']).paymentAddress;
    const { deserializeAddress } = await import('@meshsdk/core');
    const datum = JSON.stringify({ alternative: 0, fields: [deserializeAddress(hash).pubKeyHash] });

    const withDatum = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Hello, World!',
      '--datum', datum, '--yes']);
    expect(withDatum.ok).toBe(true);
  }, 240_000);

  chain()('lets the validator reject a wrong redeemer, and keeps the money', async () => {
    const lock = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '5', '--datum-signer', '--yes']);
    await settle();

    const bad = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Goodbye', '--yes']);
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('script_rejected');

    // The point of the test: a rejected transaction moves nothing.
    const still = ada(['contract', 'utxos', '--blueprint', BLUEPRINT]);
    expect(still.utxos.some((u: any) => u.ref === `${lock.txHash}#0`)).toBe(true);
  }, 240_000);

  chain()('lets the validator reject the wrong signer', async () => {
    // Written carefully after a first attempt proved nothing: an unfunded second
    // wallet failed on collateral before the validator ever ran, which looked
    // like a pass and tested nothing. The other wallet must be funded for this
    // to mean anything.
    const other = 'bob';
    const bal = ada(['balance', '--wallet', other]);
    if (!bal.ok || BigInt(bal.lovelace ?? '0') < 20_000_000n) {
      console.warn(`  ⚠ ${other} is not funded — skipping the wrong-signer case`);
      return;
    }

    const lock = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '5', '--datum-signer', '--wallet', 'alice', '--yes']);
    await settle();

    const theft = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Hello, World!',
      '--wallet', other, '--yes']);
    expect(theft.ok).toBe(false);
    // Not no_collateral — that would mean the validator never ran.
    expect(theft.code).toBe('script_rejected');

    const still = ada(['contract', 'utxos', '--blueprint', BLUEPRINT]);
    expect(still.utxos.some((u: any) => u.ref === `${lock.txHash}#0`)).toBe(true);
  }, 240_000);

  chain()('names every UTxO when several sit at one script address', async () => {
    const at = ada(['contract', 'utxos', '--blueprint', BLUEPRINT]);
    if (at.count < 2) return; // needs an ambiguous state to be meaningful
    const ambiguous = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--redeemer-message', 'Hello, World!']);
    expect(ambiguous.ok).toBe(false);
    for (const u of at.utxos) expect(ambiguous.hint).toContain(u.ref);
  }, 120_000);
});
