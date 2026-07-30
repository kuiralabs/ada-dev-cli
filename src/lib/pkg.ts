// Version, read from the package manifest rather than duplicated in source —
// two places to bump is one place to forget.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

function readVersion(): string {
  // Walk up from this module until a package.json turns up. Works from src/
  // under tsx and from a bundled dist/ file alike.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf-8');
      const parsed = JSON.parse(raw) as { version?: string };
      if (parsed.version) return parsed.version;
    } catch {
      // keep walking
    }
    dir = dirname(dir);
  }
  return '0.0.0';
}

export const PKG_VERSION = readVersion();
export const PKG_NAME = 'ada-dev-cli';
