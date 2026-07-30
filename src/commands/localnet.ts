// Local devnet lifecycle. Wraps Yaci DevKit rather than reimplementing it —
// see lib/yaci.ts for why the launcher is spawned exactly once and everything
// else goes over HTTP.

import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { loadConfig, resolveNetwork } from '../lib/cli-config.ts';
import { usageError } from '../lib/errors.ts';
import { writeJson, writeJsonError } from '../lib/json-output.ts';
import { isReachable } from '../lib/http.ts';
import { ENDPOINTS, DEVKIT_ENDPOINTS, DEVNET_READY_TIMEOUT_MS } from '../lib/constants.ts';
import { EXIT_NOT_RUNNING } from '../lib/exit-codes.ts';

/** A ~1.4GB download over a slow connection needs a generous ceiling. */
const COMPONENT_DOWNLOAD_TIMEOUT_MS = 900_000;
import {
  startDevnet, waitForDevnet, devnetPid,
  isProcessAlive, devnetLogPath, resolveYaciBin,
  devkitComponentsReady, bootstrapComponents, tailLog, diagnoseFailure,
  stopDevnetAndVerify, devnetPortsInUse,
} from '../lib/yaci.ts';
import { fields, heading, ok, warn, emphasis } from '../ui/format.ts';

const SUBCOMMANDS = ['up', 'down', 'stop', 'status', 'logs', 'bootstrap', 'reset'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export default async function localnet(args: Args): Promise<void> {
  const [sub] = args.positionals;
  if (!sub) {
    throw usageError('localnet needs a subcommand', `one of: ${SUBCOMMANDS.join(', ')}`);
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw usageError(`unknown localnet subcommand: ${sub}`, `one of: ${SUBCOMMANDS.join(', ')}`);
  }

  switch (sub as Subcommand) {
    case 'up': return up(args);
    case 'down':
    case 'stop': return down(args);
    case 'status': return status(args);
    case 'logs': return logs(args);
    case 'bootstrap': return bootstrap(args);
    case 'reset': return reset(args);
  }
}

/** Devnet endpoints are fixed by the devkit, so resolve against devnet always —
 *  `localnet` is meaningless for a public network. */
function devnetTarget() {
  return resolveNetwork(loadConfig(), 'devnet');
}

async function up(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const target = devnetTarget();

  // Idempotent: a second `up` against a live devnet reports success rather than
  // starting a competing instance. The devkit would kill the first one.
  if (await isReachable(target.apiUrl, ENDPOINTS.latestBlock)) {
    if (json) {
      writeJson({ ok: true, status: 'already_running', apiUrl: target.apiUrl });
    } else {
      process.stdout.write(ok(`devnet already running at ${emphasis(target.apiUrl)}`) + '\n');
    }
    return;
  }

  // A devkit process that is alive but not serving holds the admin port, and the
  // next start then dies on a bind conflict. Clearing it here is what makes `up`
  // reliable rather than order-dependent — this exact state cost a 180s wait for
  // a process that had already died.
  const stale = devnetPid();
  if (stale !== undefined && isProcessAlive(stale)) {
    if (!json) process.stdout.write(warn(`clearing a stale devkit process (pid ${stale})`) + '\n');
    // Verified rather than fire-and-forget: an unverified stop is what left the
    // node holding port 3001 and made the following start fail on a bind
    // conflict.
    const cleared = await stopDevnetAndVerify(stale);
    if (!cleared.stopped) {
      return fail(json, 'stale_process_stuck',
        'could not free the ports held by a previous devnet',
        `still held: ${cleared.portsStillHeld.join(', ')}`);
    }
  }

  // Orphaned services with no controller: the same bind conflict, arrived at from
  // the other direction.
  const orphanPorts = await devnetPortsInUse();
  if (orphanPorts.length > 0) {
    return fail(json, 'ports_in_use',
      `ports already in use: ${orphanPorts.join(', ')}`,
      'a previous devnet left services running — run: ada localnet down');
  }

  if (!devkitComponentsReady()) {
    if (!json) {
      process.stdout.write('devkit components missing — downloading once (about 1.4GB total)...\n');
    }
    const got = await bootstrapComponents(COMPONENT_DOWNLOAD_TIMEOUT_MS, (_waited, what) => {
      if (!json) process.stdout.write(`  fetching ${what}...\n`);
    });
    if (!got) {
      return fail(json, 'component_download_failed', 'could not download the devkit components',
        `check ${devnetLogPath()}`);
    }
    if (!json) process.stdout.write(ok('components downloaded') + '\n');
    await settle();
  }

  const blockTime = flagValue(args, 'block-time');
  const pid = startDevnet({ blockTime });

  if (!json) {
    process.stdout.write(`starting devnet (pid ${pid}), waiting for the API...\n`);
  }

  const result = await waitForDevnet(target.apiUrl, {
    timeoutMs: DEVNET_READY_TIMEOUT_MS,
    isAlive: () => isProcessAlive(pid),
  });

  if (!result.ready) {
    const logLines = tailLog();
    const diagnosis = diagnoseFailure(logLines);
    const message = result.processDied
      ? `the devkit exited after ${(result.waitedMs / 1000).toFixed(1)}s without serving the API`
      : `devnet did not answer within ${Math.round(DEVNET_READY_TIMEOUT_MS / 1000)}s`;

    if (json) {
      writeJsonError(
        result.processDied ? 'devnet_exited' : 'devnet_not_ready',
        message,
        diagnosis,
        { logPath: devnetLogPath(), logTail: logLines, waitedMs: result.waitedMs },
      );
    } else {
      process.stdout.write(warn(message) + '\n');
      if (diagnosis) process.stdout.write(`  ${diagnosis}\n`);
      process.stdout.write(`  logs: ${devnetLogPath()}\n`);
      // Quoting the log beats pointing at it: every startup failure so far named
      // its own cause in the last few lines.
      for (const line of logLines.slice(-6)) process.stdout.write(`    ${line}\n`);
    }
    process.exitCode = EXIT_NOT_RUNNING;
    return;
  }

  if (json) {
    writeJson({ ok: true, status: 'running', pid, apiUrl: target.apiUrl, waitedMs: result.waitedMs });
    return;
  }
  process.stdout.write(
    ok(`devnet ready in ${(result.waitedMs / 1000).toFixed(1)}s at ${emphasis(target.apiUrl)}`) + '\n',
  );
}

/**
 * Wipe the chain back to genesis without restarting the devnet.
 *
 * The devkit exposes this on its control API, so it is one call rather than a
 * stop-and-start — which matters because a restart re-downloads nothing but does
 * cost ten seconds, and resetting is something you do often.
 *
 * Requires --yes: every wallet's funds and history vanish. That is normally fine on
 * a disposable chain, but it should be a decision rather than a typo.
 */
async function reset(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const target = devnetTarget();

  if (!hasFlag(args, 'yes')) {
    throw usageError(
      'reset wipes the devnet chain back to genesis',
      'every balance and transaction on it is lost — pass --yes to confirm',
    );
  }

  if (!(await isReachable(target.apiUrl, ENDPOINTS.latestBlock))) {
    return fail(json, 'devnet_not_running', 'the devnet is not running',
      'start it with: ada localnet up');
  }

  const adminUrl = target.adminUrl;
  if (!adminUrl) {
    return fail(json, 'config_error', 'no control URL configured for the devnet',
      'set it with: ada config set endpoints.devnet.adminUrl <url>');
  }

  try {
    const res = await fetch(`${adminUrl}${DEVKIT_ENDPOINTS.reset}`, { method: 'POST' });
    if (!res.ok) {
      return fail(json, 'reset_failed', `the devnet refused the reset (${res.status})`,
        `check ${devnetLogPath()}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(json, 'reset_failed', `could not reach the control API: ${message}`,
      'check: ada localnet status');
  }

  if (json) {
    writeJson({ status: 'reset', note: 'the chain is back at genesis; wallet keys are untouched' });
    return;
  }
  process.stdout.write(ok('devnet reset to genesis') + '\n');
  process.stdout.write('  wallet keys are untouched, but every balance is gone — fund again with: ada airdrop 1000\n');
}

async function bootstrap(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  if (devkitComponentsReady()) {
    if (json) writeJson({ ok: true, status: 'already_present' });
    else process.stdout.write(ok('devkit components already present') + '\n');
    return;
  }
  if (!json) process.stdout.write('downloading devkit components (about 1.4GB, one time)...\n');
  const got = await bootstrapComponents(COMPONENT_DOWNLOAD_TIMEOUT_MS, (_waited, what) => {
    if (!json) process.stdout.write(`  fetching ${what}...\n`);
  });
  if (!got) {
    return fail(json, 'component_download_failed', 'download did not complete', `check ${devnetLogPath()}`);
  }
  if (json) writeJson({ ok: true, status: 'downloaded' });
  else process.stdout.write(ok('devkit components downloaded') + '\n');
}

function fail(json: boolean, code: string, message: string, hint: string): void {
  if (json) writeJsonError(code, message, hint);
  else {
    process.stdout.write(warn(message) + '\n');
    process.stdout.write(`  ${hint}\n`);
  }
  process.exitCode = EXIT_NOT_RUNNING;
}

/** Brief pause so a terminated process actually releases its ports before the
 *  next bind attempt. Without it, cleanup and restart race. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 2_000));

async function down(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const pid = devnetPid();

  // "Not running" must mean no ports held, not just no controlling process. A
  // dead controller with a live node is the state that made the next `up` fail on
  // a bind conflict, so it has to be reported as still running.
  if (pid === undefined || !isProcessAlive(pid)) {
    const held = await devnetPortsInUse();
    if (held.length === 0) {
      if (json) writeJson({ ok: true, status: 'not_running' });
      else process.stdout.write(ok('devnet is not running') + '\n');
      return;
    }
    const message = 'the devnet controller is gone but its services are still listening';
    const hint = `ports still held: ${held.join(', ')} — they must be freed before the next start`;
    if (json) writeJsonError('orphaned_services', message, hint, { portsHeld: held });
    else {
      process.stdout.write(warn(message) + '\n');
      process.stdout.write(`  ${hint}\n`);
    }
    process.exitCode = EXIT_NOT_RUNNING;
    return;
  }

  const result = await stopDevnetAndVerify(pid);

  if (!result.stopped) {
    const message = 'stop did not free every port';
    const hint = `still held: ${result.portsStillHeld.join(', ')}`;
    if (json) {
      writeJsonError('stop_incomplete', message, hint, {
        pid, portsHeld: result.portsStillHeld, escalatedToKill: result.escalatedToKill,
      });
    } else {
      process.stdout.write(warn(message) + '\n');
      process.stdout.write(`  ${hint}\n`);
    }
    process.exitCode = EXIT_NOT_RUNNING;
    return;
  }

  if (json) {
    writeJson({ ok: true, status: 'stopped', pid, escalatedToKill: result.escalatedToKill });
    return;
  }
  const suffix = result.escalatedToKill ? ' (required SIGKILL)' : '';
  process.stdout.write(ok(`stopped devnet and all services (pid ${pid})${suffix}`) + '\n');
}

async function status(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const target = devnetTarget();
  const pid = devnetPid();
  const processAlive = pid !== undefined && isProcessAlive(pid);
  const apiUp = await isReachable(target.apiUrl, ENDPOINTS.latestBlock);

  // Process-alive and API-up are reported separately on purpose. "Starting" and
  // "wedged" look identical if you only check one, and that distinction is
  // exactly what someone runs `status` to find out.
  const state = apiUp ? 'running' : processAlive ? 'starting_or_unhealthy' : 'stopped';

  if (json) {
    writeJson({
      ok: true,
      state,
      processAlive,
      apiReachable: apiUp,
      pid: pid ?? null,
      apiUrl: target.apiUrl,
      logPath: devnetLogPath(),
    });
    return;
  }

  process.stdout.write(heading('Devnet status') + '\n');
  process.stdout.write(
    fields([
      ['state', state],
      ['process', processAlive ? `alive (pid ${pid})` : 'not running'],
      ['api', apiUp ? `reachable at ${target.apiUrl}` : `unreachable at ${target.apiUrl}`],
      ['logs', devnetLogPath()],
      ['devkit', resolveYaciBin()],
    ]) + '\n',
  );

  if (state === 'starting_or_unhealthy') {
    process.stdout.write(
      '\n' + warn('the process is alive but the API is not answering — it may still be starting') + '\n',
    );
  }
}

async function logs(args: Args): Promise<void> {
  const path = devnetLogPath();
  if (hasFlag(args, 'json')) {
    writeJson({ ok: true, logPath: path });
    return;
  }
  // The path rather than the contents: tailing is what `tail -f` is for, and
  // streaming a log through this process would break the output contract.
  process.stdout.write(`${path}\n`);
}
