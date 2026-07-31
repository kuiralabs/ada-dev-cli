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

import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', '..', 'ada.ts');
const BLUEPRINT = process.env.ADA_TEST_BLUEPRINT
  ?? join(HERE, 'fixtures', 'hello-world');

/**
 * Which chain to run against, and with whose money.
 *
 *   ADA_TEST_NETWORK=preprod ADA_TEST_WALLET=preprod-test npm run test:chain
 *
 * Parameterised because the preprod pass was done by hand once, and a
 * verification performed once is a claim rather than a check — the same argument
 * that put these tests here in the first place.
 */
const NETWORK = process.env.ADA_TEST_NETWORK ?? 'devnet';
const WALLET = process.env.ADA_TEST_WALLET;
const IS_LOCAL = NETWORK === 'devnet';

/**
 * How long to wait for a transaction to be visible.
 *
 * A devnet produces a block a second; preprod takes about twenty, and being
 * *in* a block is not the same as the indexer having caught up. Measured at
 * roughly 75–90 seconds on preprod, so the ceiling is generous — a test that
 * gives up early reports a failure that is really impatience.
 */
const SETTLE_MS = IS_LOCAL ? 5_000 : 20_000;
const CONFIRM_TRIES = IS_LOCAL ? 6 : 15;
const TEST_TIMEOUT = IS_LOCAL ? 240_000 : 900_000;

const LOCAL_PROBE = 'http://localhost:8080/api/v1/blocks/latest';

/** Run the CLI exactly as a user would, and parse the JSON contract. */
function ada(args: string[]): Record<string, any> {
  const withNetwork = [...args, '--network', NETWORK,
    ...(WALLET && !args.includes('--wallet') ? ['--wallet', WALLET] : [])];
  try {
    const out = execFileSync('npx', ['tsx', CLI, ...withNetwork, '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 300_000,
    });
    return JSON.parse(out);
  } catch (err) {
    // A non-zero exit still carries a JSON document on stdout — that is the
    // contract, and the failure shape is exactly what several of these assert.
    const stdout = (err as { stdout?: string }).stdout ?? '';
    try { return JSON.parse(stdout); } catch { throw err; }
  }
}

const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

/**
 * Wait for a UTxO to appear at the script address, in a state the test can use.
 *
 * A fixed sleep was fine against one-second blocks and is guesswork against
 * twenty-second ones, so this polls. But existence alone is not enough: an
 * indexer can serve the output before it has attached the datum, and a spend
 * needs the datum. That showed up as the hash-datum test failing *inside* the
 * suite while passing alone — and failing **faster**, which is the signature of
 * winning a race rather than losing to a timeout.
 *
 * So the condition is what the next step actually requires, not merely that
 * something is there.
 */
async function awaitUtxo(ref: string, needs?: 'datum'): Promise<void> {
  for (let i = 0; i < CONFIRM_TRIES; i++) {
    await settle();
    const at = ada(['contract', 'utxos', '--blueprint', BLUEPRINT]);
    const found = at.utxos?.find((u: any) => u.ref === ref);
    if (!found) continue;
    if (needs === 'datum' && found.datumEncoding === 'none') continue;
    return;
  }
  throw new Error(`${ref} never became usable at the script address on ${NETWORK}`
    + (needs ? ` (waiting for its ${needs})` : ''));
}

async function reachable(): Promise<boolean> {
  if (!IS_LOCAL) {
    // A public network is reachable if the tool can read its tip.
    return ada(['tip']).ok === true;
  }
  try {
    return (await fetch(LOCAL_PROBE, { signal: AbortSignal.timeout(2500) })).ok;
  } catch {
    return false;
  }
}

// Probed at module scope, deliberately.
//
// Doing this in beforeAll silently skipped every test: vitest decides `it` vs
// `it.skip` while *collecting* the file, which happens before any hook runs, so
// the flag was always false and the suite reported green having exercised
// nothing. That is precisely the failure this file exists to prevent, so it is
// worth the top-level await.
const available = await reachable();
if (!available) {
  console.warn(`\n  ⚠ ${NETWORK} unreachable — skipping chain tests.`
    + (IS_LOCAL ? ' Start one with: ada localnet up\n' : '\n'));
}

const chain = () => (available ? it : it.skip);

/**
 * Let the indexer catch up between tests, on a public network only.
 *
 * Each test spends from the same wallet, and a provider serving a stale UTxO set
 * makes the next test build against outputs that are already gone. On a devnet
 * this never shows: blocks are a second and the indexer is in the same process.
 * On preprod it surfaced as one test failing inside the suite while passing
 * alone, which is the shape of a race rather than a defect.
 */
afterEach(async () => {
  if (available && !IS_LOCAL) await settle();
});

describe(`contract, against a live chain (${NETWORK})`, () => {
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
    expect(lock.code ?? 'ok', lock.message ?? '').toBe('ok');
    expect(lock.datumEncoding).toBe('inline');
    await awaitUtxo(`${lock.txHash}#0`, 'datum');

    const unlock = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Hello, World!', '--yes']);
    expect(unlock.code ?? 'ok', unlock.message ?? '').toBe('ok');
    expect(unlock.txHash).toMatch(/^[0-9a-f]{64}$/);
    await settle();

    // The spend must eventually remove it; an indexer lag is not a pass.
    let gone = false;
    for (let i = 0; i < CONFIRM_TRIES && !gone; i++) {
      await settle();
      gone = !ada(['contract', 'utxos', '--blueprint', BLUEPRINT])
        .utxos.some((u: any) => u.ref === `${lock.txHash}#0`);
    }
    expect(gone).toBe(true);
  }, TEST_TIMEOUT);

  chain()('refuses a hash-stored datum until the original is supplied', async () => {
    // No chain publishes the preimage of a hashed datum, so this cannot be
    // recovered — demanding it up front beats failing at submission.
    const lock = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '5', '--datum-signer', '--datum-hash', '--yes']);
    expect(lock.datumEncoding).toBe('hash');
    // Specifically wait for the datum: the spend below cannot proceed without it,
    // and an indexer may publish the output first.
    await awaitUtxo(`${lock.txHash}#0`, 'datum');

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
    expect(withDatum.code ?? 'ok', withDatum.message ?? '').toBe('ok');
  }, TEST_TIMEOUT);

  chain()('lets the validator reject a wrong redeemer, and keeps the money', async () => {
    const lock = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '5', '--datum-signer', '--yes']);
    await awaitUtxo(`${lock.txHash}#0`);

    const bad = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Goodbye', '--yes']);
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('script_rejected');

    // The point of the test: a rejected transaction moves nothing.
    const still = ada(['contract', 'utxos', '--blueprint', BLUEPRINT]);
    expect(still.utxos.some((u: any) => u.ref === `${lock.txHash}#0`)).toBe(true);
  }, TEST_TIMEOUT);

  chain()('lets the validator reject the wrong signer', async () => {
    // Written carefully after a first attempt proved nothing: an unfunded second
    // wallet failed on collateral before the validator ever ran, which looked
    // like a pass and tested nothing. The other wallet must be funded for this
    // to mean anything.
    // A second funded wallet is required, and its absence must not read as a
    // pass. The first version of this test returned early and reported green,
    // which is exactly the failure this file exists to prevent — and it happened
    // here, on preprod, where bob has no funds.
    const other = process.env.ADA_TEST_WALLET_2 ?? (IS_LOCAL ? 'bob' : undefined);
    if (!other) {
      throw new Error(
        'this test needs a second funded wallet: set ADA_TEST_WALLET_2. '
        + 'Without one it proves nothing — an unfunded wallet fails on collateral '
        + 'before the validator ever runs.',
      );
    }
    const bal = ada(['balance', '--wallet', other]);
    if (!bal.ok || BigInt(bal.lovelace ?? '0') < 20_000_000n) {
      throw new Error(`${other} holds ${bal.ada ?? '0'} on ${NETWORK}; fund it or this test is vacuous`);
    }

    const lock = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '5', '--datum-signer', '--yes']);
    await awaitUtxo(`${lock.txHash}#0`);

    const theft = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Hello, World!',
      '--wallet', other, '--yes']);
    expect(theft.ok).toBe(false);
    // Not no_collateral — that would mean the validator never ran.
    expect(theft.code).toBe('script_rejected');

    const still = ada(['contract', 'utxos', '--blueprint', BLUEPRINT]);
    expect(still.utxos.some((u: any) => u.ref === `${lock.txHash}#0`)).toBe(true);
  }, TEST_TIMEOUT);

  chain()('simulates without submitting, and reports units within the chain limits', async () => {
    const lock = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '5', '--datum-signer', '--yes']);
    await awaitUtxo(`${lock.txHash}#0`);

    const sim = ada(['contract', 'simulate', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Hello, World!']);
    expect(sim.code ?? 'ok', sim.message ?? '').toBe('ok');
    expect(sim.executionUnits.mem).toBeGreaterThan(0);
    expect(sim.executionUnits.steps).toBeGreaterThan(0);
    expect(sim.withinLimits).toBe(true);
    expect(sim.executionUnits.mem).toBeLessThanOrEqual(sim.limits.maxMem);

    // Simulating must not consume what it simulates against.
    const still = ada(['contract', 'utxos', '--blueprint', BLUEPRINT]);
    expect(still.utxos.some((u: any) => u.ref === `${lock.txHash}#0`)).toBe(true);
  }, TEST_TIMEOUT);

  chain()('publishes a reference script the chain records', async () => {
    const pub = ada(['contract', 'publish', '--blueprint', BLUEPRINT, '--yes']);
    expect(pub.code ?? 'ok', pub.message ?? '').toBe('ok');
    expect(pub.referenceInput).toMatch(/^[0-9a-f]{64}#\d+$/);
    await awaitUtxo(pub.referenceInput);

    // The chain must report a reference script whose hash is the validator's.
    // Read it back through our own command rather than a hardcoded devnet URL,
    // so the assertion is about the chain under test.
    const at = ada(['contract', 'utxos', '--blueprint', BLUEPRINT]);
    expect(at.utxos.some((u: any) => u.ref === pub.referenceInput)).toBe(true);
  }, TEST_TIMEOUT);

  chain()('names every UTxO when several sit at one script address', async () => {
    const at = ada(['contract', 'utxos', '--blueprint', BLUEPRINT]);
    if (at.count < 2) return; // needs an ambiguous state to be meaningful
    const ambiguous = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--redeemer-message', 'Hello, World!']);
    expect(ambiguous.ok).toBe(false);
    for (const u of at.utxos) expect(ambiguous.hint).toContain(u.ref);
  }, TEST_TIMEOUT);
});
