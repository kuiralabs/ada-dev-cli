import { describe, it, expect } from 'vitest';
import { parseArgs, hasFlag, flagValue } from '../lib/argv.ts';

describe('parseArgs', () => {
  it('separates command from positionals', () => {
    const args = parseArgs(['localnet', 'up']);
    expect(args.command).toBe('localnet');
    expect(args.positionals).toEqual(['up']);
  });

  it('treats a bare long flag as boolean', () => {
    expect(hasFlag(parseArgs(['tip', '--json']), 'json')).toBe(true);
  });

  it('consumes a following non-flag token as the flag value', () => {
    const args = parseArgs(['tip', '--network', 'preprod']);
    expect(flagValue(args, 'network')).toBe('preprod');
    expect(args.positionals).toEqual([]);
  });

  it('accepts the --flag=value form', () => {
    expect(flagValue(parseArgs(['tip', '--network=preprod']), 'network')).toBe('preprod');
  });

  it('does not swallow a following flag as a value', () => {
    const args = parseArgs(['tip', '--json', '--network', 'preprod']);
    expect(hasFlag(args, 'json')).toBe(true);
    expect(flagValue(args, 'network')).toBe('preprod');
  });

  it('treats everything after -- as positional', () => {
    const args = parseArgs(['transfer', '--', '--not-a-flag']);
    expect(args.positionals).toEqual(['--not-a-flag']);
  });

  it('reports a missing flag as absent rather than false-y string', () => {
    const args = parseArgs(['tip']);
    expect(hasFlag(args, 'json')).toBe(false);
    expect(flagValue(args, 'network')).toBeUndefined();
  });
});
