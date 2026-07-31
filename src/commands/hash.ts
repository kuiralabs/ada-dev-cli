// Hashing, for the values that go inside a datum.
//
// A commit-reveal contract — a bounty, a sealed bid, a game with a hidden move —
// puts a hash on-chain and the preimage nowhere until someone spends. Writing one
// therefore needs blake2b-256 before any transaction exists, and that turned out
// to be the single primitive the toolchain did not offer: not in the Cardano
// libraries we depend on, and not in Node's crypto, which stops at blake2b-512.
//
// Both hash sizes Cardano uses are here. 224 bits is what a script or key hash
// is; 256 is what `blake2b_256` in a validator computes.

import { blake2b } from '@noble/hashes/blake2b';
import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { usageError } from '../lib/errors.ts';
import { writeJson } from '../lib/json-output.ts';
import { fields, heading } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

const SIZES: Record<string, number> = { 'blake2b-224': 28, 'blake2b-256': 32 };
const DEFAULT_ALGO = 'blake2b-256';

export default async function hash(args: Args): Promise<void> {
  const [value] = args.positionals;
  if (value === undefined) {
    throw usageError('hash needs a value', 'example: ada hash "a river"');
  }

  const algo = (flagValue(args, 'algo') ?? DEFAULT_ALGO).toLowerCase();
  const size = SIZES[algo];
  if (!size) {
    throw usageError(`unknown algorithm: ${algo}`, `one of: ${Object.keys(SIZES).join(', ')}`);
  }

  // A validator hashes **bytes**, and on-chain there are no strings — so text
  // must be hex-encoded before it is hashed, and hashing the characters of a hex
  // string instead of the bytes it denotes silently produces a different digest.
  // `--hex` says the input already is those bytes.
  const asHex = hasFlag(args, 'hex');
  const bytes = asHex ? fromHex(value) : Buffer.from(value, 'utf8');
  const digest = Buffer.from(blake2b(bytes, { dkLen: size })).toString('hex');

  if (hasFlag(args, 'json')) {
    writeJson({
      algorithm: algo,
      input: value,
      inputEncoding: asHex ? 'hex' : 'utf8',
      inputHex: Buffer.from(bytes).toString('hex'),
      hash: digest,
    });
    return;
  }

  process.stderr.write(heading('Hash') + '\n');
  process.stderr.write(fields([
    ['algorithm', algo],
    ['input', asHex ? `${value} (hex)` : `"${value}"`],
    ['as bytes', Buffer.from(bytes).toString('hex')],
  ]) + '\n');
  process.stderr.write('\n' + dim('  A validator hashes the bytes, so text is hashed as its UTF-8 encoding.') + '\n\n');

  process.stdout.write(digest + '\n');
}

function fromHex(value: string): Buffer {
  const clean = value.trim().toLowerCase().replace(/^0x/, '');
  if (!/^([0-9a-f]{2})*$/.test(clean)) {
    throw usageError(`--hex was given something that is not hex: ${value}`,
      'hex is pairs of 0-9 and a-f; drop --hex to hash the text itself');
  }
  return Buffer.from(clean, 'hex');
}
