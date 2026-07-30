// The two-step confirmation store.
//
// This is the only thing standing between an agent and spending money without
// asking, so it gets tested as a security boundary rather than a cache. The
// property that matters: an agent cannot obtain execution without a token it did
// not mint, and a token works exactly once.
//
// Time is injected rather than slept on, so expiry is tested in microseconds.

import { describe, it, expect } from 'vitest';
import { createConfirmationStore, DEFAULT_TTL_MS } from '../lib/mcp/confirmation.ts';
import { TOOLS, CONSENT_TOOLS, byName } from '../lib/mcp/tools.ts';

const op = (tool = 'ada_transfer') => ({
  tool,
  args: { to: 'addr_test1abc', ada: '10' },
  description: 'Send 10 ADA to addr_test1abc',
});

describe('a token is single use', () => {
  it('redeems once and then never again', () => {
    const store = createConfirmationStore();
    const pending = store.create(op());
    expect(store.redeem(pending.token)?.tool).toBe('ada_transfer');
    // A replayed token must not send a second time.
    expect(store.redeem(pending.token)).toBeNull();
  });

  it('leaves nothing behind after redemption', () => {
    const store = createConfirmationStore();
    const pending = store.create(op());
    store.redeem(pending.token);
    expect(store.size()).toBe(0);
  });
});

describe('a token cannot be guessed or forged', () => {
  it('rejects a token that was never issued', () => {
    const store = createConfirmationStore();
    store.create(op());
    expect(store.redeem('00000000-0000-0000-0000-000000000000')).toBeNull();
    expect(store.redeem('')).toBeNull();
  });

  it('issues a distinct token every time', () => {
    const store = createConfirmationStore();
    const tokens = new Set(Array.from({ length: 200 }, () => store.create(op()).token));
    expect(tokens.size).toBe(200);
  });

  it('issues tokens long enough not to be brute-forced', () => {
    const store = createConfirmationStore();
    // A UUID is 36 characters; anything much shorter would be worth worrying about.
    expect(store.create(op()).token.length).toBeGreaterThanOrEqual(32);
  });
});

describe('expiry', () => {
  it('refuses a token past its lifetime', () => {
    let clock = 1_000;
    const store = createConfirmationStore({ ttlMs: 5_000, now: () => clock });
    const pending = store.create(op());
    clock += 5_001;
    // Consent the user gave and then abandoned must not execute later, against a
    // chain state that has moved.
    expect(store.redeem(pending.token)).toBeNull();
  });

  it('accepts a token just inside its lifetime', () => {
    let clock = 1_000;
    const store = createConfirmationStore({ ttlMs: 5_000, now: () => clock });
    const pending = store.create(op());
    clock += 4_999;
    expect(store.redeem(pending.token)).not.toBeNull();
  });

  it('drops expired entries when a new one is created', () => {
    let clock = 0;
    const store = createConfirmationStore({ ttlMs: 1_000, now: () => clock });
    store.create(op());
    store.create(op());
    expect(store.size()).toBe(2);
    clock += 2_000;
    store.create(op());
    // Declined prompts must not accumulate across a long session.
    expect(store.size()).toBe(1);
  });

  it('defaults to a window measured in minutes, not hours', () => {
    expect(DEFAULT_TTL_MS).toBe(5 * 60 * 1000);
  });
});

describe('the tool surface is internally consistent', () => {
  it('gates every money-moving or key-deleting tool behind consent', () => {
    // Adding a destructive tool without a consent description would let an agent
    // execute it directly, so the two lists are checked against each other.
    const expected = ['ada_transfer', 'ada_wallet_remove', 'ada_localnet_reset'];
    expect([...CONSENT_TOOLS].sort()).toEqual(expected.sort());
  });

  it('marks every consent tool as destructive', () => {
    for (const name of CONSENT_TOOLS) {
      expect(byName(name)?.annotations?.destructiveHint, name).toBe(true);
    }
  });

  it('never marks a consent tool as read-only', () => {
    for (const name of CONSENT_TOOLS) {
      expect(byName(name)?.annotations?.readOnlyHint, name).toBeUndefined();
    }
  });

  it('has a handler command and an argv builder for every tool', () => {
    for (const tool of TOOLS) {
      expect(tool.command, tool.name).toBeTruthy();
      expect(typeof tool.toArgv, tool.name).toBe('function');
    }
  });

  it('gives every tool a unique name', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('passes --yes on every consent tool, since consent is enforced by the token', () => {
    // The flag is what the CLI requires; the token is what the agent cannot forge.
    // Both must be present or confirmation would fail at the command layer.
    for (const name of CONSENT_TOOLS) {
      const tool = byName(name)!;
      expect(tool.toArgv({ to: 'addr_test1x', ada: '1', name: 'w' }), name).toContain('--yes');
    }
  });

  it('never passes --yes on a read-only tool', () => {
    for (const tool of TOOLS.filter((t) => t.annotations?.readOnlyHint)) {
      expect(tool.toArgv({ to: 'addr_test1x', ada: '1', address: 'addr_test1x' }), tool.name)
        .not.toContain('--yes');
    }
  });
});

describe('argv construction', () => {
  it('threads an explicit network through', () => {
    expect(byName('ada_balance')!.toArgv({ network: 'preprod' })).toEqual(['--network', 'preprod']);
  });

  it('omits network entirely when not given', () => {
    expect(byName('ada_balance')!.toArgv({})).toEqual([]);
  });

  it('ignores an empty string as if absent', () => {
    // An agent filling a schema often sends "" rather than omitting a field.
    expect(byName('ada_balance')!.toArgv({ target: '', network: '' })).toEqual([]);
  });
});
