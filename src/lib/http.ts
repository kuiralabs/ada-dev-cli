// The single place an HTTP request leaves this tool.
//
// Centralised so timeouts, error classification and URL composition are decided
// once. Commands pass an endpoint from constants.ts and never build a URL.

import { LOCAL_HTTP_TIMEOUT_MS } from './constants.ts';
import { networkError, notRunningError, AdaError } from './errors.ts';

export interface GetOptions {
  timeoutMs?: number;
  /** When true, a connection refused is reported as "devnet not running" with a
   *  hint to start it, rather than as a generic network failure. */
  local?: boolean;
}

export async function getJson<T>(
  baseUrl: string,
  endpoint: string,
  opts: GetOptions = {},
): Promise<T> {
  const url = `${baseUrl}${endpoint}`;
  const timeoutMs = opts.timeoutMs ?? LOCAL_HTTP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });

    if (!res.ok) {
      throw networkError(
        `${res.status} ${res.statusText} from ${url}`,
        res.status === 404
          ? 'the endpoint exists but returned not-found — check the API base URL'
          : undefined,
      );
    }

    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof AdaError) throw err;
    throw classify(err, url, opts.local === true, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
}

/** Liveness probe. Returns false rather than throwing, so callers can poll. */
export async function isReachable(
  baseUrl: string,
  endpoint: string,
  timeoutMs = LOCAL_HTTP_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${endpoint}`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function classify(err: unknown, url: string, local: boolean, timeoutMs: number): AdaError {
  const message = err instanceof Error ? err.message : String(err);
  const aborted = err instanceof Error && err.name === 'AbortError';

  if (aborted) {
    return local
      ? notRunningError(
          `no response from ${url} within ${timeoutMs}ms`,
          'the devnet may still be starting — check: ada localnet status',
        )
      : networkError(`request to ${url} timed out after ${timeoutMs}ms`);
  }

  const refused = /ECONNREFUSED|fetch failed|other side closed/i.test(message);
  if (refused && local) {
    return notRunningError(
      `cannot reach the devnet at ${url}`,
      'start it with: ada localnet up',
    );
  }

  return networkError(`${message} (${url})`);
}
