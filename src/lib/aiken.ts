// The Aiken toolchain — the only file that shells out to it.
//
// Aiken owns compilation and the validator's own tests, and we do not
// second-guess either. Same rule already applied to `cardano-address` for
// derivation: where an authoritative implementation exists, this tool's job is
// to make it convenient, not to reimplement it and disagree.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { toolMissingError, AdaError } from './errors.ts';
import { EXIT_CHAIN_REJECTED } from './exit-codes.ts';

const AIKEN_BIN = 'aiken';

/**
 * Locate the compiler.
 *
 * `ADA_AIKEN_BIN` wins, then aikup's install directory, then PATH. The override
 * exists because `aikup` manages several versions and a project pins one in
 * `aiken.toml` — the compiler version is part of a contract's identity, since it
 * decides the script hash and therefore the address.
 *
 * The `~/.aiken/bin` lookup is not redundant with PATH: aikup installs there and
 * only *prints a reminder* to add it, which is easy to miss. The symptom is
 * "spawn aiken ENOENT" from an editor's language server rather than from
 * anything this tool controls, so finding it ourselves saves that hunt.
 */
export function resolveAikenBin(): string {
  const override = process.env.ADA_AIKEN_BIN;
  if (override) return override;
  const home = join(homedir(), '.aiken', 'bin', AIKEN_BIN);
  if (existsSync(home)) return home;
  return AIKEN_BIN; // rely on PATH; spawn reports ENOENT if absent
}

export function notInstalled(): AdaError {
  return toolMissingError(
    'the aiken compiler is not installed',
    'install it with: npm install -g @aiken-lang/aikup && aikup — '
    + 'then add ~/.aiken/bin to your PATH',
  );
}

export interface AikenResult {
  /**
   * Empty by design — see {@link runAiken}. Aiken's diagnostics go straight to
   * the user's terminal rather than through us.
   */
  output: string;
  /**
   * Aiken's own machine-readable result, when it produces one.
   *
   * `aiken check` writes a JSON report to **stdout** whenever stdout is not a
   * terminal — which is always, for us. Parsing that is strictly better than
   * scraping the human summary, and it is the compiler's own contract rather
   * than a format we inferred.
   */
  report?: AikenReport;
  version: string;
}

export interface AikenReport {
  seed?: number;
  summary?: { total: number; passed: number; failed: number; kind?: Record<string, number> };
  modules?: unknown[];
}

/** The installed compiler's version, or undefined when it is absent. */
export function aikenVersion(): string | undefined {
  const bin = resolveAikenBin();
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return undefined;
  return (r.stdout || r.stderr).trim();
}

/**
 * Run an aiken subcommand in a project directory.
 *
 * Aiken chooses its output by asking whether **stdout** is a terminal, and the
 * two answers carry different information:
 *
 * - **pipe** → a JSON report: per-test titles, pass/fail, execution units. Rich,
 *   and exactly what a program wants. But a *type error* produces no JSON at all
 *   — stdout is empty and the diagnostic is simply never rendered.
 * - **terminal** → the diagnostic: the file, the line, the offending expression
 *   underlined, a "did you forget to import it?" hint. No JSON.
 *
 * So neither arrangement alone is sufficient, and losing either one is a real
 * loss. We take both, in two steps:
 *
 * 1. Run with stdout captured, which yields the JSON report whenever there is one.
 * 2. If that failed and produced no report — the compile-error case — run again
 *    with **our stderr handed to aiken as its stdout**. Aiken sees a terminal and
 *    renders the full diagnostic, and it lands on stderr, which is where this
 *    tool's human output already goes and is never part of the `--json` contract.
 *
 * The second run costs ~0.16s because the build is already warm, and it happens
 * only on the path where something is broken and about to be fixed. Nothing is
 * hidden from either audience.
 */
export function runAiken(args: string[], cwd: string, opts: { json?: boolean } = {}): AikenResult {
  const bin = resolveAikenBin();
  const version = aikenVersion();
  if (version === undefined) throw notInstalled();

  const r = spawnSync(bin, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw notInstalled();
    throw new AdaError('aiken_failed', `could not run aiken: ${r.error.message}`, EXIT_CHAIN_REJECTED);
  }

  const output = '';
  const report = parseReport(r.stdout ?? '');

  if (r.status !== 0) {
    // No report means the failure happened before any test ran — a type error,
    // whose diagnostic aiken renders only to a terminal. Ask for it again, with
    // our stderr standing in as its stdout so the diagnostic reaches the user
    // without ever touching the JSON channel.
    if (!report) renderDiagnostic(bin, args, cwd);

    throw new AdaError('aiken_failed',
      `aiken ${args[0]} failed`, EXIT_CHAIN_REJECTED,
      report
        ? `${report.summary?.failed ?? 0} of ${report.summary?.total ?? 0} tests failed`
        : 'the compiler printed the diagnostic above');
  }

  return { output, report, version };
}

/**
 * Re-run purely to make aiken render its diagnostic.
 *
 * Handing it fd 2 as its stdout is the whole trick: aiken's terminal check looks
 * at whatever it was given, so it produces the full styled diagnostic, and every
 * byte lands on stderr rather than stdout. A `--json` caller keeps a clean,
 * parseable stdout and the person reading the terminal still sees the error.
 *
 * Best-effort by design — if this second run fails for any reason, the original
 * failure is still reported. It exists to add information, never to withhold it.
 */
function renderDiagnostic(bin: string, args: string[], cwd: string): void {
  try {
    spawnSync(bin, args, { cwd, stdio: ['ignore', 2, 'inherit'] });
  } catch {
    // The caller throws with the original failure regardless.
  }
}

function parseReport(stdout: string): AikenReport | undefined {
  const text = stdout.trim();
  if (!text.startsWith('{')) return undefined;
  try {
    return JSON.parse(text) as AikenReport;
  } catch {
    // Not fatal: the diagnostics on stderr are the useful half either way.
    return undefined;
  }
}

/**
 * Error and warning counts from the diagnostics stream.
 *
 * `aiken build` produces no JSON report — only `check` does — so this scrapes the
 * summary line it prints. Used as a supplement to the report, never instead of it.
 */
export function parseSummary(output: string): { errors: number; warnings: number } | undefined {
  const m = output.match(/Summary\s+(\d+)\s+error(?:s)?,\s+(\d+)\s+warning/i);
  if (!m) return undefined;
  return { errors: Number(m[1]), warnings: Number(m[2]) };
}
