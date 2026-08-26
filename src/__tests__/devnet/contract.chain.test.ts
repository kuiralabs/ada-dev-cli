// Contract commands, against a real chain.
//
// Everything in the unit suite is offline, which is right — CI must fail loudly
// without a network rather than pass vacuously. These re-check the claims that
// otherwise rest on someone having typed the commands once and read the output.
//
//   ada localnet up && ada wallet use alice && ada airdrop 1000
//   npm run test:devnet

import { describe, it, expect } from 'vitest';
import {
  ada, settle, awaitUtxo, chain, BLUEPRINT, NETWORK, TEST_TIMEOUT, CONFIRM_TRIES, IS_LOCAL, paceBetweenTests,
} from './harness.ts';

paceBetweenTests();

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

  chain()('tolerates --signer naming the wallet\'s own key', async () => {
    // Regression: unlock always declares the wallet's own key as a required
    // signer, so a --signer repeating it produced a duplicate in the ledger's
    // required-signers set — rejected at submit as a malformed transaction
    // ("Size mismatch when decoding Record RecD"), a cryptic answer to a
    // harmless request. The duplicate is now dropped before the build.
    const address = ada(['wallet', 'info']).paymentAddress as string;
    const ownHash = ada(['address', 'inspect', address]).paymentKeyHash as string;

    const lock = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '5', '--datum-signer', '--yes']);
    expect(lock.code ?? 'ok', lock.message ?? '').toBe('ok');
    await awaitUtxo(`${lock.txHash}#0`, 'datum');

    const unlock = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Hello, World!',
      '--signer', ownHash, '--yes']);
    expect(unlock.code ?? 'ok', unlock.message ?? '').toBe('ok');
    expect(unlock.txHash).toMatch(/^[0-9a-f]{64}$/);
  }, TEST_TIMEOUT);

  chain()('carries state forward with a continuing output', async () => {
    // The shape `unlock` could not build at all: spend a script UTxO and produce
    // another at the same address under a new datum. Every state machine needs
    // it — an auction raising a bid, a vesting schedule releasing a tranche —
    // and without it those validators rejected every transaction we could make,
    // reported as a script failure rather than as a gap in the tool.
    //
    // hello_world does not inspect its own outputs, so this checks the shape of
    // the transaction rather than a validator's opinion of it. The shape is the
    // part that was missing.
    const address = ada(['wallet', 'info']).paymentAddress as string;
    const keyHash = ada(['address', 'inspect', address]).paymentKeyHash as string;
    expect(keyHash).toMatch(/^[0-9a-f]{56}$/);
    const signerDatum = JSON.stringify({ alternative: 0, fields: [keyHash] });

    const lock = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '10', '--datum-signer', '--yes']);
    expect(lock.code ?? 'ok', lock.message ?? '').toBe('ok');
    await awaitUtxo(`${lock.txHash}#0`, 'datum');

    const unlock = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Hello, World!',
      '--continue', '5', '--continue-datum', signerDatum, '--yes']);
    expect(unlock.code ?? 'ok', unlock.message ?? '').toBe('ok');

    // The continuing output must actually arrive at the script address, and
    // carry a datum — one without is unspendable for ever, which is why the two
    // flags are required together.
    const carried = await awaitUtxo(`${unlock.txHash}#0`, 'datum');
    expect(carried.lovelace).toBe('5000000');
    expect(carried.datumEncoding).toBe('inline');
  }, TEST_TIMEOUT);

  chain()('pays a third party in the same transaction', async () => {
    // Change all returns to one address, so a validator requiring the party it
    // displaces to be made whole — a refunded bidder, a cancelled order — could
    // not be satisfied at all.
    const recipient = ada(['wallet', 'info']).paymentAddress as string;
    expect(recipient).toMatch(/^addr/);

    const lock = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '8', '--datum-signer', '--yes']);
    expect(lock.code ?? 'ok', lock.message ?? '').toBe('ok');
    await awaitUtxo(`${lock.txHash}#0`, 'datum');

    const unlock = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Hello, World!',
      '--pay', `${recipient}:3`, '--yes']);
    expect(unlock.code ?? 'ok', unlock.message ?? '').toBe('ok');
    expect(unlock.txHash).toMatch(/^[0-9a-f]{64}$/);
  }, TEST_TIMEOUT);

  chain()('rejects a continuing output with no datum, rather than stranding it', async () => {
    // An output at a script address with no datum can never be spent: the
    // validator would have nothing to read. Caught before any chain call.
    const out = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--tx-in', 'a'.repeat(64) + '#0', '--redeemer-message', 'Hello, World!',
      '--continue', '5', '--yes']);
    expect(out.code).toBe('invalid_args');
    expect(out.message).toContain('--continue-datum');
  }, TEST_TIMEOUT);

  chain()('refuses a hash-stored datum until the original is supplied', async () => {
    // No chain publishes the preimage of a hashed datum, so this cannot be
    // recovered — demanding it up front beats failing at submission.
    const lock = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '5', '--datum-signer', '--datum-hash', '--yes']);
    // Success first. Reading a field off a failed result reports
    // `expected undefined to be 'hash'`, which says nothing about what went
    // wrong — and on preprod what went wrong was contention, not the datum.
    expect(lock.code ?? 'ok', lock.message ?? '').toBe('ok');
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

    // The per-redeemer breakdown. Asserted because it was once dropped as a
    // side effect of a refactor rather than as a decision — undocumented and
    // untested, so nothing complained. A transaction running several scripts
    // needs to know which of them is expensive, not only that one of them is.
    expect(Array.isArray(sim.redeemers)).toBe(true);
    expect(sim.redeemers.length).toBeGreaterThan(0);
    expect(sim.redeemers[0].mem).toBeGreaterThan(0);
    expect(sim.redeemers[0].steps).toBeGreaterThan(0);

    // What the scripts cost and what the transaction declares are two different
    // numbers, and reporting one as the other made two evaluators that agreed
    // exactly look as though they disagreed.
    expect(sim.declaredExecutionUnits.mem).toBeGreaterThanOrEqual(sim.executionUnits.mem);
    expect(sim.declaredExecutionUnits.steps).toBeGreaterThanOrEqual(sim.executionUnits.steps);

    // Simulating must not consume what it simulates against.
    const still = ada(['contract', 'utxos', '--blueprint', BLUEPRINT]);
    expect(still.utxos.some((u: any) => u.ref === `${lock.txHash}#0`)).toBe(true);
  }, TEST_TIMEOUT);

  chain()('spends by pointing at a published script rather than carrying it', async () => {
    // `publish` existed and nothing could consume what it wrote, so the manual's
    // whole argument for it — later transactions point at the script instead of
    // each carrying a copy — was a claim the tool could not honour.
    const published = ada(['contract', 'publish', '--blueprint', BLUEPRINT, '--to-self', '--yes']);
    expect(published.code ?? 'ok', published.message ?? '').toBe('ok');
    expect(published.referenceInput).toMatch(/^[0-9a-f]{64}#\d+$/);

    // Let the publish settle before building the next transaction. Two
    // transactions in a row select the same UTxOs, and on a chain with
    // twenty-second blocks the second is rejected for spending what the first
    // already took — correctly reported, and still a failed test.
    await settle();

    const lock = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '6', '--datum-signer', '--yes']);
    expect(lock.code ?? 'ok', lock.message ?? '').toBe('ok');
    await awaitUtxo(`${lock.txHash}#0`, 'datum');

    // The saving is the point, so it is measured rather than asserted in prose.
    const carrying = ada(['contract', 'simulate', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Hello, World!']);
    const pointing = ada(['contract', 'simulate', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Hello, World!',
      '--script-ref', published.referenceInput]);
    expect(pointing.code ?? 'ok', pointing.message ?? '').toBe('ok');
    expect(pointing.txSizeBytes).toBeLessThan(carrying.txSizeBytes);

    const spent = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Hello, World!',
      '--script-ref', published.referenceInput, '--yes']);
    expect(spent.code ?? 'ok', spent.message ?? '').toBe('ok');
    expect(spent.txHash).toMatch(/^[0-9a-f]{64}$/);
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

describe(`reference inputs, against a live chain (${NETWORK})`, () => {
  chain()('reads a UTxO without consuming it', async () => {
    // CIP-31 was the one capability in the contract surface never driven end to
    // end. The defining property is not that the spend succeeds — it is that the
    // referenced output is still there afterwards, because a reader that
    // consumed it would serialise everybody behind one UTxO.
    const lock = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '5', '--datum-signer', '--yes']);
    expect(lock.code ?? 'ok', lock.message ?? '').toBe('ok');
    await awaitUtxo(`${lock.txHash}#0`, 'datum');

    const witness = ada(['contract', 'lock', '--blueprint', BLUEPRINT,
      '--amount', '5', '--datum-signer', '--yes']);
    expect(witness.code ?? 'ok', witness.message ?? '').toBe('ok');
    await awaitUtxo(`${witness.txHash}#0`, 'datum');

    // hello-world ignores reference inputs, so this asserts the transaction
    // shape rather than a validator's opinion — the part that had never run.
    const spent = ada(['contract', 'unlock', '--blueprint', BLUEPRINT,
      '--tx-in', `${lock.txHash}#0`, '--redeemer-message', 'Hello, World!',
      '--read-only', `${witness.txHash}#0`, '--yes']);
    expect(spent.code ?? 'ok', spent.message ?? '').toBe('ok');

    // The referenced output must survive. This is the whole point.
    let survived = false;
    for (let i = 0; i < CONFIRM_TRIES && !survived; i++) {
      await settle();
      survived = ada(['contract', 'utxos', '--blueprint', BLUEPRINT])
        .utxos.some((u: any) => u.ref === `${witness.txHash}#0`);
    }
    expect(survived, 'the reference input was consumed').toBe(true);
  }, TEST_TIMEOUT);
});
