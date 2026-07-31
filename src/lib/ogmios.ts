// Ogmios — consumed when it is there, never required.
//
// Ogmios is a bridge to a running cardano-node, and it answers two questions
// nothing else here can:
//
//   - **What does the node think this script costs?** Our own answer comes from a
//     Plutus VM reimplemented in JavaScript. The node's comes from the
//     implementation that will actually judge the transaction. Two independent
//     answers to the same question is the oracle property this tool is built on,
//     and a disagreement is information worth having.
//   - **Was my transaction accepted?** Between submitting and a block appearing
//     there is currently no way to tell "waiting" from "silently rejected".
//
// It is not installed and not managed here. Running a second daemon is the
// devkit's job, exactly as running a node is, and a tool that quietly requires
// one has stopped being zero-config. Detection only.

import { AdaError } from './errors.ts';
import { EXIT_NETWORK } from './exit-codes.ts';
import type { ResolvedNetwork } from './cli-config.ts';

/** The port the devkit's own generated launcher uses. */
export const DEFAULT_OGMIOS_URL = 'http://localhost:1337';

/**
 * Where to look, if anywhere.
 *
 * `ADA_OGMIOS_URL` is explicit and wins — the same shape as `ADA_BLOCKFROST_KEY`,
 * because a credential or an endpoint belongs in the environment rather than on a
 * command line that lands in shell history. Failing that, a local devnet is worth
 * probing on the devkit's default port, since if it is running at all it is there.
 * A public network is never probed: guessing at localhost for preprod would be
 * asking a question about the wrong machine.
 */
export function ogmiosUrl(network: ResolvedNetwork): string | undefined {
  const explicit = process.env.ADA_OGMIOS_URL?.trim();
  if (explicit) return explicit;
  return network.isLocal ? DEFAULT_OGMIOS_URL : undefined;
}

export interface OgmiosStatus {
  url?: string;
  reachable: boolean;
  version?: string;
  /** Why not, when not — so "absent" is never confused with "broken". */
  reason?: string;
}

/** Is anything answering, and what is it? */
export async function probeOgmios(network: ResolvedNetwork, timeoutMs = 2_500): Promise<OgmiosStatus> {
  const url = ogmiosUrl(network);
  if (!url) {
    return { reachable: false, reason: 'not configured — set ADA_OGMIOS_URL to use one' };
  }

  try {
    // Probe with the protocol we are going to use, not with /health.
    //
    // A standalone Ogmios serves JSON at /health, but a hosted one behind a web
    // front end can answer the same path with an HTML page and a 200 — Koios
    // does — so parsing that as JSON reports "unreachable" for something that
    // works perfectly. Asking for the tip over JSON-RPC proves the thing we
    // actually depend on, and cannot be satisfied by a landing page.
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'queryNetwork/tip' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { url, reachable: false, reason: `answered ${res.status}` };

    const text = await res.text();
    let body: { result?: unknown; error?: { message?: string } };
    try {
      body = JSON.parse(text);
    } catch {
      return { url, reachable: false, reason: 'answered with something that is not JSON-RPC' };
    }
    if (body.error) return { url, reachable: false, reason: body.error.message ?? 'rpc error' };
    if (body.result === undefined) return { url, reachable: false, reason: 'no result for queryNetwork/tip' };

    return { url, reachable: true };
  } catch (err) {
    const message = (err as Error).name === 'TimeoutError'
      ? 'no answer within the probe timeout'
      : (err as Error).message;
    return { url, reachable: false, reason: message };
  }
}

export interface OgmiosBudget {
  validator: string;
  mem: number;
  steps: number;
}

/**
 * Ask the node to evaluate a transaction.
 *
 * JSON-RPC over HTTP, the shape Ogmios has used since v6. Errors are returned
 * rather than thrown for the caller to fold into a comparison, because this is a
 * second opinion — the absence of one must never fail an operation that already
 * has a first.
 */
export async function evaluateWithOgmios(
  url: string,
  txCbor: string,
  timeoutMs = 20_000,
): Promise<{ budgets?: OgmiosBudget[]; error?: string }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'evaluateTransaction',
        params: { transaction: { cbor: txCbor } },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const body = await res.json() as {
      result?: { validator: unknown; budget: { memory: number; cpu: number } }[];
      error?: { message?: string; data?: unknown };
    };

    if (body.error) {
      return { error: body.error.message ?? JSON.stringify(body.error).slice(0, 200) };
    }
    if (!Array.isArray(body.result)) return { error: 'no result in the response' };

    return {
      budgets: body.result.map((r) => ({
        validator: typeof r.validator === 'string'
          ? r.validator
          : `${(r.validator as { purpose?: string })?.purpose ?? 'script'}`,
        mem: Number(r.budget?.memory ?? 0),
        steps: Number(r.budget?.cpu ?? 0),
      })),
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** For a caller that genuinely needs it and should say so plainly. */
export function required(status: OgmiosStatus): never {
  throw new AdaError('ogmios_unavailable',
    `no Ogmios at ${status.url ?? '(unconfigured)'}: ${status.reason ?? 'unreachable'}`,
    EXIT_NETWORK,
    'set ADA_OGMIOS_URL, or run one against your node — the devkit generates an ogmios.sh launcher, '
    + 'though its native distribution does not install the binary');
}
