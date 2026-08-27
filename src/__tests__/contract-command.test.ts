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
import { parseSignedQuantity } from '../lib/amount.ts';
import { readFileSync } from 'node:fs';
import contract, { datumModeOf, payoutOutputs } from '../commands/contract.ts';
import type { UTxO } from '@meshsdk/core';
import { TOOLS, CONSENT_TOOLS, byName } from '../lib/mcp/tools.ts';

const run = (argv: string[]) => contract(parseArgs(['contract', ...argv]));

describe('subcommand dispatch', () => {
  it('names the subcommands when none is given', async () => {
    // The list is in the hint rather than the message, which is where the JSON
    // envelope puts actionable text.
    await expect(run([])).rejects.toThrow(/needs a subcommand/);
    await run([]).catch((e: AdaError) => {
      expect(e.hint).toContain('build, check, inspect, address, utxos, lock, unlock');
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

describe('lock --mint, the creation-side twin of unlock --mint', () => {
  const bp = 'src/__tests__/fixtures';

  // Regression: before lock understood --mint, the flag was accepted and
  // silently ignored — a lock the user asked to carry a beacon was built
  // without one. Silently dropping a typed flag is exactly the failure
  // scriptlessValidity refuses for --signer/--read-only.
  it('rejects a malformed --mint spec instead of ignoring it', async () => {
    await expect(run(['lock', '--amount', '5', '--datum-signer', '--mint', 'NoColon',
      '--blueprint', bp]))
      .rejects.toThrow(/--mint expects <name>:<quantity>/);
  });

  it('requires the mint handler\'s own redeemer', async () => {
    await expect(run(['lock', '--amount', '5', '--datum-signer', '--mint', 'Badge:1',
      '--blueprint', bp]))
      .rejects.toThrow(/needs --mint-redeemer/);
  });

  it('names the missing mint handler when the validator has none', async () => {
    // hello_world declares spend + else only, so a lock-side mint under its
    // policy is impossible — say so rather than failing on-chain.
    await expect(run(['lock', '--amount', '5', '--datum-signer', '--mint', 'Badge:1',
      '--mint-redeemer', '[]', '--blueprint', bp]))
      .rejects.toThrow(/mint/);
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

  it('exposes every subcommand that an agent could want', () => {
    expect(names.sort()).toEqual([
      'ada_contract_address', 'ada_contract_inspect', 'ada_contract_lock',
      'ada_contract_mint', 'ada_contract_publish', 'ada_contract_simulate',
      'ada_contract_unlock',
    ]);
  });

  it('gates every money path behind consent', () => {
    // A --yes flag protects a human because a human types it deliberately. An
    // agent would simply pass it, so anything that spends must need a second call.
    for (const n of ['ada_contract_lock', 'ada_contract_unlock',
                     'ada_contract_publish', 'ada_contract_mint']) {
      expect(CONSENT_TOOLS.has(n), `${n} must require consent`).toBe(true);
    }
  });

  it('leaves simulate ungated, because it submits nothing', () => {
    // The whole point of simulate is to answer "what will this cost" before
    // committing. Requiring consent for a question defeats it.
    expect(CONSENT_TOOLS.has('ada_contract_simulate')).toBe(false);
    expect(byName('ada_contract_simulate')?.annotations?.readOnlyHint).toBe(true);
  });

  it('warns that a burn is permanent, and a default publish is unrecoverable', () => {
    const burn = byName('ada_contract_mint')!.describeForConsent!({ name: 'X', qty: '-1' });
    expect(burn).toMatch(/burn/i);
    expect(burn).toMatch(/permanent/i);
    const pub = byName('ada_contract_publish')!.describeForConsent!({});
    expect(pub).toMatch(/nobody can spend|locked permanently/i);
    const recoverable = byName('ada_contract_publish')!.describeForConsent!({ toSelf: true });
    expect(recoverable).toMatch(/recoverable/i);
  });

  it('never marks a money path read-only', () => {
    for (const n of ['ada_contract_lock', 'ada_contract_unlock',
                     'ada_contract_publish', 'ada_contract_mint']) {
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

  it('forwards mint flags to the lock command', () => {
    const argv = byName('ada_contract_lock')!.toArgv!(
      { ada: '2', mint: 'Beacon:1', mintRedeemer: '[]' });
    expect(argv).toContain('--mint');
    expect(argv).toContain('Beacon:1');
    expect(argv).toContain('--mint-redeemer');
  });

  it('discloses a lock-side mint in the consent description', () => {
    const text = byName('ada_contract_lock')!.describeForConsent!(
      { ada: '2', mint: 'Beacon:1' });
    expect(text).toMatch(/minting Beacon:1/);
  });

  it('warns that locked funds can be unrecoverable', () => {
    const text = byName('ada_contract_lock')!.describeForConsent!({ ada: '5' });
    expect(text).toMatch(/unrecoverable|only by/i);
  });

  it('always passes --yes, since the second call is the consent', () => {
    for (const n of ['ada_contract_lock', 'ada_contract_unlock',
                     'ada_contract_publish', 'ada_contract_mint']) {
      const argv = byName(n)!.toArgv!({ ada: '5', redeemerMessage: 'hi', name: 'X' });
      expect(argv).toContain('--yes');
    }
  });

  it('never passes --yes on simulate, which has nothing to confirm', () => {
    expect(byName('ada_contract_simulate')!.toArgv!({ redeemerMessage: 'hi' })).not.toContain('--yes');
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

describe('simulate and unlock cannot drift apart', () => {
  // simulate exists to answer "what will unlock cost". If the two ever built
  // different transactions it would report a number for something nobody
  // submits — a confident wrong answer, which is worse than none. They share one
  // builder so divergence is impossible rather than merely unlikely; this pins
  // that they still do.
  const source = readFileSync(new URL('../commands/contract.ts', import.meta.url), 'utf8');

  it('both call the one shared builder', () => {
    const callers = [...source.matchAll(/await buildSpend\(/g)];
    expect(callers).toHaveLength(2);
  });

  it('neither assembles a spending transaction of its own', () => {
    // Exactly one place may wire up spendingPlutusScript for a spend.
    const spends = [...source.matchAll(/\.spendingPlutusScript\(/g)];
    expect(spends).toHaveLength(1);
  });

  it('every script path pledges collateral through one helper', () => {
    // Three commands run scripts. The amount and the selection rule must be the
    // same for all of them, or a transaction that simulates fine fails to build.
    expect([...source.matchAll(/selectCollateral\(/g)]).toHaveLength(1);
    expect([...source.matchAll(/pledgeCollateral\(/g)].length).toBeGreaterThanOrEqual(3);
  });
});

describe('quantities carry an operation in their sign', () => {
  // The ledger expresses burning as a negative mint, so the sign IS the
  // operation. `asset mint` rejects negatives because it only creates supply;
  // a Plutus policy does both through one field.
  it('accepts a positive quantity', () => {
    expect(parseSignedQuantity('100')).toBe(100n);
  });

  it('accepts a negative quantity, which burns', () => {
    expect(parseSignedQuantity('-1')).toBe(-1n);
  });

  it('rejects a typo as user error, not internal error', () => {
    // `--qty abc` reached BigInt() raw and surfaced as
    // "internal_error: Cannot convert abc to a BigInt", blaming the tool for
    // the user's typo.
    try { parseSignedQuantity('abc'); expect.unreachable(); } catch (e) {
      expect((e as AdaError).code).toBe('invalid_args');
      expect((e as AdaError).message).toContain('abc');
    }
  });

  it('rejects a fraction, since native assets are indivisible', () => {
    expect(() => parseSignedQuantity('1.5')).toThrow(/not a valid quantity/);
  });

  it('rejects zero, which is neither a mint nor a burn', () => {
    expect(() => parseSignedQuantity('0')).toThrow(/may not be zero/);
    expect(() => parseSignedQuantity('-0')).toThrow(/may not be zero/);
  });

  it('tolerates underscores and surrounding space', () => {
    expect(parseSignedQuantity(' 1_000 ')).toBe(1000n);
  });
});

describe('flags that cannot work are named, never ignored', () => {
  const bp = 'src/__tests__/fixtures';
  const KEY = 'b'.repeat(56);
  const REF = `${'a'.repeat(64)}#0`;

  it('refuses --signer where no validator runs', async () => {
    // Silently dropping a flag someone typed is how a security assumption goes
    // missing: they believe a second signature is required and it is not.
    await expect(run(['lock', '--amount', '5', '--datum-signer', '--signer', KEY, '--blueprint', bp]))
      .rejects.toThrow(/--signer has no effect/);
  });

  it('refuses --read-only where no validator runs', async () => {
    await expect(run(['publish', '--read-only', REF, '--blueprint', bp]))
      .rejects.toThrow(/--read-only has no effect/);
  });

  it('says why, not just that', async () => {
    await run(['lock', '--amount', '5', '--datum-signer', '--signer', KEY, '--blueprint', bp])
      .catch((e: AdaError) => expect(e.hint).toMatch(/checked by a validator/));
  });
});

describe('--wallet must never be silently ignored', () => {
  // Review once found `balance` and `utxos` ignoring it: `balance --wallet bob`
  // reported alice's balance with ok:true. `wallet info` had the same defect and
  // was missed, which a preprod run then caught the hard way — a test built a
  // datum around the wrong account's key and the validator rejected the spend.
  //
  // A flag that selects the wrong account is worse than one that does not exist.
  const source = readFileSync(new URL('../commands/wallet.ts', import.meta.url), 'utf8');

  it('resolves a name from the positional, then --wallet, then the active one', () => {
    expect(source).toContain("args.positionals[1] ?? flagValue(args, 'wallet') ?? config.activeWallet");
  });

  it('never falls straight from a positional to the active wallet', () => {
    // The shape of the original bug.
    expect(source).not.toMatch(/positionals\[1\]\s*\?\?\s*config\.activeWallet/);
  });
});

describe('--pay settles in native assets, not only ADA', () => {
  const bp = 'src/__tests__/fixtures';

  // An offer priced in a token could be created and found but never filled: the
  // only way to pay a third party took ADA. The two shapes are told apart by how
  // many colons a bech32 address does not contain.
  it('rejects a malformed payout by naming both shapes', async () => {
    await expect(run(['unlock', '--redeemer-message', 'x', '--pay', 'addr_test1abc', '--blueprint', bp]))
      .rejects.toThrow(/<address>:<ada> or <address>:<unit>:<quantity>/);
  });

  it('rejects more colons than either shape allows', async () => {
    await expect(run(['unlock', '--redeemer-message', 'x',
      '--pay', 'addr_test1abc:unit:1:extra', '--blueprint', bp]))
      .rejects.toThrow(/expects <address>/);
  });

  it('still rejects a payout that is not an address at all', async () => {
    await expect(run(['unlock', '--redeemer-message', 'x', '--pay', 'notanaddress:5', '--blueprint', bp]))
      .rejects.toThrow(/not a Cardano address/);
  });
});

describe('what a payout output actually holds', () => {
  // A real address: min-UTxO is computed from the serialized output, so a
  // placeholder would not tell us anything about the number.
  const ADDR = 'addr_test1qpf8cud6excflj787pgkfe0vlkpj5x7tz2fgsdtak69033dmha29vf5ajuhcslaaru44844juzssnkds30r300zwee4qkdrx2v';
  const FOO = '2b0f0c0a61f4525664aa2478e78358d67d783c58607e67540c521fe5464f4f';
  const COINS_PER_UTXO_SIZE = 4310;

  it('pays an ADA payout exactly what was asked, never more', () => {
    // 0.5 ADA is below min-UTxO. Topping it up would pay the recipient more
    // than the caller wrote, out of the caller's own pocket, silently.
    const [out] = payoutOutputs([{ address: ADDR, lovelace: 500_000n, assets: [] }], COINS_PER_UTXO_SIZE);
    expect(out.amount).toEqual([{ unit: 'lovelace', quantity: '500000' }]);
    expect(out.adaAttached).toBe(0n);
  });

  it('attaches the ADA a token output cannot exist without, and reports it', () => {
    const [out] = payoutOutputs(
      [{ address: ADDR, lovelace: 0n, assets: [{ unit: FOO, quantity: 50n }] }],
      COINS_PER_UTXO_SIZE,
    );
    expect(out.amount).toContainEqual({ unit: FOO, quantity: '50' });
    const attached = BigInt(out.amount.find((a) => a.unit === 'lovelace')?.quantity ?? '0');
    expect(attached).toBeGreaterThan(0n);
    // The whole of it came from the payer: the payout named no ADA at all.
    expect(out.adaAttached).toBe(attached);
  });
});

describe('--payouts says what a colon spec cannot', () => {
  const bp = 'src/__tests__/fixtures';
  const ADDR = 'addr_test1qpf8cud6excflj787pgkfe0vlkpj5x7tz2fgsdtak69033dmha29vf5ajuhcslaaru44844juzssnkds30r300zwee4qkdrx2v';
  const FOO = '2b0f0c0a61f4525664aa2478e78358d67d783c58607e67540c521fe5464f4f';
  const COINS_PER_UTXO_SIZE = 4310;
  const pay = (json: unknown) =>
    run(['unlock', '--redeemer-message', 'x', '--payouts', JSON.stringify(json), '--blueprint', bp]);

  it('refuses anything that is not a JSON array', async () => {
    await expect(pay({ address: ADDR, ada: '1' })).rejects.toThrow(/array of payouts/);
    await expect(run(['unlock', '--redeemer-message', 'x', '--payouts', 'not json', '--blueprint', bp]))
      .rejects.toThrow(/must be JSON/);
  });

  it('names which entry is wrong, not just that something is', async () => {
    await expect(pay([{ address: ADDR, ada: '1' }, { ada: '2' }])).rejects.toThrow(/--payouts\[1\] needs an "address"/);
  });

  it('refuses a payout that pays nothing', async () => {
    await expect(pay([{ address: ADDR }])).rejects.toThrow(/pays nothing/);
  });

  it('validates assets through the same parser the colon form uses', async () => {
    await expect(pay([{ address: ADDR, assets: [{ unit: FOO, quantity: '0' }] }]))
      .rejects.toThrow(/greater than zero/);
  });

  // The reason --payouts exists: a validator settling two claims in one
  // transaction cannot tell which payment answers for which without this.
  it('carries an inline datum onto the output, and pays for its size', () => {
    // Mesh's own Plutus-data JSON, the form every datum in this CLI takes: a
    // bytearray is a hex string and an integer is a number, not {bytes}/{int}.
    const tag = { alternative: 0, fields: ['aa'.repeat(32), 0] };
    const [plain] = payoutOutputs(
      [{ address: ADDR, lovelace: 0n, assets: [{ unit: FOO, quantity: 50n }] }],
      COINS_PER_UTXO_SIZE,
    );
    const [tagged] = payoutOutputs(
      [{ address: ADDR, lovelace: 0n, assets: [{ unit: FOO, quantity: 50n }], datum: tag }],
      COINS_PER_UTXO_SIZE,
    );
    expect(tagged.datum).toEqual(tag);
    // A bigger output has a higher floor. Estimating without the datum would
    // build a transaction the ledger then refuses.
    expect(tagged.adaAttached).toBeGreaterThan(plain.adaAttached);
  });
});
