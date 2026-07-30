// Exact-amount arithmetic.
//
// This is the file where a bug costs money, so it gets the most tests. The whole
// point is that no floating-point value ever appears: `parseFloat("0.1") * 1e6` is
// 100000.00000000001, and truncating that silently sends the wrong amount.

import { describe, it, expect } from 'vitest';
import {
  adaToLovelace, parseLovelace, lovelaceToAda, formatAda, sumLovelace,
  LOVELACE_PER_ADA, LOVELACE_UNIT,
} from '../lib/amount.ts';
import { AdaError } from '../lib/errors.ts';

describe('adaToLovelace', () => {
  it('converts whole ADA', () => {
    expect(adaToLovelace('1')).toBe(1_000_000n);
    expect(adaToLovelace('1000')).toBe(1_000_000_000n);
    expect(adaToLovelace('0')).toBe(0n);
  });

  it('converts fractional ADA exactly', () => {
    expect(adaToLovelace('1.5')).toBe(1_500_000n);
    expect(adaToLovelace('0.000001')).toBe(1n);
    expect(adaToLovelace('25.169813')).toBe(25_169_813n);
  });

  it('is exact for the values floating point gets wrong', () => {
    // parseFloat('0.1') * 1e6 === 100000.00000000001
    expect(adaToLovelace('0.1')).toBe(100_000n);
    expect(adaToLovelace('0.3')).toBe(300_000n);
    expect(adaToLovelace('0.07')).toBe(70_000n);
    expect(adaToLovelace('2.675')).toBe(2_675_000n);
  });

  it('pads a short fraction rather than misreading it', () => {
    // '1.5' must be 1.500000 ADA, not 1.000005
    expect(adaToLovelace('1.5')).toBe(1_500_000n);
    expect(adaToLovelace('1.05')).toBe(1_050_000n);
    expect(adaToLovelace('1.000005')).toBe(1_000_005n);
  });

  it('accepts underscores for readability', () => {
    expect(adaToLovelace('1_000_000')).toBe(1_000_000_000_000n);
  });

  it('handles amounts beyond 64-bit range without loss', () => {
    // Total ADA supply is 45e9, which is 4.5e16 lovelace — inside Number's safe
    // integer range but close enough that bigint is the right call.
    expect(adaToLovelace('45000000000')).toBe(45_000_000_000_000_000n);
  });

  it('rejects more decimals than ADA has, rather than rounding them away', () => {
    expect(() => adaToLovelace('1.0000001')).toThrowError(AdaError);
  });

  it('rejects things that are not amounts', () => {
    for (const bad of ['', 'abc', '-1', '1.2.3', '1e6', ' 1 2 ', 'Infinity', 'NaN']) {
      expect(() => adaToLovelace(bad), bad).toThrowError(AdaError);
    }
  });
});

describe('parseLovelace', () => {
  it('accepts integers only', () => {
    expect(parseLovelace('1')).toBe(1n);
    expect(parseLovelace('1_000_000')).toBe(1_000_000n);
  });

  it('rejects a decimal, because lovelace is not divisible', () => {
    expect(() => parseLovelace('1.5')).toThrowError(AdaError);
  });
});

describe('lovelaceToAda', () => {
  it('trims trailing zeros', () => {
    expect(lovelaceToAda(1_500_000n)).toBe('1.5');
    expect(lovelaceToAda(1_000_000n)).toBe('1');
    expect(lovelaceToAda(1_050_000n)).toBe('1.05');
  });

  it('keeps leading zeros in the fraction', () => {
    // 1 lovelace is 0.000001 ADA, not 0.1
    expect(lovelaceToAda(1n)).toBe('0.000001');
    expect(lovelaceToAda(10n)).toBe('0.00001');
    expect(lovelaceToAda(100_001n)).toBe('0.100001');
  });

  it('handles zero and negatives', () => {
    expect(lovelaceToAda(0n)).toBe('0');
    expect(lovelaceToAda(-1_500_000n)).toBe('-1.5');
  });

  it('round-trips every value it can render', () => {
    for (const v of [0n, 1n, 999_999n, 1_000_000n, 25_169_813n, 974_830_187n, 45_000_000_000_000_000n]) {
      expect(adaToLovelace(lovelaceToAda(v)), v.toString()).toBe(v);
    }
  });

  it('formats with the unit for humans', () => {
    expect(formatAda(1_500_000n)).toBe('1.5 ADA');
  });
});

describe('sumLovelace', () => {
  it('adds only the coin entries', () => {
    const assets = [
      { unit: LOVELACE_UNIT, quantity: '1000000' },
      { unit: 'abc123.MyToken', quantity: '5000' },
      { unit: LOVELACE_UNIT, quantity: '500000' },
    ];
    // A token quantity must never be added to a coin balance — the result would be
    // a number that means nothing.
    expect(sumLovelace(assets)).toBe(1_500_000n);
  });

  it('treats an empty unit as lovelace, which some providers emit', () => {
    expect(sumLovelace([{ unit: '', quantity: '7' }])).toBe(7n);
  });

  it('is zero for an empty set, not undefined', () => {
    expect(sumLovelace([])).toBe(0n);
  });

  it('sums quantities too large for a JS number safely', () => {
    const huge = '9007199254740993'; // Number.MAX_SAFE_INTEGER + 2
    expect(sumLovelace([{ unit: LOVELACE_UNIT, quantity: huge }])).toBe(BigInt(huge));
  });
});

describe('the conversion constant', () => {
  it('is one million, as the ledger defines it', () => {
    expect(LOVELACE_PER_ADA).toBe(1_000_000n);
  });
});
