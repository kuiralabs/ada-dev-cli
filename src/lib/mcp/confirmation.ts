// Two-step confirmation for tools that move money.
//
// A destructive tool does not execute on its first call. It registers a pending
// operation and returns a token plus a human-readable description. The agent shows
// the description to the user, obtains consent, then redeems the token.
//
// Why this exists at all: the CLI protects a human with `--yes`, which works
// because a human types it deliberately. An agent would simply pass `--yes` —
// there is nothing about the flag that forces a conversation. A token the agent
// cannot mint itself does force one.
//
// Tokens expire, so a prompt the user ignored cannot be redeemed an hour later
// against a chain state that has moved.

import { randomUUID } from 'node:crypto';

export interface PendingOperation {
  token: string;
  tool: string;
  args: Record<string, unknown>;
  /** Shown to the user verbatim. Amounts and recipients must never be paraphrased. */
  description: string;
  createdAt: number;
  expiresAt: number;
}

export interface CreateOptions {
  tool: string;
  args: Record<string, unknown>;
  description: string;
}

/** Long enough for a real conversation, short enough that stale consent expires. */
export const DEFAULT_TTL_MS = 5 * 60 * 1000;

export interface ConfirmationStore {
  create(op: CreateOptions): PendingOperation;
  /** Single-use: a redeemed token is removed, so a replay cannot send twice. */
  redeem(token: string): PendingOperation | null;
  sweep(now?: number): number;
  size(): number;
}

export function createConfirmationStore(
  opts: { ttlMs?: number; now?: () => number } = {},
): ConfirmationStore {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? (() => Date.now());
  const pending = new Map<string, PendingOperation>();

  const sweepInternal = (at: number): number => {
    let removed = 0;
    for (const [token, entry] of pending) {
      if (entry.expiresAt <= at) {
        pending.delete(token);
        removed += 1;
      }
    }
    return removed;
  };

  return {
    create(op) {
      const created = now();
      // Swept on create so tokens from prompts the user declined do not accumulate
      // across a long session.
      sweepInternal(created);
      const entry: PendingOperation = {
        token: randomUUID(),
        tool: op.tool,
        args: op.args,
        description: op.description,
        createdAt: created,
        expiresAt: created + ttlMs,
      };
      pending.set(entry.token, entry);
      return entry;
    },
    redeem(token) {
      const entry = pending.get(token);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        pending.delete(token);
        return null;
      }
      // Deleted before returning: a token is good for exactly one execution.
      pending.delete(token);
      return entry;
    },
    sweep(at = now()) {
      return sweepInternal(at);
    },
    size() {
      return pending.size;
    },
  };
}
