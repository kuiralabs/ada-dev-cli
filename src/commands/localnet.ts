// Local devnet lifecycle. Wraps Yaci DevKit rather than reimplementing it —
// see lib/yaci.ts for why the launcher is spawned exactly once and everything
// else goes over HTTP.

import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { loadConfig, resolveNetwork } from '../lib/cli-config.ts';
import { usageError } from '../lib/errors.ts';
import { writeJson } from '../lib/json-output.ts';
import { isReachable } from '../lib/http.ts';
import { ENDPOINTS, DEVNET_READY_TIMEOUT_MS } from '../lib/constants.ts';
import {
  startDevnet, stopDevnet, waitForDevnet, devnetPid,
  isProcessAlive, devnetLogPath, resolveYaciBin,
  devkitComponentsReady, bootstrapComponents, tailLog, diagnoseFailure,
} from '../lib/yaci.ts';
import { fields, heading, ok, warn, emphasis } from '../ui/format.ts';

const SUBCOMMANDS = ['up', 'down', 'stop', 'status', 'logs', 'bootstrap'] as const;
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
    stopDevnet(stale);
    await settle();
  }

  if (!devkitComponentsReady()) {
    if (!json) {
      process.stdout.write('devkit components missing — downloading once (node ~800MB, indexer ~22MB)...\n');
    }
    const got = await bootstrapComponents(900_000, (_waited, what) => {
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
      writeJson({
        ok: false,
        reason: result.processDied ? 'devnet_exited' : 'devnet_not_ready',
        message,
        diagnosis: diagnosis ?? null,
        logPath: devnetLogPath(),
        logTail: logLines,
        waitedMs: result.waitedMs,
      });
    } else {
      process.stdout.write(warn(message) + '\n');
      if (diagnosis) process.stdout.write(`  ${diagnosis}\n`);
      process.stdout.write(`  logs: ${devnetLogPath()}\n`);
      // Quoting the log beats pointing at it: every startup failure so far named
      // its own cause in the last few lines.
      for (const line of logLines.slice(-6)) process.stdout.write(`    ${line}\n`);
    }
    process.exitCode = 4;
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

async function bootstrap(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  if (devkitComponentsReady()) {
    if (json) writeJson({ ok: true, status: 'already_present' });
    else process.stdout.write(ok('devkit components already present') + '\n');
    return;
  }
  if (!json) process.stdout.write('downloading devkit components (node ~800MB, indexer ~22MB, one time)...\n');
  const got = await bootstrapComponents(900_000, (_waited, what) => {
    if (!json) process.stdout.write(`  fetching ${what}...\n`);
  });
  if (!got) {
    return fail(json, 'component_download_failed', 'download did not complete', `check ${devnetLogPath()}`);
  }
  if (json) writeJson({ ok: true, status: 'downloaded' });
  else process.stdout.write(ok('devkit components downloaded') + '\n');
}

function fail(json: boolean, reason: string, message: string, hint: string): void {
  if (json) writeJson({ ok: false, reason, message, hint });
  else {
    process.stdout.write(warn(message) + '\n');
    process.stdout.write(`  ${hint}\n`);
  }
  process.exitCode = 4;
}

/** Brief pause so a terminated process actually releases its ports before the
 *  next bind attempt. Without it, cleanup and restart race. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 2_000));

async function down(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const pid = devnetPid();

  if (pid === undefined || !isProcessAlive(pid)) {
    if (json) {
      writeJson({ ok: true, status: 'not_running' });
    } else {
      process.stdout.write(ok('devnet is not running') + '\n');
    }
    return;
  }

  stopDevnet(pid);

  if (json) {
    writeJson({ ok: true, status: 'stopped', pid });
    return;
  }
  process.stdout.write(ok(`stopped devnet (pid ${pid})`) + '\n');
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
