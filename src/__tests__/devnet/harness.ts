// The shared harness for chain tests.
//
// **These suites must not run in parallel**, which is why `test:chain` passes
// `--no-file-parallelism`. They all spend from one wallet, and two transactions
// selecting the same UTxOs means the second is rejected for spending what the
// first already took — reported correctly as `inputs_already_spent`, and still a
// failure. The wallet's UTxO set is a shared resource; serialising is the honest
// answer, not retrying until the race is won.
//
// Extracted when a second chain-test file arrived. Duplicating the CLI runner,
// the settle timings and the reachability probe is exactly how two suites end up
// disagreeing about what "reachable" means — and the probe in particular has
// already been wrong twice, once by running in beforeAll (so every test silently
// skipped) and once by passing a flag the command does not take.

import { it, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { acceptedFlags } from '../../lib/flags.ts';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const CLI = join(HERE, '..', '..', 'ada.ts');
export const BLUEPRINT = process.env.ADA_TEST_BLUEPRINT
  ?? join(HERE, 'fixtures', 'hello-world');

/**
 * Which chain to run against, and with whose money.
 *
 *   ADA_TEST_NETWORK=preprod ADA_TEST_WALLET=preprod-test npm run test:chain
 *
 * Parameterised because the preprod pass was done by hand once, and a
 * verification performed once is a claim rather than a check — the same argument
 * that put these tests here in the first place.
 */
export const NETWORK = process.env.ADA_TEST_NETWORK ?? 'devnet';
export const WALLET = process.env.ADA_TEST_WALLET;
export const IS_LOCAL = NETWORK === 'devnet';

/**
 * How long to wait for a transaction to be visible.
 *
 * A devnet produces a block a second; preprod takes about twenty, and being
 * *in* a block is not the same as the indexer having caught up. Measured at
 * roughly 75–90 seconds on preprod, so the ceiling is generous — a test that
 * gives up early reports a failure that is really impatience.
 */
export const SETTLE_MS = IS_LOCAL ? 5_000 : 20_000;
export const CONFIRM_TRIES = IS_LOCAL ? 6 : 15;
export const TEST_TIMEOUT = IS_LOCAL ? 240_000 : 900_000;

const LOCAL_PROBE = 'http://localhost:8080/api/v1/blocks/latest';

/** Run the CLI exactly as a user would, and parse the JSON contract. */
export function ada(args: string[]): Record<string, any> {
  // Only the flags the command actually takes.
  //
  // This used to append `--wallet` to everything, which worked while unknown
  // flags were silently ignored and stopped working the moment they were not:
  // `ada tip --wallet x` became an error, the reachability probe failed, and the
  // whole suite skipped itself reporting "preprod unreachable". Asked of the same
  // specification the CLI validates against, so the two cannot disagree.
  const accepts = acceptedFlags(args[0]) ?? [];
  const withNetwork = [
    ...args,
    ...(accepts.includes('network') ? ['--network', NETWORK] : []),
    ...(WALLET && accepts.includes('wallet') && !args.includes('--wallet') ? ['--wallet', WALLET] : []),
  ];
  try {
    const out = execFileSync('npx', ['tsx', CLI, ...withNetwork, '--json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 300_000,
    });
    return JSON.parse(out);
  } catch (err) {
    // A non-zero exit still carries a JSON document on stdout — that is the
    // contract, and the failure shape is exactly what several of these assert.
    const stdout = (err as { stdout?: string }).stdout ?? '';
    try { return JSON.parse(stdout); } catch { throw err; }
  }
}

export const settle = () => new Promise((r) => setTimeout(r, SETTLE_MS));

/**
 * Wait for a UTxO to appear at the script address, in a state the test can use.
 *
 * A fixed sleep was fine against one-second blocks and is guesswork against
 * twenty-second ones, so this polls. But existence alone is not enough: an
 * indexer can serve the output before it has attached the datum, and a spend
 * needs the datum. That showed up as the hash-datum test failing *inside* the
 * suite while passing alone — and failing **faster**, which is the signature of
 * winning a race rather than losing to a timeout.
 *
 * So the condition is what the next step actually requires, not merely that
 * something is there.
 */
export async function awaitUtxo(ref: string, needs?: 'datum'): Promise<any> {
  for (let i = 0; i < CONFIRM_TRIES; i++) {
    await settle();
    const at = ada(['contract', 'utxos', '--blueprint', BLUEPRINT]);
    const found = at.utxos?.find((u: any) => u.ref === ref);
    if (!found) continue;
    if (needs === 'datum' && found.datumEncoding === 'none') continue;
    return found;
  }
  throw new Error(`${ref} never became usable at the script address on ${NETWORK}`
    + (needs ? ` (waiting for its ${needs})` : ''));
}

async function reachable(): Promise<boolean> {
  if (!IS_LOCAL) {
    // A public network is reachable if the tool can read its tip.
    return ada(['tip']).ok === true;
  }
  try {
    return (await fetch(LOCAL_PROBE, { signal: AbortSignal.timeout(2500) })).ok;
  } catch {
    return false;
  }
}

// Probed at module scope, deliberately.
//
// Doing this in beforeAll silently skipped every test: vitest decides `it` vs
// `it.skip` while *collecting* the file, which happens before any hook runs, so
// the flag was always false and the suite reported green having exercised
// nothing. That is precisely the failure this file exists to prevent, so it is
// worth the top-level await.
const available = await reachable();
if (!available) {
  console.warn(`\n  ⚠ ${NETWORK} unreachable — skipping chain tests.`
    + (IS_LOCAL ? ' Start one with: ada localnet up\n' : '\n'));
}

export const chain = () => (available ? it : it.skip);

/**
 * Pace tests apart on a public network.
 *
 * Two transactions from one wallet in quick succession select the same UTxOs,
 * and the second is rejected for spending what the first already took. That is
 * a property of the wallet rather than of any test, so it is paced here — but
 * registered on request rather than on import: a shared module that quietly
 * installs hooks in whatever file touches it is a surprise waiting to happen.
 */
export function paceBetweenTests(): void {
  afterEach(async () => {
    if (available && !IS_LOCAL) await settle();
  });
}


