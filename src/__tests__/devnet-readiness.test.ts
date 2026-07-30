// Regression tests for the readiness wait.
//
// The failure being pinned actually happened: `localnet up` waited the full 180s
// for a devkit process that had died after 8 seconds on a port conflict. The
// wait had no liveness check, so a crash was indistinguishable from a slow
// start. These fail against that version and pass against this one.
//
// Offline by construction — the probe target is a port nothing can be listening
// on, so a network-less CI exercises the same paths.

import { describe, it, expect } from 'vitest';
import { waitForDevnet } from '../lib/yaci.ts';

/** Port 1 is privileged and unbound, so the probe refuses immediately. */
const UNREACHABLE = 'http://127.0.0.1:1';

describe('waitForDevnet', () => {
  it('aborts as soon as the process dies instead of burning the timeout', async () => {
    const started = Date.now();
    const result = await waitForDevnet(UNREACHABLE, {
      timeoutMs: 30_000,
      isAlive: () => false,
    });
    const elapsed = Date.now() - started;

    expect(result.ready).toBe(false);
    expect(result.processDied).toBe(true);
    // The point of the fix: returns in well under the timeout.
    expect(elapsed).toBeLessThan(5_000);
  });

  it('reports a timeout distinctly from a crash when the process stays alive', async () => {
    const result = await waitForDevnet(UNREACHABLE, {
      timeoutMs: 1_500,
      isAlive: () => true,
    });

    expect(result.ready).toBe(false);
    // Distinguishing these two is what lets `up` say "it crashed, here is the
    // log" versus "still starting, wait longer".
    expect(result.processDied).toBe(false);
  });

  it('still times out when no liveness predicate is supplied', async () => {
    const result = await waitForDevnet(UNREACHABLE, { timeoutMs: 1_200 });
    expect(result.ready).toBe(false);
    expect(result.processDied).toBe(false);
  });
});
