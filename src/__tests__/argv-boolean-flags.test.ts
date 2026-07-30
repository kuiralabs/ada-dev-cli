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
import { parseArgs, hasFlag, flagValue, booleanFlagNames } from '../lib/argv.ts';

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
