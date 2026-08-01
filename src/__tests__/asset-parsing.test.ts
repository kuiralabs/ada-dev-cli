// Asset argument parsing.
//
// Pure logic on the money path, so it is pinned rather than trusted. A quantity
// misread by a factor of ten mints ten times what was asked for, and an asset name
// that is silently truncated produces a token nobody can find again.

import { describe, it, expect } from 'vitest';
import { parseAssetSpec } from '../commands/swap.ts';
import { parseAssetPair, parseQuantity, assertAssetName, MAX_ASSET_NAME_BYTES } from '../commands/asset.ts';
import { AdaError } from '../lib/errors.ts';

describe('parseQuantity', () => {
  it('accepts whole numbers', () => {
    expect(parseQuantity('1')).toBe(1n);
    expect(parseQuantity('100')).toBe(100n);
  });

  it('accepts underscores for readability', () => {
    expect(parseQuantity('1_000_000')).toBe(1_000_000n);
  });

  it('handles quantities beyond a JS number', () => {
    const huge = '9007199254740993'; // MAX_SAFE_INTEGER + 2
    expect(parseQuantity(huge)).toBe(BigInt(huge));
  });

  it('rejects a decimal, because native assets are not divisible', () => {
    // The ledger has no fractional token. Accepting "1.5" and truncating would mint
    // a different amount than the one asked for.
    expect(() => parseQuantity('1.5')).toThrowError(AdaError);
  });

  it('rejects zero, negatives and nonsense', () => {
    for (const bad of ['0', '-1', '', 'abc', '1e6', '  ']) {
      expect(() => parseQuantity(bad), bad).toThrowError(AdaError);
    }
  });
});

describe('parseAssetPair', () => {
  const policy = 'a'.repeat(56);
  const unit = `${policy}53696c6b`; // policy + hex("Silk")

  it('splits unit from quantity', () => {
    expect(parseAssetPair(`${unit}:25`)).toEqual({ unit, quantity: 25n });
  });

  it('splits on the LAST colon, since a unit is hex and may not contain one', () => {
    // Defensive: splitting on the first colon would corrupt any unit that ever
    // gained a separator.
    expect(parseAssetPair(`${unit}:100`).unit).toBe(unit);
  });

  it('rejects a pair with no quantity', () => {
    expect(() => parseAssetPair(unit)).toThrowError(AdaError);
    expect(() => parseAssetPair(`${unit}:`)).toThrowError(AdaError);
  });

  it('rejects a pair with no unit', () => {
    expect(() => parseAssetPair(':25')).toThrowError(AdaError);
  });

  it('sends people to the right command for ADA', () => {
    // lovelace is an asset unit on this ledger, so the mistake is natural and the
    // error should name the command that does work.
    try {
      parseAssetPair('lovelace:1000');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as AdaError).message).toMatch(/ada transfer/);
    }
  });
});

describe('assertAssetName', () => {
  it('accepts ordinary names', () => {
    for (const n of ['Silk', 'a', 'Jade-2', 'x'.repeat(MAX_ASSET_NAME_BYTES)]) {
      expect(() => assertAssetName(n), n).not.toThrow();
    }
  });

  it('rejects an empty name', () => {
    expect(() => assertAssetName('')).toThrowError(AdaError);
  });

  it('rejects a name past the ledger cap', () => {
    expect(() => assertAssetName('x'.repeat(MAX_ASSET_NAME_BYTES + 1))).toThrowError(AdaError);
  });

  it('counts BYTES, not characters', () => {
    // A multi-byte character costs more than one byte on-chain. Counting characters
    // would let a name through that the ledger then rejects, or silently truncates.
    const emoji = '🐫'; // 4 bytes in UTF-8
    expect(() => assertAssetName(emoji.repeat(8))).not.toThrow();   // 32 bytes
    expect(() => assertAssetName(emoji.repeat(9))).toThrowError(AdaError); // 36 bytes
  });
});

describe('a unit given more than once', () => {
  const UNIT = '2b0f0c0a61f4525664aa2478e78358d67d783c58607e67540c521fe552414e44434f494e';

  it('is summed, because a Value is a map keyed by unit', () => {
    // `--give 5ADA,5ADA` produced an offer carrying two lovelace entries of five
    // million each. Not representable on the ledger — whichever layer noticed
    // first would drop one silently or fail somewhere unrelated to what was typed.
    const parsed = parseAssetSpec('5ADA,5ADA');
    expect(parsed).toHaveLength(1);
    expect(parsed[0].quantity).toBe('10000000');
  });

  it('sums a native asset the same way', () => {
    const parsed = parseAssetSpec(`${UNIT}:10,${UNIT}:5`);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].quantity).toBe('15');
  });

  it('leaves distinct units alone', () => {
    const parsed = parseAssetSpec(`5ADA,${UNIT}:3`);
    expect(parsed).toHaveLength(2);
    expect(parsed.find((a) => a.unit === 'lovelace')?.quantity).toBe('5000000');
    expect(parsed.find((a) => a.unit === UNIT)?.quantity).toBe('3');
  });

  it('handles quantities beyond a double', () => {
    const big = '9007199254740993';
    expect(parseAssetSpec(`${UNIT}:${big},${UNIT}:1`)[0].quantity).toBe('9007199254740994');
  });
});
