// A second opinion on a script hash, from the reference implementation.
//
// Our hash comes from MeshJS. Aiken's comes from its own compiler. `cardano-cli`
// is the Haskell implementation the ledger itself is built from, so agreement
// across all three is the strongest evidence available that a script address is
// right — and disagreement is the signal that matters, because an address that
// is confidently wrong strands funds where nobody can reach them.
//
// This is the same oracle argument that chose this tool's stack: a reference
// built from the code under test can only confirm that code's own bugs.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlutusVersion } from './blueprint.ts';

const BIN = 'cardano-cli';

/** `ADA_CARDANO_CLI` wins, so a specific build can be pinned. */
export function resolveCardanoCliBin(): string {
  return process.env.ADA_CARDANO_CLI ?? BIN;
}

export function cardanoCliVersion(): string | undefined {
  const r = spawnSync(resolveCardanoCliBin(), ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) return undefined;
  return (r.stdout || '').split('\n')[0]?.trim();
}

export interface CrossCheck {
  /** Whether cardano-cli was available to ask at all. */
  available: boolean;
  version?: string;
  /** The hash it computed, when it could. */
  hash?: string;
  agrees?: boolean;
  /** Why no answer, when there is none. */
  unavailable?: string;
}

/**
 * Ask `cardano-cli` for the hash of the same script.
 *
 * The text envelope is written here rather than obtained from
 * `aiken blueprint convert`, because that command needs a project directory
 * while this tool only needs a blueprint — and because the bytes we hand it are
 * then unambiguously *our* bytes. If we wrote the envelope from someone else's
 * output the comparison would prove less.
 */
export function crossCheckScriptHash(
  scriptCbor: string,
  version: PlutusVersion,
  expectedHash: string,
): CrossCheck {
  const cliVersion = cardanoCliVersion();
  if (!cliVersion) {
    return {
      available: false,
      unavailable: 'cardano-cli is not installed or not runnable',
    };
  }

  const dir = mkdtempSync(join(tmpdir(), 'ada-xcheck-'));
  const file = join(dir, 'script.plutus');
  try {
    writeFileSync(file, JSON.stringify({
      type: `PlutusScript${version}`,
      description: 'written by ada for cross-checking',
      cborHex: scriptCbor,
    }));

    // `policyid` computes the script hash. For a minting policy that hash *is*
    // the policy id, and for a spending validator it is the address's payment
    // credential — one number, two names.
    const r = spawnSync(resolveCardanoCliBin(),
      ['conway', 'transaction', 'policyid', '--script-file', file],
      { encoding: 'utf8' });

    if (r.status !== 0) {
      return {
        available: true,
        version: cliVersion,
        unavailable: (r.stderr || '').trim().split('\n')[0] || 'cardano-cli returned a non-zero status',
      };
    }

    const hash = (r.stdout || '').trim();
    return { available: true, version: cliVersion, hash, agrees: hash === expectedHash };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
