// `ada dev`, driven the way a developer drives it.
//
// The unit tests cover the startup guard and the flag surface. They do not cover
// the reason the command exists: noticing that a source edit moved the
// validator's address, and saying what was left behind at the old one. That was
// verified once by hand, which is the standard this suite replaces.
//
// Driven as a real process with a real editor-style write, because two of the
// three bugs found while building it were only reachable that way — `runAiken`
// throwing on a failed compile and killing the loop, and `aiken check` not
// writing plutus.json so every address came from a stale blueprint. Neither is
// visible to a test that calls a function.

import { describe, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ada, chain, CLI, HERE, NETWORK, TEST_TIMEOUT, IS_LOCAL, paceBetweenTests } from './harness.ts';

paceBetweenTests();

/** Long enough for `aiken check` and `build` to run twice over. */
const REBUILD_MS = 25_000;
const SOURCE = join('validators', 'probe.ak');

/**
 * The watch-loop fixture: an Aiken project that imports nothing.
 *
 * The blueprint fixture the contract tests use is a bare plutus.json with no
 * sources, so there is nothing for a watch loop to watch. This one compiles in
 * seconds with no network — a fixture that had to resolve stdlib would make
 * these slow and flaky for reasons unrelated to what they check.
 */
const PROJECT = join(HERE, 'fixtures', 'watch-probe');

/** A copy of it, so an edit cannot touch the fixture itself. */
function scratchProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ada-dev-chain-'));
  cpSync(PROJECT, dir, { recursive: true });
  return dir;
}

/** The edit under test: changes the compiled code, so the address moves. */
const moveTheAddress = (dir: string) => () => {
  const path = join(dir, SOURCE);
  writeFileSync(path, readFileSync(path, 'utf8').replace('redeemer > 10', 'redeemer > 20'));
};

/**
 * Run `ada dev` over a project, apply an edit, and collect what it said.
 *
 * The process is driven rather than the function called: the loop's failure
 * modes are process-shaped — it died on the first bad compile — and a direct
 * call cannot see that.
 */
async function watch(dir: string, edit: () => void): Promise<string> {
  const child = spawn('npx', ['tsx', CLI, 'dev', '--path', dir, '--network', NETWORK], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  child.stdout.on('data', (c) => { out += String(c); });

  try {
    await new Promise((r) => setTimeout(r, 8_000));  // let the watcher settle
    edit();
    await new Promise((r) => setTimeout(r, REBUILD_MS));
    return out;
  } finally {
    child.kill('SIGINT');
    await new Promise((r) => setTimeout(r, 1_500));
    child.kill('SIGKILL');
  }
}

describe(`dev, against a live chain (${NETWORK})`, () => {
  chain()('reports the address moving, and what is stranded at the old one', async () => {
    // Local only. The point is a real balance at the abandoned address, and
    // funding one on a public network to prove it costs real coin for a fact
    // that is not network-specific.
    if (!IS_LOCAL) return;

    const dir = scratchProject();
    try {
      // Lock funds at the address the current source produces, so there is
      // something real to be stranded by the edit.
      const before = ada(['contract', 'address', '--path', dir]);
      const locked = ada(['contract', 'lock', '--path', dir, '--amount', '6', '--datum-signer', '--yes']);
      expect(locked.code ?? 'ok', locked.message ?? '').toBe('ok');

      // A two-character change, and a completely different compiled script.
      const out = await watch(dir, moveTheAddress(dir));

      expect(out, 'the loop never reported a rebuild').toMatch(/the address changed/);
      expect(out).toContain(before.address ?? before.scriptAddress);
      // The number is the point. An address change with no account of what was
      // left behind is the situation this command exists to end.
      expect(out).toMatch(/is at the old address and this build cannot spend it/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  chain()('survives a broken build and recovers on the next save', async () => {
    // `runAiken` throws when the compiler is unhappy, which killed the loop on
    // the first syntax error. A watch loop that exits on a bad build is a watch
    // loop nobody can use, and a failing compile is the normal case here.
    const dir = scratchProject();
    try {
      const out = await watch(dir, () => {
        const path = join(dir, SOURCE);
        const good = readFileSync(path, 'utf8');
        writeFileSync(path, `${good}\nthis is not valid aiken\n`);
        // Repair it after a moment, on the same run, so recovery is observed
        // rather than assumed.
        setTimeout(() => writeFileSync(path, good), 10_000);
      });

      expect(out, 'the broken build was not reported').toMatch(/build failed/);
      // Something after the failure proves the loop was still alive.
      expect(out.slice(out.indexOf('build failed')), 'the loop died on the bad build')
        .toMatch(/tests|built|address/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  chain()('refreshes the blueprint, so the address it reports is the new one', async () => {
    // `aiken check` does not write plutus.json — only `build` does — so a loop
    // running check alone derived every address from a stale blueprint and
    // reported that nothing had moved while the source plainly had.
    if (!IS_LOCAL) return;

    const dir = scratchProject();
    try {
      const before = ada(['contract', 'address', '--path', dir]);
      await watch(dir, moveTheAddress(dir));

      // Asked of the blueprint on disk afterwards: the artifact must have been
      // rewritten, not merely type-checked.
      const after = ada(['contract', 'address', '--path', dir]);
      expect(after.address ?? after.scriptAddress).not.toBe(before.address ?? before.scriptAddress);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);
});
