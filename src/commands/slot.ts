// Slots and time, in both directions.
//
// This command exists because of a trap that costs everyone the same afternoon:
// a transaction declares its validity in **slots**, and a validator reads that
// same window in **POSIX milliseconds**. Write a deadline validator, pass it a
// slot number, and it compares 1,500 against 1,785,478,000,000 — never matching,
// and failing as `ValidationTagMismatch`, which reads as "your script is broken"
// rather than "your units are wrong".
//
// So every answer here gives both numbers, always. Not knowing which one a
// caller needs is precisely the confusion.

import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { loadConfig, resolveNetwork } from '../lib/cli-config.ts';
import { usageError } from '../lib/errors.ts';
import { writeJson } from '../lib/json-output.ts';
import { makeProvider, fetchTip } from '../lib/mesh.ts';
import {
  resolveSlotConfig, describeSlotConfig, forecastHorizonSlots, slotToMs, msToSlot,
} from '../lib/slot-config.ts';
import { parseDuration } from '../lib/validity.ts';
import { fields, heading, warn } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

/** A slot number is small; a POSIX millisecond timestamp is not. */
const LOOKS_LIKE_MS = 1_000_000_000_000;

export default async function slot(args: Args): Promise<void> {
  const network = resolveNetwork(loadConfig(), flagValue(args, 'network'));
  const provider = makeProvider(network);
  const tip = await fetchTip(provider);

  const resolved = await resolveSlotConfig(network, { slot: tip.slot, time: tip.time });
  const config = resolved.config;
  const horizon = await forecastHorizonSlots(network);

  const [input] = args.positionals;
  const { slot: targetSlot, relative } = interpret(input, tip.slot ?? 0, config);
  const ms = slotToMs(targetSlot, config);

  // A point past the horizon is not merely far away — a node cannot place it in
  // time at all, so a deadline there produces a contract nobody can satisfy.
  const beyondHorizon = horizon !== undefined && tip.slot !== null
    && targetSlot > tip.slot + horizon;

  if (hasFlag(args, 'json')) {
    writeJson({
      network: network.name,
      slot: targetSlot,
      posixMilliseconds: ms,
      posixSeconds: Math.floor(ms / 1000),
      iso: new Date(ms).toISOString(),
      tipSlot: tip.slot,
      ...(relative !== undefined ? { slotsFromTip: relative } : {}),
      slotConfig: { source: resolved.source, verified: resolved.verified ?? null, ...config },
      ...(horizon !== undefined ? { forecastHorizonSlots: horizon, beyondHorizon } : {}),
    });
    return;
  }

  process.stderr.write(heading('Slot') + '\n');
  process.stderr.write(fields([
    ['slot', String(targetSlot)],
    ['posix ms', String(ms)],
    ['iso', new Date(ms).toISOString()],
    ['tip slot', String(tip.slot ?? '—')],
    ['conversion', describeSlotConfig(resolved)],
  ]) + '\n');

  if (beyondHorizon) {
    process.stderr.write('\n' + warn(`beyond this chain's forecast horizon (~${horizon} slots ahead)`) + '\n');
    process.stderr.write(dim('  A node cannot place that slot in time, so a deadline there can never be met.') + '\n');
  }
  process.stderr.write('\n' + dim('  Use the slot for --valid-until; use posix ms for a deadline inside a validator.') + '\n\n');

  process.stdout.write(String(targetSlot) + '\n');
}

/**
 * Work out what was asked for.
 *
 * Nothing, or `now`, means the tip. `+30m` means that far ahead of the tip — of
 * the **chain's** tip, not the local clock, because a window anchored to a
 * machine that is a few seconds out fails in ways that look like anything but a
 * clock. A bare number is read as a slot unless it is large enough to only make
 * sense as milliseconds.
 */
function interpret(
  input: string | undefined, tipSlot: number, config: { zeroTime: number; zeroSlot: number; slotLength: number },
): { slot: number; relative?: number } {
  if (!input || input.trim().toLowerCase() === 'now') return { slot: tipSlot, relative: 0 };

  const text = input.trim();
  if (text.startsWith('+')) {
    const seconds = parseDuration(text.slice(1));
    const ahead = Math.ceil((seconds * 1000) / config.slotLength);
    return { slot: tipSlot + ahead, relative: ahead };
  }

  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) {
    throw usageError(`not a slot, a timestamp or a duration: ${input}`,
      'try: ada slot, ada slot +30m, ada slot 12345, or ada slot 1785478477000');
  }
  // Told a millisecond timestamp, answer with its slot rather than treating an
  // enormous number as a slot nobody will reach for fifty thousand years.
  if (n >= LOOKS_LIKE_MS) return { slot: msToSlot(n, config) };
  return { slot: Math.floor(n) };
}
