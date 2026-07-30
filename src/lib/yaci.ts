// Yaci DevKit integration — the local devnet.
//
// One non-obvious constraint drives this whole file. The devkit's npm launcher
// writes a PID file to ~/.yaci-cli/yaci-cli.pid and, on every start, kills the
// process tree recorded there. So invoking the launcher a second time to ask a
// question would terminate the devnet the first invocation is running.
//
// Therefore: the launcher is spawned exactly once, to start the devnet.
// Everything afterwards — readiness, tip, balances, faucet — goes over HTTP to
// the services the devnet exposes. That sidesteps the PID behaviour entirely
// and is faster than starting a JVM per query.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, openSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { toolMissingError, AdaError } from './errors.ts';
import { EXIT_INTERNAL } from './exit-codes.ts';
import { isReachable } from './http.ts';
import { ENDPOINTS, DEVNET_READY_POLL_MS, DEVNET_READY_TIMEOUT_MS } from './constants.ts';

const YACI_BIN = 'yaci-devkit';
const YACI_HOME = () => join(homedir(), '.yaci-cli');
const YACI_PID_FILE = () => join(YACI_HOME(), 'yaci-cli.pid');
const ADA_LOG_DIR = () => join(homedir(), '.ada', 'logs');
const DEVNET_LOG = () => join(ADA_LOG_DIR(), 'devnet.log');

/**
 * Locate the devkit launcher: an installed binary on PATH first, then this
 * package's own node_modules. Not bundled as a hard dependency because the
 * devkit ships a native binary per platform and lists every platform as a
 * required dependency — installing it unconditionally would download a Linux
 * binary onto a Mac.
 */
export function resolveYaciBin(): string {
  const local = localBinPath();
  if (local && existsSync(local)) return local;
  return YACI_BIN; // rely on PATH; spawn reports ENOENT if absent
}

function localBinPath(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 5; depth++) {
      const candidate = join(dir, 'node_modules', '.bin', YACI_BIN);
      if (existsSync(candidate)) return candidate;
      dir = dirname(dir);
    }
  } catch {
    // fall through to PATH
  }
  return undefined;
}

const NODE_BIN_DIR = () => join(YACI_HOME(), 'cardano-node', 'bin');
const STORE_DIR = () => join(YACI_HOME(), 'components', 'store');

/** The three executables a devnet cannot start without. */
const REQUIRED_NODE_BINS = ['cardano-node', 'cardano-cli', 'cardano-submit-api'];

/** Devkit component names, from `yaci-devkit help download`. */
const COMPONENT_NODE = 'node';
const COMPONENT_STORE = 'yaci-store';

/**
 * Whether the devkit has its cardano-node binaries.
 *
 * Size-aware, not existence-only: an interrupted download leaves a zero-byte
 * file, and an existence check would then report success and fail later at a
 * confusing point.
 */
export function nodeBinariesPresent(): boolean {
  const dir = NODE_BIN_DIR();
  return REQUIRED_NODE_BINS.every((name) => nonEmptyFile(join(dir, name)));
}

/**
 * Whether the indexer component is installed.
 *
 * Needed because the devkit's Blockfrost-compatible API is served by Yaci Store,
 * which ships as a *separate* download and is disabled by default. Without it a
 * devnet still runs — the node, the submit API and the admin API all come up —
 * but there is no HTTP way to ask for a block or an address's UTxOs, which is
 * most of what this tool does.
 */
export function storeComponentPresent(): boolean {
  const dir = STORE_DIR();
  try {
    return existsSync(dir) && statSync(dir).isDirectory() && readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

export function devkitComponentsReady(): boolean {
  return nodeBinariesPresent() && storeComponentPresent();
}

/**
 * One-time download of the devkit components: the cardano-node binaries (~800MB)
 * and the indexer (~22MB).
 *
 * Spawned detached and polled rather than awaited, because the devkit does not
 * exit after running a passed-in command — it drops into its interactive shell
 * and sits there. Waiting on exit would hang forever.
 */
export async function bootstrapComponents(
  timeoutMs = 900_000,
  onTick?: (waitedMs: number, what: string) => void,
): Promise<boolean> {
  const wanted: string[] = [];
  if (!nodeBinariesPresent()) wanted.push(COMPONENT_NODE);
  if (!storeComponentPresent()) wanted.push(COMPONENT_STORE);
  if (wanted.length === 0) return true;

  // One invocation per component: the devkit accepts a list, but downloading
  // them separately means a failure names which one failed.
  for (const component of wanted) {
    const okDownload = await downloadComponent(component, timeoutMs, (waited) =>
      onTick?.(waited, component),
    );
    if (!okDownload) return false;
  }
  return true;
}

async function downloadComponent(
  component: string,
  timeoutMs: number,
  onTick?: (waitedMs: number) => void,
): Promise<boolean> {
  const bin = resolveYaciBin();
  mkdirSync(ADA_LOG_DIR(), { recursive: true });
  const log = openSync(DEVNET_LOG(), 'a');

  const child = spawn(bin, ['download', '-c', component], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.on('error', () => {});
  child.unref();

  const done = () =>
    component === COMPONENT_NODE ? nodeBinariesPresent() : storeComponentPresent();

  const start = Date.now();
  try {
    for (;;) {
      if (done()) return true;
      const waited = Date.now() - start;
      if (waited >= timeoutMs) return false;
      onTick?.(waited);
      await sleep(2_000);
    }
  } finally {
    // The downloader has served its purpose and would otherwise sit holding the
    // admin port, which is exactly what broke the first devnet start.
    if (child.pid !== undefined) stopDevnet(child.pid);
  }
}

function nonEmptyFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).size > 0;
  } catch {
    return false;
  }
}

export interface StartOptions {
  /** Seconds per block. The devkit default is 1; sub-second values need a beta
   *  line of the devkit and are rejected by older builds. */
  blockTime?: string;
  /** Extra arguments appended verbatim, for devkit flags this tool has no
   *  opinion about. */
  extraArgs?: string[];
}

/**
 * Start the devnet, detached, with output captured to a log file.
 *
 * Detached because the devnet must outlive this process — a CLI invocation that
 * owned the chain would take it down on exit, which is the opposite of what
 * `localnet up` means.
 */
export function startDevnet(opts: StartOptions = {}): number {
  const bin = resolveYaciBin();
  mkdirSync(ADA_LOG_DIR(), { recursive: true });

  // The indexer is disabled in the devkit's bundled config, so it is switched on
  // here. Without it the devnet runs but serves no Blockfrost-compatible API,
  // and every query command in this tool has nothing to talk to.
  //
  // A `-D` system property is the only override that reaches the process: the
  // devkit's launcher spawns the native binary with an *empty* environment, so
  // environment-variable overrides are silently dropped. It must precede the
  // command, matching how the launcher passes its own config import.
  const args = ['-Dyaci.store.enabled=true', 'create-node', '-o', '--start'];
  if (opts.blockTime) args.push('--block-time', opts.blockTime);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);

  const log = openSync(DEVNET_LOG(), 'a');

  try {
    const child = spawn(bin, args, {
      detached: true,
      stdio: ['ignore', log, log],
    });

    child.on('error', () => {
      // Surfaced by the caller via the readiness probe; the listener exists so
      // an ENOENT does not become an unhandled 'error' event.
    });

    child.unref();
    if (child.pid === undefined) {
      throw new AdaError('devnet_start_failed', 'could not spawn the devkit', EXIT_INTERNAL);
    }
    return child.pid;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/ENOENT/.test(message)) throw notInstalled();
    throw err;
  }
}

export function notInstalled(): AdaError {
  return toolMissingError(
    'yaci-devkit not found',
    'install it with: npm i -g @bloxbean/yaci-devkit',
  );
}

/** The devkit's own PID file, which is the only handle it exposes. */
export function devnetPid(): number | undefined {
  const file = YACI_PID_FILE();
  if (!existsSync(file)) return undefined;
  try {
    const pid = parseInt(readFileSync(file, 'utf-8').trim(), 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 tests for existence and permission without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface ReadinessResult {
  ready: boolean;
  waitedMs: number;
  /** True when the devkit process exited before the API came up. Distinguishing
   *  this from a timeout matters: a crash is diagnosable from the log right now,
   *  whereas a timeout usually means "still starting, wait longer". */
  processDied: boolean;
}

export interface WaitOptions {
  timeoutMs?: number;
  /** Liveness predicate. Polled alongside the API so a crash aborts the wait
   *  immediately instead of burning the whole timeout — the first version of
   *  this waited 180s for a process that had died in 8. */
  isAlive?: () => boolean;
  onTick?: (waitedMs: number) => void;
}

/**
 * Poll the Blockfrost-compatible API until it answers. Readiness is defined by
 * the API responding, not by the process existing — a running JVM that is not
 * yet serving is not a usable devnet.
 */
export async function waitForDevnet(
  apiUrl: string,
  opts: WaitOptions = {},
): Promise<ReadinessResult> {
  const timeoutMs = opts.timeoutMs ?? DEVNET_READY_TIMEOUT_MS;
  const start = Date.now();

  for (;;) {
    if (await isReachable(apiUrl, ENDPOINTS.latestBlock)) {
      return { ready: true, waitedMs: Date.now() - start, processDied: false };
    }

    // Checked after the API probe so a process that served and then exited still
    // counts as ready — the ordering matters for short-lived races.
    if (opts.isAlive && !opts.isAlive()) {
      return { ready: false, waitedMs: Date.now() - start, processDied: true };
    }

    const waited = Date.now() - start;
    if (waited >= timeoutMs) return { ready: false, waitedMs: waited, processDied: false };
    opts.onTick?.(waited);
    await sleep(DEVNET_READY_POLL_MS);
  }
}

/**
 * Last lines of the devnet log. The log held the exact cause of every startup
 * failure seen so far, so failures quote it rather than guessing at a hint.
 */
export function tailLog(lines = 12): string[] {
  const path = DEVNET_LOG();
  if (!existsSync(path)) return [];
  try {
    const all = readFileSync(path, 'utf-8').split('\n').filter((l) => l.trim() !== '');
    return all.slice(-lines);
  } catch {
    return [];
  }
}

/**
 * The most useful single line from a failed startup. Bind conflicts and missing
 * binaries are the two failures that actually happen, and both announce
 * themselves in a form worth lifting out of a Java stack trace.
 */
export function diagnoseFailure(logLines: string[]): string | undefined {
  const joined = logLines.join('\n');
  if (/Address already in use/i.test(joined)) {
    return 'a port is already in use — another devnet or devkit process is still running';
  }
  if (/yaci-store binary is not found/i.test(joined)) {
    return 'the indexer component is missing — run: ada localnet bootstrap';
  }
  if (/binary is not found|Use 'download -c node'/i.test(joined)) {
    return 'the cardano-node binaries are missing — run: ada localnet bootstrap';
  }
  return undefined;
}

/**
 * Stop the devnet by terminating the devkit's process tree.
 *
 * The children are killed before the parent: killing the launcher first would
 * orphan the node, leaving a process holding the ports with nothing tracking it.
 */
export function stopDevnet(pid: number): void {
  try {
    spawn('pkill', ['-TERM', '-P', String(pid)], { stdio: 'ignore' });
  } catch {
    // best effort — the parent kill below is what matters
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone
  }
}

export const devnetLogPath = DEVNET_LOG;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
