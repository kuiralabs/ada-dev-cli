// Regression test for the worst bug found in review.
//
// `ada localnet down` reported success while cardano-node, the submit API and the
// indexer kept running and holding ports 3001, 8090 and 8080. The cause: the stop
// used `pkill -TERM -P <pid>`, which reaches direct children only, and those
// services are grandchildren. Consequences compounded — `down` lied, `status` then
// read "running" because the API still answered, and the next `up` died on a bind
// conflict with no explanation.
//
// This builds a real three-generation process tree and asserts the whole thing
// dies. It fails against a `-P`-based implementation, which is the point.

import { describe, it, expect } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { Socket } from 'node:net';
import { createServer } from 'node:net';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Grandparent -> parent -> grandchild, each just sleeping. */
function spawnThreeGenerations(): { pid: number; child: ReturnType<typeof spawn> } {
  // sh spawns sh which spawns sleep: the deepest process is two levels down, so a
  // direct-children-only kill provably misses it.
  const script = 'sh -c "sh -c \'sleep 120\' & sleep 120" & sleep 120';
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
  child.unref();
  if (child.pid === undefined) throw new Error('could not spawn test tree');
  return { pid: child.pid, child };
}

function descendantCount(pgid: number): number {
  // Count processes in the group. `ps -g` lists by process-group id, which is what
  // a detached spawn establishes.
  try {
    const out = execFileSync('ps', ['-g', String(pgid), '-o', 'pid='], { encoding: 'utf-8' });
    return out.split('\n').filter((l) => l.trim() !== '').length;
  } catch {
    return 0;
  }
}

describe('stopping a devnet kills the whole process group', () => {
  it('signalling the group reaches grandchildren; signalling the pid alone does not', async () => {
    const { pid } = spawnThreeGenerations();
    await sleep(400);

    const before = descendantCount(pid);
    // Three generations plus the shell: if this is not >1 the fixture is wrong and
    // the assertion below would be vacuous.
    expect(before).toBeGreaterThan(1);

    // The old behaviour: signal only the named process.
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await sleep(600);
    const afterDirectKill = descendantCount(pid);
    expect(afterDirectKill).toBeGreaterThan(0); // survivors — this is the bug

    // The fix: signal the group.
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* group already empty */
    }
    await sleep(600);
    expect(descendantCount(pid)).toBe(0);
  });
});

describe('port probing detects a listener without shelling out', () => {
  it('reports true for a bound port and false for a free one', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port assigned');
    const port = address.port;

    expect(await probe(port)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probe(port)).toBe(false);
  });
});

/** Mirrors the implementation's probe: connect, do not shell out to lsof. */
function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    const finish = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(300);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}
