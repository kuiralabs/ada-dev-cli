// Replacing a file without ever leaving a half-written one.
//
// Write to a temporary file and rename over the target: rename is atomic within
// a filesystem, so a reader sees either the old contents or the new ones and
// never a truncation. A zero-byte config has bricked this tool before, and a
// wallet file with no mnemonic is worse.
//
// **The temporary name has to be unique.** Both places that did this used
// `${path}.tmp`, which is fine for one writer and wrong for two: each writes the
// same temporary file, the first rename consumes it, and the second fails with
// `ENOENT ... rename alice.json.tmp -> alice.json`. Found by running three chain
// suites at once, and it is not a test artefact — every command that opens a
// wallet rewrites it to cache the derived address, so two ordinary `ada`
// invocations at the same time are enough.

import { writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * Write `contents` to `path`, atomically.
 *
 * The temporary file sits beside the target rather than in the system temp
 * directory, because rename is only atomic within one filesystem and those are
 * often different mounts.
 */
export function writeFileAtomic(path: string, contents: string, mode: number): void {
  // pid distinguishes processes, the random suffix distinguishes writes within
  // one — a command may save the same file twice, and two async writers in one
  // process would otherwise collide exactly as two processes did.
  const tmp = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;

  try {
    writeFileSync(tmp, contents, { mode });
    renameSync(tmp, path);
  } catch (err) {
    // A failed write must not leave litter behind. With a unique name there is
    // no chance of removing somebody else's file.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // Nothing useful to do, and the original error is the one worth raising.
    }
    throw err;
  }
}
