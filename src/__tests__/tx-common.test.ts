// Shared transaction logic, and the two review findings it exists to fix.
//
// Both were behavioural bugs found by exploratory testing rather than by the
// suite, which is the point of doing both.

import { describe, it, expect } from 'vitest';
import {
  assertMeetsMinValue, noUtxosError, translateBuildFailure, assertRecipient,
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

describe('checking a recipient before sending value to it', () => {
  const GOOD = 'addr_test1qpf8cud6excflj787pgkfe0vlkpj5x7tz2fgsdtak69033dmha29vf5ajuhcslaaru44844juzssnkds30r300zwee4qkdrx2v';

  it('accepts a real address', () => {
    expect(() => assertRecipient(GOOD, { network: 'devnet' })).not.toThrow();
  });

  it('rejects a truncated paste as bad input, not as our fault', () => {
    // Every command that took a recipient checked the `addr` prefix and no
    // more, so this reached the transaction builder and came back as
    // `internal_error` — the tool blaming itself for a typo.
    try {
      assertRecipient('addr_test1qpf8cud6exc', { network: 'devnet' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AdaError).code).toBe('invalid_args');
      expect((err as AdaError).hint).toMatch(/truncated copy-paste/);
    }
  });

  it('rejects a corrupted checksum', () => {
    // One character changed from GOOD: decodes structurally, fails the checksum.
    expect(() => assertRecipient(`${GOOD.slice(0, -1)}w`, { network: 'devnet' }))
      .toThrow(/could not decode/);
  });

  it('rejects something that is not an address at all', () => {
    expect(() => assertRecipient('hello', { network: 'devnet' })).toThrow(/not a Cardano address/);
    expect(() => assertRecipient('', { network: 'devnet' })).toThrow(/not a Cardano address/);
  });

  it('names the network mistake before the checksum one', () => {
    // A mainnet address decodes perfectly, so a checksum-first order would pass
    // its own check and leave the real mistake unmentioned.
    expect(() => assertRecipient('addr1qxck4gg9x8xtvp9lsjmg8k5c8m2tqjy0kg8xqfnj7v0wl0', { network: 'preprod' }))
      .toThrow(/mainnet address/);
  });

  it('still checks the checksum when no network is supplied', () => {
    // Callers that validate before resolving a network still get the decode.
    expect(() => assertRecipient('addr_test1qpf8cud6exc')).toThrow(/could not decode/);
  });

  it("uses the caller's own words for what was expected", () => {
    expect(() => assertRecipient('nonsense', { what: 'not a counterparty address' }))
      .toThrow(/not a counterparty address/);
  });
});
