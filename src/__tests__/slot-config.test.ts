// Turning slots into time.
//
// This is the quiet kind of wrong. A transaction declares validity in slots, a
// validator reads the same window in POSIX milliseconds, and a bad conversion
// does not fail — it asks the script a different question than the ledger will,
// so the two disagree only at submission.
//
// MeshJS's built-in `testnet` entry is { zeroTime: 0, zeroSlot: 0, slotLength: 0 },
// which maps every slot to 1970. Passing no config meant exactly that, and it
// produced both failure directions: transactions the node would reject were built
// happily, and transactions the node would accept were refused before building.

import { describe, it, expect } from 'vitest';
import { resolveSlotConfig, describeSlotConfig } from '../lib/slot-config.ts';

const devnet = (adminUrl?: string) => ({
  name: 'devnet', isLocal: true, adminUrl, apiUrl: 'http://localhost:8080',
} as any);
const preprod = { name: 'preprod', isLocal: false, apiUrl: 'https://x' } as any;

/** A devnet whose genesis says it began at a known moment. */
function withGenesis(systemStart: string, slotLength = 1) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ systemStart, slotLength, epochLength: 600 }), { status: 200 },
  )) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

describe('a local devnet takes its config from its own genesis', () => {
  it('reads systemStart and slotLength', async () => {
    const restore = withGenesis('2026-07-31T05:53:21Z');
    try {
      const r = await resolveSlotConfig(devnet('http://localhost:10000'));
      expect(r.source).toBe('genesis');
      expect(r.config.zeroTime).toBe(Date.parse('2026-07-31T05:53:21Z'));
      expect(r.config.slotLength).toBe(1000); // seconds in the genesis, ms in the config
      expect(r.config.zeroSlot).toBe(0);
    } finally { restore(); }
  });

  it('verifies against the tip and agrees when it should', async () => {
    const restore = withGenesis('2026-07-31T05:53:21Z');
    try {
      const zero = Date.parse('2026-07-31T05:53:21Z') / 1000;
      const r = await resolveSlotConfig(devnet('http://localhost:10000'),
        { slot: 3031, time: zero + 3031 });
      expect(r.verified).toBe(true);
      expect(r.driftSeconds).toBe(0);
    } finally { restore(); }
  });

  it('reports a disagreement rather than trusting itself', async () => {
    // The whole point: a config nobody checked is how fifty-six years of drift
    // goes unnoticed.
    const restore = withGenesis('2020-01-01T00:00:00Z');
    try {
      const r = await resolveSlotConfig(devnet('http://localhost:10000'),
        { slot: 3031, time: Date.parse('2026-07-31T05:53:21Z') / 1000 });
      expect(r.verified).toBe(false);
      expect(Math.abs(r.driftSeconds!)).toBeGreaterThan(1_000_000);
      expect(describeSlotConfig(r)).toMatch(/DISAGREES/);
    } finally { restore(); }
  });

  it('falls back to the built-in when the genesis cannot be read', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    try {
      const r = await resolveSlotConfig(devnet('http://localhost:10000'));
      expect(r.source).toBe('built-in');
    } finally { globalThis.fetch = original; }
  });
});

describe('the built-in config for a public network is used, and still checked', () => {
  it('agrees with a real preprod tip', async () => {
    // Preprod: zeroTime 1655769600000 at zeroSlot 86400, one second per slot.
    // Slot 129797048 was observed at 1785480248.
    const r = await resolveSlotConfig(preprod, { slot: 129_797_048, time: 1_785_480_248 });
    expect(r.source).toBe('built-in');
    expect(r.verified).toBe(true);
    expect(r.driftSeconds).toBe(0);
  });

  it('would catch a built-in gone stale after a hard fork', async () => {
    // A hardcoded table is exactly what a fork makes quietly wrong, and nothing
    // about a wrong validity window announces itself.
    const r = await resolveSlotConfig(preprod, { slot: 129_797_048, time: 1_785_480_248 + 86_400 });
    expect(r.verified).toBe(false);
  });

  it('says unverified rather than verified when there is no tip to check against', async () => {
    const r = await resolveSlotConfig(preprod);
    expect(r.verified).toBeUndefined();
    expect(describeSlotConfig(r)).toMatch(/unverified/);
  });

  it('tolerates a few seconds between a slot beginning and a block being seen', async () => {
    const r = await resolveSlotConfig(preprod, { slot: 129_797_048, time: 1_785_480_248 + 3 });
    expect(r.verified).toBe(true);
  });
});
