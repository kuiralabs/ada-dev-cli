// Delegation to the Aiken compiler.
//
// The interesting part is not that we shell out — it is that Aiken decides what
// to emit by looking at whether stdout is a terminal, and the two possible
// answers are mutually exclusive. Capturing stdout gets a JSON report and
// silently discards the diagnostic; inheriting it gets the diagnostic and no
// report. These pin the arrangement that gives each audience the right one.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAiken, resolveAikenBin, notInstalled, parseSummary } from '../lib/aiken.ts';
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

  it('tells a --json caller where the diagnostic went', async () => {
    // In JSON mode stdout is captured, which is exactly what makes aiken
    // suppress the diagnostic. Saying so beats leaving an agent with an
    // unexplained failure.
    useFake('exit 1');
    const project = mkdtempSync(join(tmpdir(), 'proj-'));
    try {
      runAiken(['check'], project, { json: true });
      expect.unreachable();
    } catch (e) {
      expect((e as AdaError).hint).toMatch(/without --json/);
    }
  });
});

describe('reading the machine-readable report', () => {
  it('parses the JSON aiken check writes to stdout', () => {
    useFake(`echo '{"seed":1,"summary":{"total":3,"passed":2,"failed":1}}'`);
    const project = mkdtempSync(join(tmpdir(), 'proj-'));
    const r = runAiken(['check'], project, { json: true });
    expect(r.report?.summary).toEqual({ total: 3, passed: 2, failed: 1 });
  });

  it('survives output that is not a report', () => {
    // `aiken build` writes no JSON at all. A missing report is normal, not an error.
    useFake('echo "not json"');
    const project = mkdtempSync(join(tmpdir(), 'proj-'));
    expect(runAiken(['build'], project, { json: true }).report).toBeUndefined();
  });

  it('survives truncated JSON rather than throwing', () => {
    useFake(`echo '{"summary":'`);
    const project = mkdtempSync(join(tmpdir(), 'proj-'));
    expect(runAiken(['check'], project, { json: true }).report).toBeUndefined();
  });

  it('reports no captured report when stdout was inherited', () => {
    // Not a bug: inheriting is what lets the diagnostic through.
    useFake(`echo '{"summary":{"total":1,"passed":1,"failed":0}}'`);
    const project = mkdtempSync(join(tmpdir(), 'proj-'));
    expect(runAiken(['check'], project).report).toBeUndefined();
  });
});

describe('the human summary line', () => {
  it('reads counts from the terminal-shaped summary', () => {
    expect(parseSummary('    Summary 1 error, 0 warnings')).toEqual({ errors: 1, warnings: 0 });
  });

  it('handles the plural form', () => {
    expect(parseSummary('Summary 0 errors, 2 warnings')).toEqual({ errors: 0, warnings: 2 });
  });

  it('returns undefined when there is no summary to read', () => {
    expect(parseSummary('Compiling aiken-lang/hello_world')).toBeUndefined();
  });
});
