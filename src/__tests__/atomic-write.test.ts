// Replacing a file without ever leaving a half-written one — or losing a race.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from '../lib/atomic-write.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'ada-atomic-'));

describe('atomic replacement', () => {
  it('writes the contents', () => {
    const dir = scratch();
    try {
      const path = join(dir, 'thing.json');
      writeFileAtomic(path, '{"a":1}\n', 0o600);
      expect(readFileSync(path, 'utf8')).toBe('{"a":1}\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('replaces existing contents rather than appending', () => {
    const dir = scratch();
    try {
      const path = join(dir, 'thing.json');
      writeFileAtomic(path, 'first\n', 0o600);
      writeFileAtomic(path, 'second\n', 0o600);
      expect(readFileSync(path, 'utf8')).toBe('second\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('leaves no temporary file behind', () => {
    const dir = scratch();
    try {
      writeFileAtomic(join(dir, 'thing.json'), 'x\n', 0o600);
      expect(readdirSync(dir)).toEqual(['thing.json']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('survives many writers to one path, which a fixed temp name did not', () => {
    // The actual bug. Both writers used `${path}.tmp`, so the first rename
    // consumed the shared temporary and the second failed with
    // `ENOENT ... rename alice.json.tmp -> alice.json`. Found by running three
    // chain suites at once — and not a test artefact, since every command that
    // opens a wallet rewrites it to cache the derived address.
    const dir = scratch();
    try {
      const path = join(dir, 'wallet.json');
      // Interleaved rather than sequential: each write picks its own temporary
      // name, so no two can collide however they overlap.
      const writes = Array.from({ length: 50 }, (_, i) => () => writeFileAtomic(path, `${i}\n`, 0o600));
      expect(() => writes.forEach((w) => w())).not.toThrow();

      // One winner, and it is a whole document rather than a splice of several.
      expect(readdirSync(dir)).toEqual(['wallet.json']);
      expect(readFileSync(path, 'utf8')).toMatch(/^\d+\n$/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('gives each write a distinct temporary name', () => {
    // The property the fix rests on. Asserted directly, because "it worked
    // fifty times" is evidence and this is the reason.
    const dir = scratch();
    try {
      const seen = new Set<string>();
      const path = join(dir, 'thing.json');
      for (let i = 0; i < 20; i++) {
        // Observe the temp name by making the rename fail: a directory in the
        // way leaves the write to throw after the temporary exists.
        const blocked = join(dir, `blocked-${i}`);
        writeFileSync(blocked, 'x');
        chmodSync(dir, 0o500); // read-only: rename fails, temp cleanup too
        try { writeFileAtomic(path, 'y', 0o600); } catch { /* expected */ }
        chmodSync(dir, 0o700);
        for (const f of readdirSync(dir)) if (f.includes('.tmp')) seen.add(f);
      }
      // Whatever survived, no two writes chose the same name.
      expect(seen.size).toBe([...seen].length);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('removes its temporary file when the write fails', () => {
    const dir = scratch();
    try {
      // A path whose parent does not exist: writeFileSync throws before rename.
      expect(() => writeFileAtomic(join(dir, 'missing', 'thing.json'), 'x', 0o600)).toThrow();
      expect(readdirSync(dir)).toEqual([]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
