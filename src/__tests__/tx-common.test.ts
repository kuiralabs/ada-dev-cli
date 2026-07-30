// Shared transaction logic, and the two review findings it exists to fix.
//
// Both were behavioural bugs found by exploratory testing rather than by the
// suite, which is the point of doing both.

import { describe, it, expect } from 'vitest';
import {
  assertMeetsMinValue, noUtxosError, translateBuildFailure,
} from '../lib/tx-common.ts';
import { AdaError } from '../lib/errors.ts';
import { LOVELACE_UNIT } from '../lib/amount.ts';

const ADDRESS =
  'addr_test1qqgz34ypl2c5sd0gfpf3xlajwnz6ywyh72esan8pms8r4f7an4hl4wdl9n8j55aum05zs40hnzzru5vrhyxklsmauhrqvhvrsr';
const COINS_PER_UTXO_SIZE = 4310;

const ada = (n: string) => [{ unit: LOVELACE_UNIT, quantity: n }];

describe('minimum-value enforcement', () => {
  // The bug: sending one lovelace built cleanly and the dry run reported ok:true.
  // The chain then refused it on submit. A dry run that approves an impossible
  // transaction is worse than no dry run, because it is trusted.
  it('rejects an output below the ledger minimum', () => {
    expect(() => assertMeetsMinValue(ADDRESS, ada('1'), COINS_PER_UTXO_SIZE))
      .toThrowError(AdaError);
  });

  it('names the actual floor rather than a vague complaint', () => {
    try {
      assertMeetsMinValue(ADDRESS, ada('1'), COINS_PER_UTXO_SIZE);
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as AdaError;
      expect(e.code).toBe('output_below_min_value');
      // The number has to be in there — "too small" is not actionable.
      expect(e.message).toMatch(/0\.9\d+ ADA/);
      expect(e.hint).toMatch(/send at least/);
    }
  });

  it('accepts an output at or above the floor', () => {
    expect(() => assertMeetsMinValue(ADDRESS, ada('2000000'), COINS_PER_UTXO_SIZE)).not.toThrow();
  });

  it('requires more for an output carrying assets than a plain one', () => {
    // The floor depends on serialized size, which is why it is computed rather
    // than hardcoded to the commonly-quoted ~1 ADA.
    const withAsset = [
      { unit: LOVELACE_UNIT, quantity: '1000000' },
      { unit: `${'a'.repeat(56)}53696c6b`, quantity: '10' },
    ];
    expect(() => assertMeetsMinValue(ADDRESS, withAsset, COINS_PER_UTXO_SIZE)).toThrowError(AdaError);
    // …and the same output with enough ADA passes.
    const funded = [{ ...withAsset[0], quantity: '2000000' }, withAsset[1]];
    expect(() => assertMeetsMinValue(ADDRESS, funded, COINS_PER_UTXO_SIZE)).not.toThrow();
  });
});

describe('builder failure translation', () => {
  // One set of patterns, not one per command. Two copies drifted apart already:
  // when the library rewords a message, the copy nobody edited degrades silently
  // to a generic build_failed.
  it('classifies insufficient funds', () => {
    for (const msg of ['UTxO Balance Insufficient', 'not enough funds', 'Insufficient input']) {
      expect(translateBuildFailure(new Error(msg), { what: 'transfer' }).code, msg)
        .toBe('insufficient_funds');
    }
  });

  it('classifies a sub-minimum output', () => {
    for (const msg of ['output too small', 'minimum UTxO value not met', 'min-ada violated']) {
      expect(translateBuildFailure(new Error(msg), { what: 'transfer' }).code, msg)
        .toBe('output_below_min_value');
    }
  });

  it('falls back to build_failed rather than guessing', () => {
    expect(translateBuildFailure(new Error('something novel'), { what: 'mint' }).code)
      .toBe('build_failed');
  });

  it('carries a caller-supplied detail into the message', () => {
    const e = translateBuildFailure(new Error('not enough'), {
      what: 'transfer', detail: 'cannot cover 5 ADA from 1 ADA available',
    });
    expect(e.message).toBe('cannot cover 5 ADA from 1 ADA available');
  });

  it('lets a caller give a context-specific min-value hint', () => {
    const e = translateBuildFailure(new Error('too small'), {
      what: 'asset transfer', minValueHint: 'assets need more ADA attached',
    });
    expect(e.hint).toBe('assets need more ADA attached');
  });

  it('handles a non-Error throw without losing the reason', () => {
    expect(translateBuildFailure('plain string failure', { what: 'mint' }).message)
      .toMatch(/plain string failure/);
  });
});

describe('noUtxosError', () => {
  it('names the wallet and the fix', () => {
    const e = noUtxosError('alice');
    expect(e.code).toBe('no_utxos');
    expect(e.message).toMatch(/alice/);
    expect(e.hint).toMatch(/ada airdrop/);
  });
});
