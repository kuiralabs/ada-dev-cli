// The contract command's own logic: dispatch, argument handling, and the
// refusals. Offline — nothing here touches a chain.
//
// These cover the layer between the blueprint reader and the tx builder, which
// had no tests at all: a bad subcommand, a missing datum, the wrong datum
// encoding, and the collateral arithmetic that used to be a hardcoded 5 ADA.

import { describe, it, expect } from 'vitest';
import { parseArgs } from '../lib/argv.ts';
import { AdaError } from '../lib/errors.ts';
import { requiredCollateral } from '../lib/tx-common.ts';
import contract, { datumModeOf } from '../commands/contract.ts';
import type { UTxO } from '@meshsdk/core';
import { TOOLS, CONSENT_TOOLS, byName } from '../lib/mcp/tools.ts';

const run = (argv: string[]) => contract(parseArgs(['contract', ...argv]));

describe('subcommand dispatch', () => {
  it('names the subcommands when none is given', async () => {
    // The list is in the hint rather than the message, which is where the JSON
    // envelope puts actionable text.
    await expect(run([])).rejects.toThrow(/needs a subcommand/);
    await run([]).catch((e: AdaError) => {
      expect(e.hint).toContain('inspect, address, lock, unlock');
    });
  });

  it('rejects an unknown subcommand rather than guessing', async () => {
    // `deploy` is the one people will reach for, and it does not exist here.
    await expect(run(['deploy'])).rejects.toThrow(/unknown contract subcommand: deploy/);
  });
});

describe('lock refuses to guess', () => {
  const bp = 'src/__tests__/fixtures';

  it('requires an amount', async () => {
    await expect(run(['lock', '--datum-signer', '--blueprint', bp]))
      .rejects.toThrow(/needs --amount/);
  });

  it('requires a datum, since a spending validator is always given one', async () => {
    await expect(run(['lock', '--amount', '5', '--blueprint', bp]))
      .rejects.toThrow(/needs a datum/);
  });

  it('rejects malformed datum JSON with the parse error', async () => {
    await expect(run(['lock', '--amount', '5', '--datum', '{oops', '--blueprint', bp]))
      .rejects.toThrow(/--datum is not valid JSON/);
  });
});

describe('unlock refuses to guess', () => {
  const bp = 'src/__tests__/fixtures';

  it('requires a redeemer', async () => {
    await expect(run(['unlock', '--blueprint', bp])).rejects.toThrow(/needs a redeemer/);
  });

  it('rejects malformed redeemer JSON', async () => {
    await expect(run(['unlock', '--redeemer', '[1,', '--blueprint', bp]))
      .rejects.toThrow(/--redeemer is not valid JSON/);
  });
});

describe('collateral is derived from the chain, not chosen', () => {
  // It was a hardcoded 5 ADA. The ledger's rule is collateralPercent of the fee,
  // and the largest possible fee is bounded by the linear fee model at max size.
  const devnet = { minFeeA: 44, minFeeB: 155381, maxTxSize: 16384, collateralPercent: 150 };

  it('covers 150% of the largest fee the fee model permits', () => {
    const maxFee = 44 * 16384 + 155381;          // 876,277
    expect(requiredCollateral(devnet)).toBe(BigInt(Math.ceil(maxFee * 1.5)));
  });

  it('scales with the chain rather than staying fixed', () => {
    // Not exactly double: each result rounds up independently, so doubling the
    // percentage can land one lovelace below twice the rounded-up half.
    const single = requiredCollateral(devnet);
    const doubled = requiredCollateral({ ...devnet, collateralPercent: 300 });
    expect(doubled).toBeGreaterThan(single);
    expect(doubled - single * 2n).toBeGreaterThanOrEqual(-1n);
    expect(doubled - single * 2n).toBeLessThanOrEqual(0n);
  });

  it('grows when the fee model does', () => {
    expect(requiredCollateral({ ...devnet, minFeeA: 88 }))
      .toBeGreaterThan(requiredCollateral(devnet));
  });

  it('rounds up, never leaving a shortfall', () => {
    // 101% of an odd fee must not truncate below the requirement.
    const odd = { minFeeA: 1, minFeeB: 1, maxTxSize: 1, collateralPercent: 101 };
    expect(requiredCollateral(odd)).toBeGreaterThanOrEqual(2n);
  });
});

describe('the agent surface covers every contract subcommand', () => {
  const names = TOOLS.filter((t) => t.command === 'contract').map((t) => t.name);

  it('exposes all four', () => {
    expect(names.sort()).toEqual([
      'ada_contract_address', 'ada_contract_inspect', 'ada_contract_lock', 'ada_contract_unlock',
    ]);
  });

  it('gates both money paths behind consent', () => {
    // A --yes flag protects a human because a human types it deliberately. An
    // agent would simply pass it, so lock and unlock must need a second call.
    expect(CONSENT_TOOLS.has('ada_contract_lock')).toBe(true);
    expect(CONSENT_TOOLS.has('ada_contract_unlock')).toBe(true);
  });

  it('never marks a money path read-only', () => {
    for (const n of ['ada_contract_lock', 'ada_contract_unlock']) {
      expect(byName(n)?.annotations?.readOnlyHint).not.toBe(true);
    }
  });

  it('marks the read-only pair honestly', () => {
    for (const n of ['ada_contract_inspect', 'ada_contract_address']) {
      expect(byName(n)?.annotations?.readOnlyHint).toBe(true);
      expect(CONSENT_TOOLS.has(n)).toBe(false);
    }
  });

  it('names the wallet in the consent text', () => {
    // An agent may have switched wallets earlier in the session; consent against
    // a vague description is not consent for the account it turns out to mean.
    const text = byName('ada_contract_lock')!.describeForConsent!({ ada: '5', wallet: 'bob' });
    expect(text).toContain('bob');
    expect(text).toContain('5');
  });

  it('warns that locked funds can be unrecoverable', () => {
    const text = byName('ada_contract_lock')!.describeForConsent!({ ada: '5' });
    expect(text).toMatch(/unrecoverable|only by/i);
  });

  it('always passes --yes, since the second call is the consent', () => {
    for (const n of ['ada_contract_lock', 'ada_contract_unlock']) {
      const argv = byName(n)!.toArgv!({ ada: '5', redeemerMessage: 'hi' });
      expect(argv).toContain('--yes');
    }
  });

  it('threads blueprint selection through to the command', () => {
    const argv = byName('ada_contract_address')!.toArgv!({
      blueprint: '/tmp/p.json', module: 'oneshot', validator: 'gift_card', params: '["ab"]',
    });
    expect(argv).toEqual(expect.arrayContaining([
      'address', '--blueprint', '/tmp/p.json', '--module', 'oneshot',
      '--validator', 'gift_card', '--params', '["ab"]',
    ]));
  });

  it('omits flags that were not supplied, rather than sending empty ones', () => {
    const argv = byName('ada_contract_inspect')!.toArgv!({});
    expect(argv).toEqual(['inspect']);
  });
});

describe('the datum encoding decides how it must be supplied back', () => {
  // Both branches are now exercised against a real chain — a --datum-hash lock
  // followed by an unlock that refuses without the datum and succeeds with it —
  // but the decision itself is pure and belongs in a fast test.
  const at = (output: Record<string, unknown>): UTxO => ({
    input: { txHash: 'abc123', outputIndex: 0 },
    output: { address: 'addr_test1w...', amount: [{ unit: 'lovelace', quantity: '5000000' }], ...output },
  } as UTxO);

  it('uses the inline datum when the output carries one', () => {
    const mode = datumModeOf(at({ plutusData: 'd8799f581c52ff' }), undefined);
    expect(mode.inline).toBe(true);
  });

  it('ignores a supplied datum when an inline one is present', () => {
    // The output is authoritative. Preferring a flag over what the chain holds
    // would let a caller present a datum the validator was not given.
    expect(datumModeOf(at({ plutusData: 'd8799f581c52ff' }), '{"alternative":0,"fields":[]}').inline)
      .toBe(true);
  });

  it('demands the original when the output stores only a hash', () => {
    try {
      datumModeOf(at({ dataHash: 'f21a6886d9badd82' }), undefined);
      expect.unreachable();
    } catch (e) {
      expect((e as AdaError).code).toBe('datum_required');
      // No chain publishes the preimage, so "fetch it" is not advice we can give.
      expect((e as AdaError).hint).toContain('--datum');
    }
  });

  it('accepts the supplied datum for a hash-stored output', () => {
    const mode = datumModeOf(at({ dataHash: 'f21a' }), '{"alternative":0,"fields":["52ff"]}');
    expect(mode.inline).toBe(false);
    expect(mode.value).toEqual({ alternative: 0, fields: ['52ff'] });
  });

  it('rejects malformed supplied datum JSON', () => {
    expect(() => datumModeOf(at({ dataHash: 'f21a' }), '{oops')).toThrow(/not valid JSON/);
  });

  it('refuses an output with no datum at all', () => {
    // A spending validator is always given a datum; an output without one cannot
    // be spent by one, and saying so beats a builder error.
    try {
      datumModeOf(at({}), undefined);
      expect.unreachable();
    } catch (e) {
      expect((e as AdaError).code).toBe('no_datum');
    }
  });

  it('treats an explicitly null datum as absent, not as inline', () => {
    // The indexer returns nulls rather than omitting the fields.
    try {
      datumModeOf(at({ plutusData: null, dataHash: null }), undefined);
      expect.unreachable();
    } catch (e) {
      expect((e as AdaError).code).toBe('no_datum');
    }
  });
});
