// Transaction validity intervals, reference inputs and extra signers.
//
// Three capabilities MeshJS already provides that a contract surface without
// them cannot express: a deadline validator reads the transaction's validity
// range, an oracle pattern reads a UTxO without spending it, and a multi-party
// validator checks for signatures beyond the one paying.

import { usageError } from './errors.ts';

/**
 * Cardano's slot length in the Shelley era and later: one second, on every
 * current network.
 *
 * Stated as a constant rather than assumed inline so that when a network appears
 * where it is not one second, this is the single place that is wrong.
 */
export const SLOT_SECONDS = 1;

/** `90s`, `15m`, `2h`, `1d` — or a plain number, read as seconds. */
export function parseDuration(raw: string): number {
  const m = raw.trim().match(/^(\d+)\s*([smhd]?)$/i);
  if (!m) {
    throw usageError(`not a duration: ${raw}`, 'use a number with s, m, h or d — for example 30m');
  }
  const n = Number(m[1]);
  switch (m[2].toLowerCase()) {
    case 'd': return n * 86_400;
    case 'h': return n * 3_600;
    case 'm': return n * 60;
    default: return n;
  }
}

export interface ValidityWindow {
  invalidBefore?: number;
  invalidHereafter?: number;
}

export interface ValidityInput {
  /** `--valid-from <slot>`, or the literal `now`. */
  from?: string;
  /** `--valid-until <slot>`. */
  until?: string;
  /** `--valid-for <duration>`, measured from the chain's current slot. */
  forDuration?: string;
}

/**
 * Work out the validity window, in slots.
 *
 * **`tipSlot` comes from the chain, and that is the point.** A window derived
 * from the local clock is a window the chain may disagree with: a machine a few
 * seconds fast produces a transaction that is not yet valid, and one a few
 * seconds slow produces one that has already expired. Both fail in ways that
 * look like anything but a clock. Anchoring to the tip removes the question.
 */
export function resolveValidity(input: ValidityInput, tipSlot: number): ValidityWindow {
  assertValidityShape(input);
  const window: ValidityWindow = {};

  if (input.from !== undefined) {
    window.invalidBefore = input.from.trim().toLowerCase() === 'now'
      ? tipSlot
      : requireSlot(input.from, '--valid-from');
  }

  if (input.until !== undefined) window.invalidHereafter = requireSlot(input.until, '--valid-until');
  if (input.forDuration !== undefined) {
    window.invalidHereafter = tipSlot + Math.ceil(parseDuration(input.forDuration) / SLOT_SECONDS);
  }

  if (window.invalidBefore !== undefined && window.invalidHereafter !== undefined
      && window.invalidHereafter <= window.invalidBefore) {
    throw usageError(
      `the window ends at slot ${window.invalidHereafter} but starts at ${window.invalidBefore}`,
      'a transaction valid for no time at all can never be submitted',
    );
  }

  return window;
}

function requireSlot(raw: string, flag: string): number {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0) {
    throw usageError(`${flag} needs a slot number, got: ${raw}`,
      'slots are whole numbers — use --valid-for to work in durations instead');
  }
  return n;
}

/** `<hash>#<index>[,<hash>#<index>]` — the convention `swap` already uses. */
export function parseOutputRefs(raw: string | undefined, flag: string): { txHash: string; index: number }[] {
  if (!raw) return [];
  return raw.split(',').map((p) => p.trim()).filter((p) => p !== '').map((part) => {
    const m = part.match(/^([0-9a-fA-F]{64})#(\d+)$/);
    if (!m) {
      throw usageError(`${flag}: "${part}" is not a UTxO reference`, 'the form is <tx-hash>#<index>');
    }
    return { txHash: m[1].toLowerCase(), index: Number(m[2]) };
  });
}

/**
 * Extra public-key hashes the transaction must be signed by.
 *
 * The wallet's own is always added elsewhere; these are the *other* parties a
 * validator checks for. Note that naming a signer does not produce a signature —
 * it declares one is required, and the transaction cannot settle until that key
 * has signed.
 */
export function parseSigners(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map((p) => p.trim()).filter((p) => p !== '').map((hash) => {
    if (!/^[0-9a-fA-F]{56}$/.test(hash)) {
      throw usageError(`--signer: "${hash}" is not a public-key hash`,
        'a blake2b-224 hash is 56 hex characters — `ada address inspect <addr>` reports one');
    }
    return hash.toLowerCase();
  });
}

/**
 * Check everything about a validity window that does not need a chain.
 *
 * Split out because the slot arithmetic needs the tip, and a network round trip
 * is a slow and confusing way to be told a duration was misspelled. Whether
 * "soon" is a duration, and whether two conflicting end bounds were given, are
 * knowable immediately.
 */
export function assertValidityShape(input: ValidityInput): void {
  if (input.until !== undefined && input.forDuration !== undefined) {
    throw usageError('--valid-until and --valid-for both set an end',
      'use one: a slot number, or a duration from now');
  }
  if (input.forDuration !== undefined) parseDuration(input.forDuration);
  if (input.until !== undefined) requireSlot(input.until, '--valid-until');
  if (input.from !== undefined && input.from.trim().toLowerCase() !== 'now') {
    requireSlot(input.from, '--valid-from');
  }
}
