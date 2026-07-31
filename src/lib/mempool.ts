// Asking a node what is in its mempool.
//
// This is the one question neither the indexer nor offline evaluation can
// answer. Between submitting and a block appearing there is a gap where the only
// honest answer is "we do not know", and every wait in this tool has so far been
// a sleep followed by a hopeful re-query. A transaction that was accepted and one
// that was dropped look identical from outside: both are simply absent.
//
// **Why this cannot use the HTTP path the rest of the Ogmios code uses.** Mempool
// monitoring is a stateful mini-protocol: you acquire a snapshot, ask about it,
// and release it, and the snapshot belongs to the *connection*. Over HTTP POST
// each request is its own connection, so an acquire in one call is gone by the
// next — Ogmios answers "You must acquire a mempool snapshot prior to accessing
// it", which is exactly what it did when this was first tried. So: one WebSocket,
// opened for the question and closed after.

const ACQUIRE_TIMEOUT_MS = 8_000;

export type MempoolAnswer =
  | { available: true; present: boolean; slot?: number }
  /** Ogmios is not there, or would not answer. Never an error: this is optional. */
  | { available: false; reason: string };

/** `http(s)://host:port` → `ws(s)://host:port`, which is the same server. */
function websocketUrl(httpUrl: string): string {
  return httpUrl.replace(/^http/, 'ws');
}

/**
 * Is this transaction in the node's mempool right now?
 *
 * Returns rather than throws when Ogmios is absent. A second opinion must never
 * fail an operation that already has a first — the same rule `--verify-budget`
 * follows, and the reason both are safe to call unconditionally.
 */
export async function hasTransaction(ogmiosUrl: string, txHash: string): Promise<MempoolAnswer> {
  let socket: WebSocket | undefined;
  try {
    return await new Promise<MempoolAnswer>((resolve) => {
      const done = (answer: MempoolAnswer) => {
        try { socket?.close(); } catch { /* already closing */ }
        resolve(answer);
      };

      const timer = setTimeout(
        () => done({ available: false, reason: 'no answer within the timeout' }),
        ACQUIRE_TIMEOUT_MS,
      );

      socket = new WebSocket(websocketUrl(ogmiosUrl));
      let slot: number | undefined;

      socket.onerror = () => {
        clearTimeout(timer);
        done({ available: false, reason: 'could not open a websocket to Ogmios' });
      };

      socket.onopen = () => {
        // Acquire first: every other mempool method is meaningless without a
        // snapshot, and asking without one is the error this exists to avoid.
        socket!.send(JSON.stringify({ jsonrpc: '2.0', method: 'acquireMempool' }));
      };

      socket.onmessage = (event) => {
        let body: { method?: string; result?: unknown; error?: { message?: string } };
        try {
          body = JSON.parse(String(event.data));
        } catch {
          clearTimeout(timer);
          done({ available: false, reason: 'Ogmios sent something that is not JSON-RPC' });
          return;
        }

        if (body.error) {
          clearTimeout(timer);
          done({ available: false, reason: body.error.message ?? 'rpc error' });
          return;
        }

        if (body.method === 'acquireMempool') {
          slot = (body.result as { slot?: number })?.slot;
          socket!.send(JSON.stringify({
            jsonrpc: '2.0', method: 'hasTransaction', params: { id: txHash },
          }));
          return;
        }

        if (body.method === 'hasTransaction') {
          clearTimeout(timer);
          done({ available: true, present: body.result === true, slot });
        }
      };
    });
  } catch (err) {
    return { available: false, reason: (err as Error).message };
  }
}
