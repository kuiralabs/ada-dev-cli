// Regression tests for the flag parser.
//
// The bug: `ada localnet --json status` parsed as `{json: 'status'}` with no
// positionals. Two failures at once — the subcommand vanished, and `--json`
// silently stopped being true, so the output contract broke without a word. For a
// tool whose second audience parses stdout, quiet-and-wrong is the worst outcome
// available.
//
// Every test here fails against the version without a boolean-flag set.

import { describe, it, expect } from 'vitest';
import { parseArgs, hasFlag, flagValue, booleanFlagNames, isNegativeNumber } from '../lib/argv.ts';

describe('boolean flags do not consume the next token', () => {
  it('keeps the subcommand when --json precedes it', () => {
    const args = parseArgs(['localnet', '--json', 'status']);
    expect(hasFlag(args, 'json')).toBe(true);
    expect(args.positionals).toEqual(['status']);
  });

  it('keeps json true when a positional follows anywhere', () => {
    const args = parseArgs(['wallet', '--json', 'use', 'alice']);
    expect(hasFlag(args, 'json')).toBe(true);
    expect(args.positionals).toEqual(['use', 'alice']);
  });

  it('holds for every declared boolean flag', () => {
    for (const name of booleanFlagNames()) {
      const args = parseArgs(['cmd', `--${name}`, 'positional']);
      expect(hasFlag(args, name), `--${name} swallowed its neighbour`).toBe(true);
      expect(args.positionals, `--${name} lost the positional`).toEqual(['positional']);
    }
  });
});

describe('value-taking flags still work', () => {
  it('consumes the following token', () => {
    const args = parseArgs(['tip', '--network', 'preprod']);
    expect(flagValue(args, 'network')).toBe('preprod');
    expect(args.positionals).toEqual([]);
  });

  it('does not consume a following flag as its value', () => {
    const args = parseArgs(['tip', '--network', '--json']);
    expect(flagValue(args, 'network')).toBeUndefined();
    expect(hasFlag(args, 'json')).toBe(true);
  });

  it('still accepts the = form', () => {
    expect(flagValue(parseArgs(['tip', '--network=preview']), 'network')).toBe('preview');
  });

  it('allows an explicit = value even for a boolean flag name', () => {
    // Escape hatch: `--json=false` is at least unambiguous, where a bare
    // `--json false` is not.
    expect(parseArgs(['tip', '--json=false']).flags.json).toBe('false');
  });
});

describe('ordering does not change meaning', () => {
  const forms = [
    ['localnet', 'status', '--json'],
    ['localnet', '--json', 'status'],
    ['--json', 'localnet', 'status'],
  ];

  it('parses the same regardless of where --json sits', () => {
    for (const argv of forms) {
      const args = parseArgs(argv);
      expect(hasFlag(args, 'json'), argv.join(' ')).toBe(true);
      expect(args.command, argv.join(' ')).toBe('localnet');
      expect(args.positionals, argv.join(' ')).toEqual(['status']);
    }
  });
});

describe('an empty flag value counts as absent', () => {
  // Found by the wallet-selection tests: `--wallet=` resolved to the empty string,
  // which nullish-coalescing preferred over the configured default — so the flag
  // neither selected anything nor fell back. Agents send "" for omitted fields.
  it('treats --flag= as if the flag were not passed', () => {
    expect(flagValue(parseArgs(['balance', '--wallet=']), 'wallet')).toBeUndefined();
    expect(flagValue(parseArgs(['tip', '--network=']), 'network')).toBeUndefined();
  });

  it('still returns a real value', () => {
    expect(flagValue(parseArgs(['tip', '--network=preprod']), 'network')).toBe('preprod');
  });

  it('does not confuse an absent flag with an empty one', () => {
    expect(flagValue(parseArgs(['tip']), 'network')).toBeUndefined();
  });
});

describe('a negative number is a value, not a flag', () => {
  // Found by exploratory testing. `asset mint --qty -1` parsed -1 as a short flag,
  // so --qty got nothing, the default took over, and the tool silently minted 1
  // while reporting ok:true. Quiet substitution of a different value is the worst
  // failure mode available to a tool whose second audience parses stdout.
  //
  // Every test here fails against the parser without looksNumeric().
  it('gives a negative number to the flag that asked for it', () => {
    expect(flagValue(parseArgs(['asset', 'mint', '--qty', '-1']), 'qty')).toBe('-1');
  });

  it('does not invent a short flag from a negative number', () => {
    expect(parseArgs(['asset', 'mint', '--qty', '-1']).flags['1']).toBeUndefined();
  });

  it('keeps a negative positional as a positional', () => {
    // `transfer <addr> -5` reported "needs a recipient and an amount" when both
    // were supplied, because -5 vanished into the flag bag.
    const args = parseArgs(['transfer', 'addr_test1abc', '-5']);
    expect(args.positionals).toEqual(['addr_test1abc', '-5']);
  });

  it('handles a negative decimal', () => {
    expect(flagValue(parseArgs(['x', '--amount', '-0.5']), 'amount')).toBe('-0.5');
  });

  it('still treats a real short flag as a flag', () => {
    const args = parseArgs(['x', '-v']);
    expect(args.flags.v).toBe(true);
    expect(args.positionals).toEqual([]);
  });

  it('does not let a negative number swallow a following flag', () => {
    const args = parseArgs(['x', '--amount', '-5', '--json']);
    expect(flagValue(args, 'amount')).toBe('-5');
    expect(hasFlag(args, 'json')).toBe(true);
  });

  it('exposes the check so a command can reject a negative it does not want', () => {
    expect(isNegativeNumber('-1')).toBe(true);
    expect(isNegativeNumber('-v')).toBe(false);
    expect(isNegativeNumber('5')).toBe(false);
  });
});
