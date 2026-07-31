// A watch-compile loop for Aiken sources.
//
// The counterpart of `mn dev`, and it earns its place here for a reason that is
// specific to this chain: **a validator's address is a hash of its compiled
// code**, so every source edit moves it. Anything you locked a minute ago now
// sits at an address your new build cannot spend from.
//
// That is the single most disorienting thing about developing on Cardano, and
// nothing tells you it has happened. `contract address` reports the new one
// perfectly happily; the funds at the old one simply stop being mentioned. So
// this loop's real job is not saving keystrokes — it is saying *the address
// changed, and there is money at the old one*.

import { watch, type FSWatcher } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { usageError } from '../lib/errors.ts';
import { writeJson } from '../lib/json-output.ts';
import { loadConfig, resolveNetwork } from '../lib/cli-config.ts';
import { makeProvider } from '../lib/mesh.ts';
import { runAiken } from '../lib/aiken.ts';
import {
  loadBlueprint, selectValidator, scriptIdentity, parseParams, listNames,
} from '../lib/blueprint.ts';
import { lovelaceToAda } from '../lib/amount.ts';
import { heading, fields, warn, ok } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

/**
 * Editors do not write a file once.
 *
 * Vim writes a swap file and renames; VS Code truncates then writes. Both
 * produce several events for one save, and compiling on each of them means the
 * first compile is still running when the third event arrives.
 */
const DEBOUNCE_MS = 250;

/** Where Aiken keeps sources. Watched if present; a project may not have both. */
const SOURCE_DIRS = ['validators', 'lib'] as const;

export default async function dev(args: Args): Promise<void> {
  const dir = flagValue(args, 'path') ?? process.cwd();
  const json = hasFlag(args, 'json');

  const watching = SOURCE_DIRS.map((d) => join(dir, d)).filter((d) => existsSync(d));
  if (watching.length === 0) {
    throw usageError(
      `no Aiken sources under ${dir}`,
      'expected a validators/ or lib/ directory — run this from an Aiken project, or pass --path',
    );
  }

  const network = resolveNetwork(loadConfig(), flagValue(args, 'network'));

  if (!json) {
    process.stdout.write(heading('Watching') + '\n');
    process.stdout.write(fields([
      ['project', dir],
      ['sources', watching.map((w) => w.slice(dir.length + 1)).join(', ')],
      ['network', network.name],
    ]) + '\n');
    process.stdout.write(dim('\n  Save a .ak file to rebuild. Ctrl-C to stop.\n\n'));
  }

  // The address before any edit, so the first rebuild can already say whether it
  // moved. Absent for a parameterised validator with no --params: there is no
  // single address then, and inventing one would be worse than saying nothing.
  let previous = await currentIdentity(args, dir, network.name);
  if (previous && !json) {
    process.stdout.write(dim(`  currently ${previous.address}\n\n`));
  }

  await rebuildOn(watching, async () => {
    // `runAiken` throws when the compiler is unhappy, which is right for a
    // one-shot command and fatal for a loop: a failing compile is the *normal*
    // case here — it is what you are watching for — and the first syntax error
    // killed the whole process.
    let tests: { total: number; passed: number; failed: number } | undefined;
    let compiled = false;
    try {
      // `check` type-checks and runs the validator's tests. It does **not**
      // write plutus.json — only `build` does — so a loop that ran check alone
      // derived every address from a stale blueprint and reported that nothing
      // had moved while the source said otherwise. Both, in the order a
      // developer wants them: tests first, artifact second, and no artifact at
      // all from source whose tests fail.
      const result = runAiken(['check'], dir, { json: true });
      tests = result.report?.summary;
      compiled = result.report !== undefined && (tests?.failed ?? 0) === 0;
      if (compiled) runAiken(['build'], dir, { json: true });
    } catch (err) {
      // A compiler that will not run at all is different from source that will
      // not compile, and only the first is worth stopping for.
      if ((err as { code?: string }).code === 'tool_missing') throw err;
      tests = undefined;
      compiled = false;
    }

    // Only re-derive when the compile succeeded: a failed build leaves the last
    // good plutus.json in place, and reporting its address as though it were the
    // new one would be a lie in the most expensive possible place.
    const next = compiled ? await currentIdentity(args, dir, network.name) : undefined;
    const moved = previous && next && previous.address !== next.address;

    const stranded = moved ? await valueAt(network, previous!.address) : undefined;

    if (json) {
      writeJson({
        event: 'rebuild',
        ok: compiled,
        ...(tests ? { tests } : {}),
        ...(next ? { scriptHash: next.hash, address: next.address } : {}),
        ...(moved ? {
          addressChanged: true,
          previousAddress: previous!.address,
          ...(stranded !== undefined ? { strandedLovelace: stranded.toString() } : {}),
        } : {}),
      });
    } else {
      report({ compiled, tests, next, previous, moved: moved === true, stranded });
    }

    if (next) previous = next;
  });
}

interface Identity { hash: string; address: string }

/** The validator's hash and address as the current build has them. */
async function currentIdentity(
  args: Args, dir: string, network: Parameters<typeof scriptIdentity>[2],
): Promise<Identity | undefined> {
  try {
    const loaded = loadBlueprint(flagValue(args, 'blueprint'), dir);
    // With several validators and no selection there is no single answer, and
    // picking one would report movement in something the developer is not editing.
    if (listNames(loaded.doc.validators).length > 1
      && !flagValue(args, 'module') && !flagValue(args, 'validator')) return undefined;

    const validator = selectValidator(loaded, {
      module: flagValue(args, 'module'), validator: flagValue(args, 'validator'),
    });
    const identity = scriptIdentity(loaded, validator, network, parseParams(flagValue(args, 'params')));
    return { hash: identity.hash, address: identity.address };
  } catch {
    // No blueprint yet, or parameters not supplied. Both are ordinary states for
    // a project being edited, and neither is worth interrupting the loop for.
    return undefined;
  }
}

/** What is sitting at an address, when a chain is reachable. */
async function valueAt(
  network: ReturnType<typeof resolveNetwork>, address: string,
): Promise<bigint | undefined> {
  try {
    const utxos = await makeProvider(network).fetchAddressUTxOs(address);
    return utxos.reduce((total, u) => total + BigInt(
      (u.output.amount as Array<{ unit: string; quantity: string }>)
        .filter((a) => a.unit === 'lovelace' || a.unit === '')
        .reduce((sum, a) => sum + BigInt(a.quantity), 0n),
    ), 0n);
  } catch {
    // An unreachable chain must not break the loop; the rebuild still happened.
    return undefined;
  }
}

function report(r: {
  compiled: boolean;
  tests?: { total: number; passed: number; failed: number };
  next?: Identity;
  previous?: Identity;
  moved: boolean;
  stranded?: bigint;
}): void {
  const time = new Date().toTimeString().slice(0, 8);

  if (!r.compiled) {
    // Aiken's own diagnostics have already gone to stderr with the source line
    // underlined; repeating them here would be worse than pointing at them.
    process.stdout.write(`${dim(time)}  ${warn('build failed')}\n\n`);
    return;
  }

  const summary = r.tests
    ? `${r.tests.passed}/${r.tests.total} tests`
    : 'built';
  process.stdout.write(`${dim(time)}  ${ok(summary)}`);
  process.stdout.write(r.next ? `  ${dim(r.next.hash.slice(0, 16) + '…')}\n` : '\n');

  if (!r.moved) {
    process.stdout.write('\n');
    return;
  }

  // The whole reason this command exists.
  process.stdout.write('\n' + warn('  the address changed') + '\n');
  process.stdout.write(fields([
    ['was', r.previous!.address],
    ['now', r.next!.address],
  ]) + '\n');

  if (r.stranded !== undefined && r.stranded > 0n) {
    process.stdout.write('\n' + warn(
      `  ${lovelaceToAda(r.stranded)} ADA is at the old address and this build cannot spend it`) + '\n');
    process.stdout.write(dim('  Rebuild the previous source to reach it, or unlock it before editing further.\n'));
  } else {
    process.stdout.write(dim('  Nothing is locked at the old one.\n'));
  }
  process.stdout.write('\n');
}

/**
 * Run `onChange` whenever a watched source is written, until interrupted.
 *
 * Serialised deliberately: a compile triggered while the previous one is still
 * running interleaves two sets of diagnostics and races on plutus.json.
 */
async function rebuildOn(dirs: string[], onChange: () => Promise<void>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let again = false;

  const trigger = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      if (running) { again = true; return; }
      running = true;
      try {
        do {
          again = false;
          try {
            await onChange();
          } catch (err) {
            // Report and keep watching. The next save is the retry, and a loop
            // that exits on a bad build is a loop nobody can use.
            process.stderr.write(`  ${(err as Error).message}\n\n`);
          }
        } while (again);
      } finally {
        running = false;
      }
    }, DEBOUNCE_MS);
  };

  const watchers: FSWatcher[] = dirs.map((d) =>
    watch(d, { recursive: true }, (_event, file) => {
      if (file && file.endsWith('.ak')) trigger();
    }));

  await new Promise<void>((resolve) => {
    const stop = () => {
      for (const w of watchers) w.close();
      if (timer) clearTimeout(timer);
      process.stdout.write(dim('\n  stopped\n'));
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}
