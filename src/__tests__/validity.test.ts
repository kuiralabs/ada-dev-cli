// Validity windows, reference inputs and extra signers.
//
// Three capabilities a contract surface cannot express without: a deadline
// validator reads the transaction's validity range, an oracle pattern reads a
// UTxO without spending it, and a multi-party validator checks for signatures
// beyond the one paying.

import { describe, it, expect } from 'vitest';
import {
  parseDuration, resolveValidity, assertValidityShape, parseOutputRefs, parseSigners,
} from '../lib/validity.ts';
import { translateHorizon, translateSubmitFailure } from '../lib/tx-common.ts';
import { AdaError } from '../lib/errors.ts';

const HASH = 'a'.repeat(64);
const KEY = 'b'.repeat(56);

describe('durations', () => {
  it('reads the units people actually write', () => {
    expect(parseDuration('90s')).toBe(90);
    expect(parseDuration('15m')).toBe(900);
    expect(parseDuration('2h')).toBe(7200);
    expect(parseDuration('1d')).toBe(86_400);
  });

  it('treats a bare number as seconds', () => {
    expect(parseDuration('45')).toBe(45);
  });

  it('rejects something that is not a duration', () => {
    expect(() => parseDuration('soon')).toThrow(/not a duration/);
    expect(() => parseDuration('1w')).toThrow(/not a duration/);
  });
});

describe('the window is anchored to the chain, not the clock', () => {
  it('measures a duration from the tip slot', () => {
    // A window derived from the local clock is one the chain may disagree with:
    // a machine seconds fast produces a transaction not yet valid, one seconds
    // slow produces an expired one, and both fail looking like anything but a
    // clock.
    expect(resolveValidity({ forDuration: '1h' }, 1000).invalidHereafter).toBe(1000 + 3600);
    expect(resolveValidity({ forDuration: '1h' }, 50_000).invalidHereafter).toBe(50_000 + 3600);
  });

  it('reads `now` as the tip', () => {
    expect(resolveValidity({ from: 'now' }, 777).invalidBefore).toBe(777);
  });

  it('takes an absolute slot unchanged', () => {
    const w = resolveValidity({ from: '100', until: '200' }, 999);
    expect(w).toEqual({ invalidBefore: 100, invalidHereafter: 200 });
  });

  it('refuses a window that ends before it starts', () => {
    expect(() => resolveValidity({ from: '500', until: '400' }, 0))
      .toThrow(/ends at slot 400 but starts at 500/);
  });

  it('refuses a window of zero length, which can never be submitted', () => {
    expect(() => resolveValidity({ from: '500', until: '500' }, 0)).toThrow(AdaError);
  });

  it('refuses two conflicting end bounds', () => {
    expect(() => resolveValidity({ until: '900', forDuration: '1h' }, 0))
      .toThrow(/both set an end/);
  });
});

describe('shape checks do not need a chain', () => {
  // The slot arithmetic needs the tip, but a misspelled duration does not — and
  // a network round trip is a slow, confusing way to be told about a typo.
  it('catches a bad duration without a tip', () => {
    expect(() => assertValidityShape({ forDuration: 'soon' })).toThrow(/not a duration/);
  });

  it('catches conflicting bounds without a tip', () => {
    expect(() => assertValidityShape({ until: '5', forDuration: '1h' })).toThrow(/both set an end/);
  });

  it('catches a non-slot without a tip', () => {
    expect(() => assertValidityShape({ from: 'tomorrow' })).toThrow(/slot number/);
  });

  it('allows `now`, which the tip resolves later', () => {
    expect(() => assertValidityShape({ from: 'now' })).not.toThrow();
  });
});

describe('reference inputs', () => {
  it('reads one and several', () => {
    expect(parseOutputRefs(`${HASH}#0`, '--read-only')).toEqual([{ txHash: HASH, index: 0 }]);
    expect(parseOutputRefs(`${HASH}#0, ${HASH}#3`, '--read-only')).toHaveLength(2);
  });

  it('rejects a reference that is not one', () => {
    expect(() => parseOutputRefs('notahash#0', '--read-only')).toThrow(/is not a UTxO reference/);
    expect(() => parseOutputRefs(`${HASH}`, '--read-only')).toThrow(/is not a UTxO reference/);
  });

  it('lower-cases the hash so two spellings do not read as two inputs', () => {
    expect(parseOutputRefs(`${'A'.repeat(64)}#1`, '--read-only')[0].txHash).toBe('a'.repeat(64));
  });

  it('treats an absent flag as none', () => {
    expect(parseOutputRefs(undefined, '--read-only')).toEqual([]);
  });
});

describe('extra signers', () => {
  it('accepts a public-key hash', () => {
    expect(parseSigners(KEY)).toEqual([KEY]);
  });

  it('rejects anything that is not one, saying where to find one', () => {
    const err = (() => { try { parseSigners('abc'); return undefined; } catch (e) { return e as AdaError; } })();
    expect(err?.message).toMatch(/is not a public-key hash/);
    expect(err?.hint).toMatch(/address inspect/);
  });

  it('rejects a full address, the likely mistake', () => {
    expect(() => parseSigners('addr_test1qpf8cud6excflj787pgkfe0vlkpj5x7tz2fgs')).toThrow();
  });
});

describe('chain rejections are made readable', () => {
  const PAST_HORIZON = 'TimeTranslationPastHorizon "PastHorizon {pastHorizonCallStack = ... '
    + '(ELit (SlotNo 29439)) ... eraSlotLength = SlotLength 1s ...}"';

  it('names the slot that could not be placed in time', () => {
    // The raw rejection is several thousand characters of Haskell source
    // locations, and the only useful word in it is "PastHorizon".
    const e = translateHorizon(PAST_HORIZON)!;
    expect(e.code).toBe('validity_past_horizon');
    expect(e.message).toContain('29439');
    expect(e.hint).toMatch(/shorten the window/);
  });

  it('leaves unrelated failures alone', () => {
    expect(translateHorizon('ValueNotConservedUTxO')).toBeUndefined();
  });

  it('routes a horizon failure through the submit path too', () => {
    // The failure happens at submit, not at build, so translating only build
    // errors left the wall of text intact.
    expect(translateSubmitFailure(new Error(PAST_HORIZON)).code).toBe('validity_past_horizon');
  });

  it('truncates a rejection it does not recognise, rather than flooding output', () => {
    // Bad for a person, worse for an agent whose context it fills.
    const huge = new Error('x'.repeat(5000));
    const out = translateSubmitFailure(huge);
    expect(out.message.length).toBeLessThan(600);
    expect(out.message).toContain('truncated');
  });

  it('leaves a short rejection intact', () => {
    expect(translateSubmitFailure(new Error('ValueNotConservedUTxO')).message)
      .toContain('ValueNotConservedUTxO');
  });
});

describe('cost models are validated, not trusted', () => {
  // The two providers disagree. Yaci keys them by parameter name and the counts
  // match the ledger; Koios keys them by numeric index and reports 332 for
  // PlutusV1, which the ledger fixes at 166. A wrong cost model does not fail
  // loudly — it produces a wrong execution budget, meaning either an overpaid fee
  // or a script that aborts mid-run and forfeits its collateral.
  it('knows the counts the ledger fixes', async () => {
    const { EXPECTED_COST_MODEL_SIZES } = await import('../lib/mesh.ts') as any;
    // Confirmed against the devnet's own Alonzo genesis.
    expect(EXPECTED_COST_MODEL_SIZES[0]).toContain(166);
    expect(EXPECTED_COST_MODEL_SIZES[1]).toContain(175);
    expect(EXPECTED_COST_MODEL_SIZES[2]).toContain(297);
  });
});
