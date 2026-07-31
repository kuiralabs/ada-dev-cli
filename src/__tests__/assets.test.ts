// Asset units, taken apart.
//
// The tool built units and could not read them back, so a wallet that had just
// minted RANDCOIN reported it as 72 characters of hex — in human output and in
// JSON alike.

import { describe, it, expect } from 'vitest';
import {
  splitUnit, decodeAssetName, formatAsset, buildUnit, assetNameToHex, summariseAssets,
  POLICY_ID_HEX_LENGTH,
} from '../lib/assets.ts';

const POLICY = '2b0f0c0a61f4525664aa2478e78358d67d783c58607e67540c521fe5';
const RANDCOIN = `${POLICY}52414e44434f494e`;

describe('splitting a unit', () => {
  it('reads back the name the tool itself encoded', () => {
    // The exact unit `ada asset mint RANDCOIN` produced, shown as raw hex by
    // `ada balance` before this existed.
    const parts = splitUnit(RANDCOIN);
    expect(parts.policyId).toBe(POLICY);
    expect(parts.assetName).toBe('RANDCOIN');
    expect(parts.assetNameHex).toBe('52414e44434f494e');
  });

  it('round-trips against the encoder', () => {
    const unit = buildUnit(POLICY, assetNameToHex('Badge'));
    expect(splitUnit(unit).assetName).toBe('Badge');
  });

  it('splits at the policy-id boundary', () => {
    expect(POLICY).toHaveLength(POLICY_ID_HEX_LENGTH);
    expect(splitUnit(RANDCOIN).policyId).toHaveLength(POLICY_ID_HEX_LENGTH);
  });

  it('handles a nameless asset', () => {
    const parts = splitUnit(POLICY);
    expect(parts.policyId).toBe(POLICY);
    expect(parts.assetNameHex).toBe('');
    expect(parts.assetName).toBeUndefined();
  });

  it('does not mangle lovelace, which has no policy', () => {
    // It arrives through the same value maps, so a naive 56/rest split would
    // produce nonsense rather than an error.
    expect(splitUnit('lovelace')).toEqual({
      unit: 'lovelace', policyId: '', assetNameHex: '', assetName: 'lovelace',
    });
  });
});

describe('deciding whether a name is text', () => {
  it('decodes printable ASCII', () => {
    expect(decodeAssetName('52414e44434f494e')).toBe('RANDCOIN');
  });

  it('refuses a CIP-68 label prefix rather than rendering control codes', () => {
    // (222) reference NFT: four bytes of label, then the name. Decoding the
    // whole thing gives a string that looks like a name and is not one.
    expect(decodeAssetName('000de140' + assetNameToHex('MyNFT'))).toBeUndefined();
  });

  it('refuses arbitrary bytes', () => {
    expect(decodeAssetName('ff00ff00')).toBeUndefined();
  });

  it('refuses a hash used as a name', () => {
    expect(decodeAssetName('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')).toBeUndefined();
  });

  it('refuses odd-length and non-hex input rather than guessing', () => {
    expect(decodeAssetName('abc')).toBeUndefined();
    expect(decodeAssetName('nothex!!')).toBeUndefined();
  });

  it('treats an empty name as no name', () => {
    expect(decodeAssetName('')).toBeUndefined();
  });
});

describe('showing an asset to a person', () => {
  it('leads with the name and disambiguates by policy', () => {
    // Not hypothetical: one devnet wallet held two different `Badge` tokens
    // from two different policies, indistinguishable without this.
    const a = formatAsset(`${POLICY}4261646765`);
    const b = formatAsset(`3f2905ae69dacf27678f7c878b1b93b4d3de480c6cf54db15d3e2b98${'4261646765'}`);
    expect(a).toContain('Badge');
    expect(b).toContain('Badge');
    expect(a).not.toBe(b);
  });

  it('falls back to the full unit when the name is not text', () => {
    // Better to show something copyable than something invented.
    const unit = `${POLICY}ff00ff00`;
    expect(formatAsset(unit)).toBe(unit);
  });
});

describe('summarising a wallet\'s assets', () => {
  const POL_A = '2b0f0c0a61f4525664aa2478e78358d67d783c58607e67540c521fe5';
  const RAND = `${POL_A}52414e44434f494e`;

  it('sums an asset spread across several UTxOs', () => {
    // The bug: `ada balance <address>` flattens every UTxO's value, so an asset
    // held in three outputs was listed three times with partial quantities and
    // no total anywhere — while `ada balance --wallet <name>`, which asks the
    // wallet instead, showed one correct row. Same wallet, two answers.
    const rows = summariseAssets([
      { unit: RAND, quantity: '100' },
      { unit: RAND, quantity: '200' },
      { unit: RAND, quantity: '150' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe('450');
    expect(rows[0].assetName).toBe('RANDCOIN');
  });

  it('keeps two tokens with the same name but different policies apart', () => {
    const rows = summariseAssets([
      { unit: `${POL_A}4261646765`, quantity: '1' },
      { unit: `3f2905ae69dacf27678f7c878b1b93b4d3de480c6cf54db15d3e2b984261646765`, quantity: '1' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.assetName === 'Badge')).toBe(true);
    expect(rows[0].policyId).not.toBe(rows[1].policyId);
  });

  it('drops lovelace, which is counted as ADA rather than as an asset', () => {
    expect(summariseAssets([{ unit: 'lovelace', quantity: '5000000' }])).toEqual([]);
    expect(summariseAssets([{ unit: '', quantity: '5000000' }])).toEqual([]);
  });

  it('handles quantities beyond a double', () => {
    // Native asset quantities are unbounded integers on this ledger.
    const big = '9007199254740993';
    const rows = summariseAssets([{ unit: RAND, quantity: big }, { unit: RAND, quantity: '1' }]);
    expect(rows[0].quantity).toBe('9007199254740994');
  });

  it('orders deterministically, so output does not shuffle between runs', () => {
    const a = summariseAssets([{ unit: `${POL_A}01`, quantity: '1' }, { unit: `${POL_A}00`, quantity: '1' }]);
    const b = summariseAssets([{ unit: `${POL_A}00`, quantity: '1' }, { unit: `${POL_A}01`, quantity: '1' }]);
    expect(a.map((r) => r.unit)).toEqual(b.map((r) => r.unit));
  });
});
