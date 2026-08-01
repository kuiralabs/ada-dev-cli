// Config values are checked where they are written.
//
// The config is the last place anybody looks when the tool stops working, so a
// value that breaks it must be refused at the moment it is typed rather than
// discovered three commands later.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../lib/argv.ts';
import config from '../commands/config.ts';
import { AdaError } from '../lib/errors.ts';

const run = (argv: string[]) => config(parseArgs(['config', ...argv]));

let home: string | undefined;
let previous: string | undefined;

beforeEach(() => {
  // A scratch home, so the suite cannot damage a real configuration.
  home = mkdtempSync(join(tmpdir(), 'ada-config-'));
  previous = process.env.HOME;
  process.env.HOME = home;
});

afterEach(() => {
  if (previous !== undefined) process.env.HOME = previous;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('an endpoint that would break the tool', () => {
  it('refuses something that is not a URL', async () => {
    // `ada config set endpoints.devnet.apiUrl junk` was accepted, and every
    // command afterwards reported `devnet_not_running` — for a devnet that was
    // running, with `ada status` showing its pid.
    await expect(run(['set', 'endpoints.devnet.apiUrl', 'junk'])).rejects.toThrow(/not a URL/);
  });

  it('refuses a relative path', async () => {
    await expect(run(['set', 'endpoints.devnet.apiUrl', '/api/v1'])).rejects.toThrow(/not a URL/);
  });

  it('refuses a scheme nothing here speaks', async () => {
    await expect(run(['set', 'endpoints.devnet.apiUrl', 'ftp://host/x']))
      .rejects.toThrow(/http or https/);
  });

  it('reports invalid_args rather than an internal error', async () => {
    try {
      await run(['set', 'endpoints.devnet.apiUrl', 'junk']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AdaError).code).toBe('invalid_args');
    }
  });

  it('accepts a real endpoint', async () => {
    await expect(run(['set', 'endpoints.devnet.apiUrl', 'http://localhost:8080/api/v1']))
      .resolves.toBeUndefined();
  });

  it('accepts https', async () => {
    await expect(run(['set', 'endpoints.preprod.apiUrl', 'https://preprod.example/api/v1']))
      .resolves.toBeUndefined();
  });
});

describe('an active wallet that does not exist', () => {
  it('is refused, rather than breaking the next command', async () => {
    await expect(run(['set', 'activeWallet', 'ghostwallet'])).rejects.toThrow(/no wallet named/);
  });

  it('points at the command that actually creates one', async () => {
    // The first version of this hint said `ada wallet create`, which does not
    // exist — the subcommand is `generate`. Found by following my own advice.
    try {
      await run(['set', 'activeWallet', 'ghostwallet']);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AdaError).hint).toMatch(/ada wallet generate/);
      expect((err as AdaError).hint).not.toMatch(/ada wallet create/);
    }
  });
});
