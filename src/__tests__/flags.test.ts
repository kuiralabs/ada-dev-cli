// A flag nobody implemented must be an error, not a shrug.
//
// Every case here was observed reporting `ok: true` and doing something other
// than what was asked.

import { describe, it, expect } from 'vitest';
import { parseArgs } from '../lib/argv.ts';
import { validateFlags, acceptedFlags, nearest } from '../lib/flags.ts';
import { commandNames } from '../lib/commands.ts';
import { COMMANDS, GLOBAL_FLAGS, SHARED_FLAGS } from '../lib/reference.ts';
import { AdaError } from '../lib/errors.ts';

const check = (argv: string[]) => {
  const args = parseArgs(argv);
  validateFlags(args.command as string, args);
};

describe('unknown flags', () => {
  it('rejects a flag that exists nowhere', () => {
    // `swap build --out offer.txt` reported ok and wrote no file, so the offer
    // — the only copy of a signed transaction — was lost.
    expect(() => check(['swap', 'build', '--out', 'offer.txt'])).toThrow(/unknown flag/);
  });

  it('rejects a misspelled flag rather than answering about something else', () => {
    // The dangerous one: this reported the ACTIVE wallet's balance, labelled
    // ok, while the caller believed they had asked about alice.
    expect(() => check(['balance', '--wallett', 'alice'])).toThrow(/unknown flag/);
  });

  it('rejects a flag borrowed from another command', () => {
    expect(() => check(['balance', '--qty', '5'])).toThrow(/unknown flag/);
  });

  it('names every unknown flag, not just the first', () => {
    try {
      check(['status', '--one', '--two']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('--one');
      expect((err as Error).message).toContain('--two');
    }
  });

  it('suggests the flag that was meant', () => {
    try {
      check(['balance', '--wallett', 'alice']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AdaError).hint).toContain('--wallet');
    }
  });

  it('reports a stable code so an agent can branch on it', () => {
    try {
      check(['status', '--bogus']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AdaError).code).toBe('unknown_flag');
    }
  });
});

describe('flags that must keep working', () => {
  it.each([
    ['balance', '--wallet', 'bob'],
    ['balance', '--network', 'preprod'],
    ['utxos', '--wallet', 'alice'],
    ['transfer', 'addr_test1abc', '5', '--yes'],
    ['transfer', 'addr_test1abc', '--lovelace', '1500000'],
    ['asset', 'mint', 'Silk', '--qty', '10', '--yes'],
    ['swap', 'build', '--with', 'addr_test1abc', '--give', '5ADA', '--want', '1ADA'],
    ['contract', 'unlock', '--tx-in', 'aa#0', '--continue', '25', '--continue-datum', '{}'],
    ['contract', 'unlock', '--tx-in', 'aa#0', '--pay', 'addr_test1abc:5'],
    ['contract', 'inspect', '--path', './somewhere'],
    ['address', 'derive', 'alice', '--index', '3', '--role', '0', '--account', '1'],
    ['hash', 'hello', '--algo', 'blake2b-224', '--hex'],
    ['localnet', 'start', '--block-time', '1'],
    ['wallet', 'generate', 'carol', '--force', '--show-mnemonic'],
    ['slot', '+30m', '--json'],
  ])('accepts %s %s', (...argv) => {
    expect(() => check(argv as string[])).not.toThrow();
  });

  it('accepts the universal flags on every command', () => {
    for (const command of commandNames()) {
      for (const flag of ['--json']) {
        expect(() => check([command, flag]), `${command} ${flag}`).not.toThrow();
      }
    }
  });
});

describe('the specification itself', () => {
  it('covers every command the dispatcher can route to', () => {
    // A command added to the table and not here would accept anything, which is
    // the state this module exists to end.
    for (const command of commandNames()) {
      expect(acceptedFlags(command), command).toBeDefined();
    }
  });

  it('leaves an unknown command to the dispatcher', () => {
    // Guessing at a flag set for a command that does not exist would replace a
    // clear error with a confusing one.
    expect(acceptedFlags('nosuchcommand')).toBeUndefined();
    expect(() => check(['nosuchcommand', '--whatever'])).not.toThrow();
  });
});

describe('did-you-mean', () => {
  it('suggests a near miss', () => {
    expect(nearest('balanc', commandNames())).toBe('balance');
    expect(nearest('walet', ['wallet', 'status'])).toBe('wallet');
  });

  it('stays quiet when nothing is close', () => {
    expect(nearest('zzzzzzzz', commandNames())).toBeUndefined();
  });

  it('does not suggest across a short unrelated name', () => {
    // Short names are within a small edit distance of each other by accident;
    // suggesting `tip` for `top` is noise rather than help.
    expect(nearest('xyz', ['tip'])).toBeUndefined();
  });
});

describe('the spec and the documentation', () => {
  it('documents every flag it accepts', () => {
    // These two lists are the same knowledge held twice: one rejects unknown
    // flags, the other explains the known ones. When they drift, `ada <cmd>
    // --help` stops listing a flag that works — and the unknown-flag hint,
    // which points at --help, starts lying.
    const undocumented: string[] = [];

    for (const doc of COMMANDS.filter((c) => c.implemented)) {
      const accepted = acceptedFlags(doc.name);
      if (!accepted) continue;

      const documented = new Set([
        ...(doc.flags ?? []).flatMap(nameOf),
        ...GLOBAL_FLAGS.flatMap(nameOf),
        ...SHARED_FLAGS.flatMap(nameOf),
      ]);

      for (const flag of accepted) {
        if (!documented.has(flag)) undocumented.push(`${doc.name} --${flag}`);
      }
    }

    expect(undocumented).toEqual([]);
  });

  it('accepts every flag it documents', () => {
    // The other direction: a documented flag that validation rejects would make
    // the help actively harmful.
    const rejected: string[] = [];

    for (const doc of COMMANDS.filter((c) => c.implemented)) {
      const accepted = acceptedFlags(doc.name);
      if (!accepted) continue;
      for (const flag of (doc.flags ?? []).flatMap(nameOf)) {
        if (!accepted.includes(flag)) rejected.push(`${doc.name} --${flag}`);
      }
    }

    expect(rejected).toEqual([]);
  });

  it('lists no flag twice', () => {
    for (const doc of COMMANDS) {
      const names = (doc.flags ?? []).map((f) => f.flag);
      expect(new Set(names).size, `${doc.name} repeats a flag`).toBe(names.length);
    }
  });
});

/** `--pay <addr>:<ada>` and `--version, -v` both name flags; take the names. */
function nameOf(doc: { flag: string }): string[] {
  return doc.flag
    .split(',')
    .map((part) => part.trim().match(/^-{1,2}([a-zA-Z][\w-]*)/)?.[1])
    .filter((n): n is string => n !== undefined);
}

describe('flags that were accepted and did nothing', () => {
  it.each(['--quiet', '--verbose'])('rejects %s, which no command reads', (flag) => {
    // Parsed by argv, listed as universal, and read by nothing at all. A user
    // passing --quiet got the same output and an ok — the exact shape of
    // wrongness this module exists to remove, so it is not exempt from it.
    expect(() => check(['balance', flag])).toThrow(/unknown flag/);
  });
});

describe('a flag called global has to be global', () => {
  it('is accepted by every command', () => {
    // `--network`, `--wallet` and `--yes` were listed as global and were not.
    // `ada hash x --network preprod` and `ada airdrop 1000 --yes` were both
    // rejected while the help said the flags applied everywhere — the docs
    // promising more than the tool delivers is the same defect as a flag that
    // is accepted and ignored, pointing the other way.
    const broken: string[] = [];
    for (const g of GLOBAL_FLAGS.flatMap(nameOf)) {
      for (const doc of COMMANDS.filter((c) => c.implemented)) {
        const accepted = acceptedFlags(doc.name);
        if (accepted && !accepted.includes(g)) broken.push(`${doc.name} --${g}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('keeps the merely-common ones out of the global list', () => {
    const globals = GLOBAL_FLAGS.flatMap(nameOf);
    for (const shared of SHARED_FLAGS.flatMap(nameOf)) {
      expect(globals, `--${shared} is shared, not global`).not.toContain(shared);
    }
  });

  it('shows a command only the shared flags it takes', () => {
    // hash resolves neither a wallet nor a network, so neither belongs in its help.
    const hash = acceptedFlags('hash') ?? [];
    expect(hash).not.toContain('wallet');
    expect(hash).not.toContain('network');
    expect(hash).not.toContain('yes');

    const transfer = acceptedFlags('transfer') ?? [];
    expect(transfer).toContain('wallet');
    expect(transfer).toContain('network');
    expect(transfer).toContain('yes');
  });
});
