// `tx status`, against a real chain.
//
// The three states were verified by hand once each, which is the standard this
// suite exists to replace: a verification performed once is a claim rather than
// a check.
//
// The middle state is the one worth the trouble. An indexer cannot see a
// mempool, so before this command "not found" covered both "still queued, wait"
// and "dropped, act" — and those call for opposite responses.

import { describe, expect } from 'vitest';
import {
  ada, settle, chain, NETWORK, TEST_TIMEOUT, CONFIRM_TRIES, IS_LOCAL, paceBetweenTests,
} from './harness.ts';

paceBetweenTests();

/** A well-formed hash that no chain has ever seen. */
const NEVER_SUBMITTED = '0'.repeat(64);

describe(`tx status, against a live chain (${NETWORK})`, () => {
  chain()('reports a transaction the chain has recorded', async () => {
    const to = ada(['wallet', 'info']).paymentAddress as string;
    const sent = ada(['transfer', to, '2', '--yes']);
    expect(sent.code ?? 'ok', sent.message ?? '').toBe('ok');

    let seen: Record<string, any> | undefined;
    for (let i = 0; i < CONFIRM_TRIES; i++) {
      await settle();
      const status = ada(['tx', 'status', sent.txHash]);
      if (status.state === 'on-chain') { seen = status; break; }
    }

    expect(seen, 'the transaction never reached the chain').toBeDefined();
    expect(seen!.txHash).toBe(sent.txHash);
    // Providers differ on which they carry, but a confirmed transaction must be
    // placed somewhere — a state of on-chain with neither would be a shrug.
    expect(seen!.slot ?? seen!.block).toBeDefined();
  }, TEST_TIMEOUT);

  chain()('does not confuse a transaction it has never seen with one in flight', async () => {
    // The distinction the command exists for. `not-found` here must be a real
    // answer, not the absence of one.
    const status = ada(['tx', 'status', NEVER_SUBMITTED]);
    expect(status.code ?? 'ok', status.message ?? '').toBe('ok');
    expect(status.state).toBe('not-found');
    expect(status.txHash).toBe(NEVER_SUBMITTED);
  }, TEST_TIMEOUT);

  chain()('says whether the mempool was actually consulted', async () => {
    // Without a node there is no way to tell queued from dropped, and claiming
    // otherwise would be worse than admitting it. `checked` is what lets an
    // agent tell "we looked and it is gone" from "we could not look".
    const status = ada(['tx', 'status', NEVER_SUBMITTED]);
    expect(status.mempool).toBeDefined();
    expect(typeof status.mempool.checked).toBe('boolean');
    if (status.mempool.checked) expect(typeof status.mempool.present).toBe('boolean');
    else expect(status.mempool.reason).toBeTruthy();
  }, TEST_TIMEOUT);

  chain()('waits for confirmation rather than making the caller sleep', async () => {
    const to = ada(['wallet', 'info']).paymentAddress as string;
    const sent = ada(['transfer', to, '2', '--yes']);
    expect(sent.code ?? 'ok', sent.message ?? '').toBe('ok');

    // The point of --wait: this returns when the chain has it, without the
    // caller having written a poll loop of their own.
    const waited = ada(['tx', 'status', sent.txHash, '--wait']);
    expect(waited.code ?? 'ok', waited.message ?? '').toBe('ok');
    expect(waited.state).toBe('on-chain');
  }, TEST_TIMEOUT);

  chain()('never reports a submitted transaction as simply missing', async () => {
    // The regression that matters. Immediately after submitting, a transaction
    // is either queued or already in a block — "not-found" would mean the tool
    // had lost track of something it had just sent, which is the state this
    // command was built to end.
    //
    // On a devnet with one-second blocks it is usually on-chain by the time the
    // process starts; on preprod it is usually still queued. Both are correct
    // and neither is `not-found`.
    const to = ada(['wallet', 'info']).paymentAddress as string;
    const sent = ada(['transfer', to, '2', '--yes']);
    expect(sent.code ?? 'ok', sent.message ?? '').toBe('ok');

    const status = ada(['tx', 'status', sent.txHash]);

    // Already in a block is the best possible answer, and carries no mempool
    // field — once confirmed, what the mempool thinks is irrelevant.
    if (status.state === 'on-chain') return;

    if (status.mempool?.checked !== true) {
      // No Ogmios: the tool cannot distinguish queued from dropped, and says so
      // rather than guessing. Asserting a state here would assert the guess.
      expect(status.mempool?.reason).toBeTruthy();
      return;
    }
    expect(status.state, 'a transaction just submitted was reported missing').toBe('in-mempool');
  }, TEST_TIMEOUT);

  chain()('rejects a malformed hash before asking any chain about it', async () => {
    // A typo answered with "not found" reads as a chain problem; it is not.
    const status = ada(['tx', 'status', 'deadbeef']);
    expect(status.code).toBe('invalid_args');
    expect(status.message).toMatch(/not a transaction hash/);
  }, TEST_TIMEOUT);
});

describe(`tx status mempool visibility (${NETWORK})`, () => {
  chain()('reports the mempool as consulted where Ogmios is running', async () => {
    // Local only: we do not run a public network's infrastructure, so an absent
    // Ogmios there says nothing about this tool.
    if (!IS_LOCAL) return;

    const reachable = ada(['status']).ogmios?.reachable === true;
    if (!reachable) return; // Optional by design; its absence is not a failure.

    const status = ada(['tx', 'status', NEVER_SUBMITTED]);
    expect(status.mempool.checked).toBe(true);
    expect(status.mempool.present).toBe(false);
  }, TEST_TIMEOUT);
});
