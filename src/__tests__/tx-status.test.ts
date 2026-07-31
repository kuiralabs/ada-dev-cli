// `tx status` argument handling, offline.

import { describe, it, expect } from 'vitest';
import { parseArgs } from '../lib/argv.ts';
import { validateFlags, acceptedFlags } from '../lib/flags.ts';
import txStatus from '../commands/tx.ts';
import { AdaError } from '../lib/errors.ts';

const run = (argv: string[]) => txStatus(parseArgs(['tx', ...argv]));

describe('tx status arguments', () => {
  it('needs a subcommand', async () => {
    await expect(run([])).rejects.toThrow(/needs a subcommand/);
  });

  it('rejects a subcommand it does not have', async () => {
    await expect(run(['resubmit', 'abc'])).rejects.toThrow(/unknown tx subcommand/);
  });

  it('needs a hash', async () => {
    await expect(run(['status'])).rejects.toThrow(/needs a transaction hash/);
  });

  it('rejects something that is not a transaction hash', async () => {
    // A hash is 64 hex characters. Anything else reaches a provider, which
    // answers "not found" — indistinguishable from a real transaction that has
    // not landed, so the typo would look like a chain problem.
    await expect(run(['status', 'nonsense'])).rejects.toThrow(/not a transaction hash/);
    await expect(run(['status', 'abc123'])).rejects.toThrow(/not a transaction hash/);
  });

  it('reports invalid_args, not an internal error, for a bad hash', async () => {
    try {
      await run(['status', 'tooshort']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AdaError).code).toBe('invalid_args');
    }
  });

  it('takes --wait and --network, and nothing invented', () => {
    const accepted = acceptedFlags('tx') ?? [];
    expect(accepted).toContain('wait');
    expect(accepted).toContain('network');
    expect(() => validateFlags('tx', parseArgs(['tx', 'status', 'a', '--wait']))).not.toThrow();
    expect(() => validateFlags('tx', parseArgs(['tx', 'status', 'a', '--follow']))).toThrow(/unknown flag/);
  });
});
