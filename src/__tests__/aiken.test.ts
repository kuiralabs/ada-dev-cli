// Delegation to the Aiken compiler.
//
// The interesting part is not that we shell out — it is that Aiken decides what
// to emit by looking at whether stdout is a terminal, and the two possible
// answers are mutually exclusive. Capturing stdout gets a JSON report and
// silently discards the diagnostic; inheriting it gets the diagnostic and no
// report. These pin the arrangement that gives each audience the right one.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAiken, resolveAikenBin, notInstalled } from '../lib/aiken.ts';
import { AdaError } from '../lib/errors.ts';

afterEach(() => { delete process.env.ADA_AIKEN_BIN; });

/** A fake `aiken` that reports which stdio arrangement it was given. */
function fakeAiken(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ada-aiken-'));
  const bin = join(dir, 'aiken');
  // Must answer --version: runAiken checks the compiler is present before using it.
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "aiken v0.0.0-fake"; exit 0; fi\n${body}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

/** Point the resolver at a fake for one test. */
function useFake(body: string): string {
  const bin = join(fakeAiken(body), 'aiken');
  process.env.ADA_AIKEN_BIN = bin;
  return bin;
}

describe('locating the compiler', () => {
  it('honours ADA_AIKEN_BIN, since a project pins its compiler version', () => {
    // The compiler version decides the script hash, and so the address. Being
    // able to point at a specific one is not a convenience.
    process.env.ADA_AIKEN_BIN = '/somewhere/aiken-1.1.23';
    expect(resolveAikenBin()).toBe('/somewhere/aiken-1.1.23');
  });

  it('falls back to PATH so spawn reports a clear ENOENT', () => {
    // aikup installs to ~/.aiken/bin and only prints a reminder to add it to
    // PATH — easy to miss, and the symptom is "spawn aiken ENOENT" from an
    // editor's language server rather than from anything we control.
    expect(resolveAikenBin()).toMatch(/aiken$/);
  });

  it('names the install command when absent', () => {
    const err = notInstalled();
    expect(err.code).toBe('tool_missing');
    expect(err.hint).toContain('aikup');
    expect(err.hint).toContain('.aiken/bin');
  });
});

describe('a failing compile', () => {
  it('does not repeat a diagnostic the compiler already printed', async () => {
    useFake('echo "progress" >&2; exit 1');
    const project = mkdtempSync(join(tmpdir(), 'proj-'));
    try {
      runAiken(['check'], project);
      expect.unreachable();
    } catch (e) {
      expect((e as AdaError).code).toBe('aiken_failed');
      expect((e as AdaError).hint).toContain('above');
    }
  });

  it('re-runs to render the diagnostic when no report explains the failure', () => {
    // A type error produces no JSON, so the first captured run yields nothing to
    // report. The second run exists solely to make aiken print the diagnostic,
    // and it is what keeps a compile error from being swallowed.
    const marker = join(mkdtempSync(join(tmpdir(), 'marker-')), 'runs');
    useFake(`echo x >> ${marker}; exit 1`);
    const project = mkdtempSync(join(tmpdir(), 'proj-'));
    expect(() => runAiken(['check'], project)).toThrow(AdaError);
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('does not re-run when the report already explains the failure', () => {
    // A failing test is fully described by the JSON. Compiling twice for that
    // would be waste, and the second run could disagree with the first.
    const marker = join(mkdtempSync(join(tmpdir(), 'marker-')), 'runs');
    useFake(`echo x >> ${marker}; echo '{"summary":{"total":2,"passed":1,"failed":1}}'; exit 1`);
    const project = mkdtempSync(join(tmpdir(), 'proj-'));
    try {
      runAiken(['check'], project);
      expect.unreachable();
    } catch (e) {
      expect((e as AdaError).hint).toBe('1 of 2 tests failed');
    }
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('reading the machine-readable report', () => {
  it('parses the JSON aiken check writes to stdout', () => {
    useFake(`echo '{"seed":1,"summary":{"total":3,"passed":2,"failed":1}}'`);
    const project = mkdtempSync(join(tmpdir(), 'proj-'));
    const r = runAiken(['check'], project);
    expect(r.report?.summary).toEqual({ total: 3, passed: 2, failed: 1 });
  });

  it('survives output that is not a report', () => {
    // `aiken build` writes no JSON at all. A missing report is normal, not an error.
    useFake('echo "not json"');
    const project = mkdtempSync(join(tmpdir(), 'proj-'));
    expect(runAiken(['build'], project).report).toBeUndefined();
  });

  it('survives truncated JSON rather than throwing', () => {
    useFake(`echo '{"summary":'`);
    const project = mkdtempSync(join(tmpdir(), 'proj-'));
    expect(runAiken(['check'], project).report).toBeUndefined();
  });

  it('captures the report on success regardless of audience', () => {
    // stdout is always captured now; the diagnostic is recovered separately, so
    // there is no arrangement in which the report is sacrificed.
    useFake(`echo '{"summary":{"total":1,"passed":1,"failed":0}}'`);
    const project = mkdtempSync(join(tmpdir(), 'proj-'));
    expect(runAiken(['check'], project).report?.summary?.passed).toBe(1);
  });
});

describe('a project built by a compiler it does not declare', () => {
  // aiken.toml accepts a `compiler` field and Aiken warns on a mismatch, but it
  // builds anyway — and the compiler changes the script hash. hello-world is
  // 167f56e1… under v1.1.0 and 61862d97… under v1.1.23 from identical source, so
  // a mismatch means the blueprint addresses somewhere the project never asked
  // for.
  //
  // The warning is also invisible exactly where it matters: Aiken renders
  // warnings only to a terminal, so in --json mode, with stdout piped, it is
  // never emitted and the build reports success.
  const project = (toml: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'ada-toml-'));
    writeFileSync(join(dir, 'aiken.toml'), toml);
    return dir;
  };

  it('reads the declared compiler out of aiken.toml', async () => {
    const { declaredCompiler } = await import('../lib/aiken.ts');
    const dir = project('name = "x/y"\ncompiler = "v1.1.0"\nplutus = "v3"\n');
    expect(declaredCompiler(dir)).toBe('v1.1.0');
  });

  it('accepts either quote style, since aiken new emits one and hand edits the other', async () => {
    const { declaredCompiler } = await import('../lib/aiken.ts');
    expect(declaredCompiler(project("name = 'x/y'\ncompiler = 'v1.1.23'\n"))).toBe('v1.1.23');
  });

  it('says nothing when a project declares no compiler', async () => {
    const { declaredCompiler } = await import('../lib/aiken.ts');
    expect(declaredCompiler(project('name = "x/y"\nplutus = "v3"\n'))).toBeUndefined();
  });

  it('reports a mismatch through runAiken', () => {
    const dir = project('name = "x/y"\ncompiler = "v1.1.0"\n');
    useFake('exit 0');
    // The fake answers --version with v0.0.0-fake, which is not v1.1.0.
    const r = runAiken(['build'], dir);
    expect(r.mismatch?.declared).toBe('v1.1.0');
  });

  it('stays quiet when the versions agree', () => {
    const dir = project('name = "x/y"\ncompiler = "v0.0.0"\n');
    useFake('exit 0');
    expect(runAiken(['build'], dir).mismatch).toBeUndefined();
  });

  it('ignores the build suffix, which is not part of the version', () => {
    // `aiken --version` answers "aiken v1.1.23+8949565"; a declaration is bare.
    const dir = project('name = "x/y"\ncompiler = "v0.0.0"\n');
    useFake('exit 0');
    expect(runAiken(['build'], dir).mismatch).toBeUndefined();
  });
});
