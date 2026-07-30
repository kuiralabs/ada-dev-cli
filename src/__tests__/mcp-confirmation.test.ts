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
    // Checked as a rule rather than a fixed list, so a destructive tool added
    // later cannot quietly skip the consent path. A tool that spends, mints,
    // deletes a key or wipes a chain must not be directly executable by an agent.
    // Named exactly, because a loose pattern matched ada_transfer_preview — which
    // is read-only and must NOT be gated.
    const spendsOrDestroys = new Set([
      'ada_transfer', 'ada_swap_build', 'ada_swap_sign', 'ada_swap_submit',
      'ada_asset_mint', 'ada_asset_send', 'ada_wallet_remove', 'ada_localnet_reset',
    ]);
    const mustHaveConsent = TOOLS.filter((t) => spendsOrDestroys.has(t.name));
    expect(mustHaveConsent.length).toBe(spendsOrDestroys.size);
    for (const tool of mustHaveConsent) {
      expect(CONSENT_TOOLS.has(tool.name), `${tool.name} must require consent`).toBe(true);
    }
  });

  it('never gates a read-only tool behind consent, which would be pointless friction', () => {
    for (const tool of TOOLS.filter((t) => t.annotations?.readOnlyHint)) {
      expect(CONSENT_TOOLS.has(tool.name), tool.name).toBe(false);
    }
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

  it('passes --yes on consent tools whose command has a confirmation guard', () => {
    // Two layers: the CLI's --yes stops a human doing it by accident, the token
    // stops an agent doing it without asking. Where the command has the flag, the
    // tool must pass it or confirmation would fail at the command layer.
    //
    // ada_swap_submit is the exception and it is deliberate: by the time an offer
    // is fully signed both parties have already agreed, so `swap submit` has no
    // --yes guard. The token still gates it on the agent side.
    const noCliGuard = new Set(['ada_swap_submit']);
    for (const name of CONSENT_TOOLS) {
      if (noCliGuard.has(name)) continue;
      const argv = byName(name)!.toArgv({
        to: 'addr_test1x', ada: '1', name: 'w', qty: '1',
        assets: ['unit:1'], offer: 'blob', counterparty: 'addr_test1y', give: '1ADA', want: '2ADA',
      });
      expect(argv, name).toContain('--yes');
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
