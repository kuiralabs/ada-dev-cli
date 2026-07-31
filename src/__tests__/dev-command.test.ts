// `ada dev` — the parts testable without a filesystem watcher.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../lib/argv.ts';
import { validateFlags, acceptedFlags } from '../lib/flags.ts';
import dev from '../commands/dev.ts';
import { AdaError } from '../lib/errors.ts';

describe('starting the watch loop', () => {
  it('refuses a directory with no Aiken sources, and says what it expected', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ada-dev-'));
    try {
      await expect(dev(parseArgs(['dev', '--path', empty])))
        .rejects.toThrow(/no Aiken sources/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('reports invalid_args rather than an internal error', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'ada-dev-'));
    try {
      await dev(parseArgs(['dev', '--path', empty]));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AdaError).code).toBe('invalid_args');
      expect((err as AdaError).hint).toMatch(/validators\/|--path/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('accepts a project with only lib/, not just validators/', async () => {
    // A project may keep shared code in lib/ and have no validators of its own
    // yet; watching nothing because one of two directories is missing would be
    // wrong.
    const dir = mkdtempSync(join(tmpdir(), 'ada-dev-'));
    mkdirSync(join(dir, 'lib'));
    try {
      // It gets past the source check and fails later on the missing project,
      // which is what we are asserting: not the "no Aiken sources" error.
      await Promise.race([
        dev(parseArgs(['dev', '--path', dir])).catch((e) => e),
        new Promise((r) => setTimeout(() => r('still watching'), 1500)),
      ]).then((outcome) => {
        if (outcome instanceof Error) expect(outcome.message).not.toMatch(/no Aiken sources/);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});

describe('the flags it takes', () => {
  it('accepts the ones that select a validator, since the address depends on them', () => {
    const accepted = acceptedFlags('dev') ?? [];
    for (const flag of ['path', 'params', 'module', 'validator', 'blueprint', 'network']) {
      expect(accepted, flag).toContain(flag);
    }
  });

  it('takes no wallet: it signs nothing and spends nothing', () => {
    expect(acceptedFlags('dev') ?? []).not.toContain('wallet');
    expect(() => validateFlags('dev', parseArgs(['dev', '--wallet', 'alice']))).toThrow(/unknown flag/);
  });
});
