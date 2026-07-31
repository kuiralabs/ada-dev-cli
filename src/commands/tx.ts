// Where a transaction has got to.
//
// Submitting returns a hash and nothing else. From that moment the only way to
// find out what happened was to poll a balance and infer — and inference cannot
// tell the two failures apart, because a transaction still queued and one that
// was dropped are both simply absent from the chain.
//
// Three states, and they need different answers from the person waiting:
//
//   on-chain     done; here is the block
//   in mempool   accepted, waiting for a block — do nothing
//   not found    never submitted, or dropped — the retry is yours to make
//
// The middle one is the one that needed a node. The indexer cannot see a
// mempool, so `not found` used to cover both "wait" and "act", which is the
// worst possible pair to conflate.

import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { usageError } from '../lib/errors.ts';
import { writeJson } from '../lib/json-output.ts';
import { loadConfig, resolveNetwork } from '../lib/cli-config.ts';
import { makeProvider } from '../lib/mesh.ts';
import { probeOgmios } from '../lib/ogmios.ts';
import { hasTransaction, type MempoolAnswer } from '../lib/mempool.ts';
import { fields, heading, ok as okLine, warn } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

const SUBCOMMANDS = ['status'] as const;

/** A transaction hash is blake2b-256: 32 bytes, 64 hex characters. */
const TX_HASH = /^[0-9a-fA-F]{64}$/;

/** How long `--wait` keeps asking, and how often. */
const POLL_MS = 3_000;
const WAIT_TIMEOUT_MS = 180_000;

export default async function tx(args: Args): Promise<void> {
  const [sub, hash] = args.positionals;
  if (!sub) throw usageError('tx needs a subcommand', `one of: ${SUBCOMMANDS.join(', ')}`);
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw usageError(`unknown tx subcommand: ${sub}`, `one of: ${SUBCOMMANDS.join(', ')}`);
  }
  if (!hash) throw usageError('tx status needs a transaction hash', 'example: ada tx status <64 hex characters>');
  if (!TX_HASH.test(hash)) {
    throw usageError(`not a transaction hash: ${hash}`,
      'a transaction hash is 64 hex characters — the value `--json` reports as txHash');
  }

  const json = hasFlag(args, 'json');
  const network = resolveNetwork(loadConfig(), flagValue(args, 'network'));
  const provider = makeProvider(network);
  const ogmios = await probeOgmios(network);

  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  const waiting = hasFlag(args, 'wait');

  for (;;) {
    const at = await confirmedAt(provider, hash.toLowerCase());
    if (at !== undefined) {
      if (json) writeJson({ txHash: hash, state: 'on-chain', ...at });
      else {
        process.stdout.write(heading('Transaction') + '\n');
        process.stdout.write(fields([
          ['hash', hash],
          ['state', 'on-chain'],
          ...(at.block !== undefined ? [['block', String(at.block)] as [string, string]] : []),
          ...(at.slot !== undefined ? [['slot', String(at.slot)] as [string, string]] : []),
        ]) + '\n');
        process.stdout.write('\n' + okLine('confirmed') + '\n');
      }
      return;
    }

    const mempool: MempoolAnswer = ogmios.reachable && ogmios.url
      ? await hasTransaction(ogmios.url, hash.toLowerCase())
      : { available: false, reason: ogmios.reason ?? 'no Ogmios configured' };

    const queued = mempool.available && mempool.present;

    if (waiting && Date.now() < deadline) {
      // Keep waiting whether or not the mempool can be seen. Without Ogmios this
      // degrades to the poll it would have been anyway, which is still better
      // than the caller writing their own sleep.
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }

    report({ json, hash, queued, mempool, waited: waiting });
    return;
  }
}

/**
 * Where the chain has recorded this transaction, if it has.
 *
 * Providers do not agree on the shape. Yaci returns `{fees, hash, slot}` with no
 * block height at all, so a check for `blockHeight` found nothing and reported
 * every confirmed transaction as missing. What every provider does return is a
 * record whose `hash` matches — presence *is* the confirmation, and the slot or
 * block is decoration on top of it.
 */
async function confirmedAt(
  provider: ReturnType<typeof makeProvider>, hash: string,
): Promise<{ slot?: number; block?: number } | undefined> {
  try {
    const info = await provider.fetchTxInfo(hash) as {
      hash?: string; slot?: unknown; block?: unknown; blockHeight?: unknown;
    };
    if (!info || String(info.hash ?? '').toLowerCase() !== hash) return undefined;

    const slot = Number(info.slot ?? NaN);
    const block = Number(info.blockHeight ?? info.block ?? NaN);
    return {
      ...(Number.isFinite(slot) && slot > 0 ? { slot } : {}),
      ...(Number.isFinite(block) && block > 0 ? { block } : {}),
    };
  } catch {
    // Not found is the ordinary answer for something still in flight, and every
    // provider spells it differently. Absence is the signal, not the wording.
    return undefined;
  }
}

function report(r: {
  json: boolean; hash: string; queued: boolean; mempool: MempoolAnswer; waited: boolean;
}): void {
  const state = r.queued ? 'in-mempool' : 'not-found';

  if (r.json) {
    writeJson({
      txHash: r.hash,
      state,
      mempool: r.mempool.available
        ? { checked: true, present: r.mempool.present, ...(r.mempool.slot ? { slot: r.mempool.slot } : {}) }
        : { checked: false, reason: r.mempool.reason },
      ...(r.waited ? { timedOut: true } : {}),
    });
    return;
  }

  process.stdout.write(heading('Transaction') + '\n');
  process.stdout.write(fields([
    ['hash', r.hash],
    ['state', state],
    ['mempool', r.mempool.available
      ? (r.mempool.present ? 'holding it' : 'does not have it')
      : dim(`not checked — ${r.mempool.reason}`)],
  ]) + '\n');

  if (r.queued) {
    process.stdout.write('\n' + okLine('accepted, waiting for a block') + '\n');
    return;
  }

  if (!r.mempool.available) {
    // The honest answer, and the one that was being given silently before: we
    // cannot tell "queued" from "gone" without a node to ask.
    process.stdout.write('\n' + warn('the chain has not seen it, and there is no mempool to check') + '\n');
    process.stdout.write(dim('  It may be queued or it may have been dropped — these look identical from here.\n'));
    process.stdout.write(dim('  Running Ogmios distinguishes them: see docs/DEVNET.md.\n'));
    return;
  }

  process.stdout.write('\n' + warn('not on the chain and not in the mempool') + '\n');
  process.stdout.write(dim('  It was never submitted, or it was dropped — a transaction whose validity\n'));
  process.stdout.write(dim('  window has passed is removed without being recorded anywhere.\n'));
}
