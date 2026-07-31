// The mempool answer, and the shape it has to have.
//
// The reason this exists at all: an indexer cannot see a mempool, so without a
// node "not found" covered both "still queued, wait" and "dropped, act". Those
// are the two worst things to conflate for somebody staring at a hash.

import { describe, it, expect } from 'vitest';
import { hasTransaction } from '../lib/mempool.ts';

const HASH = '2a595521b72569f5d5a97a55e3f84968f3c3deafbc2ac074daa1b7702961c948';

describe('asking a node about its mempool', () => {
  it('reports unavailable rather than throwing when nothing is listening', async () => {
    // A second opinion must never fail an operation that already has a first —
    // the same rule --verify-budget follows, and what makes this safe to call
    // unconditionally.
    const answer = await hasTransaction('http://localhost:59999', HASH);
    expect(answer.available).toBe(false);
    if (!answer.available) expect(answer.reason).toBeTruthy();
  }, 20_000);

  it('reports unavailable for a URL that is not a websocket endpoint', async () => {
    const answer = await hasTransaction('http://localhost:1', HASH);
    expect(answer.available).toBe(false);
  }, 20_000);

  it('distinguishes "not available" from "available and absent"', async () => {
    // The whole point of the type: `available: false` means we could not ask,
    // and `present: false` means we asked and it is not there. Collapsing them
    // into one boolean is the bug this shape prevents.
    const answer = await hasTransaction('http://localhost:59999', HASH);
    expect(answer).not.toHaveProperty('present');
  }, 20_000);
});
