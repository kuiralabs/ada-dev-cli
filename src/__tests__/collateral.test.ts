// Collateral selection.
//
// Collateral is pledged on every script transaction and forfeited only when a
// script fails after the ledger's cheap checks pass. It must be **pure ADA**, and
// that rule is the trap: a wallet that has minted or received any token can end
// up with every output carrying one, at which point every script transaction
// fails for a reason that looks nothing like its cause.

import { describe, it, expect } from 'vitest';
import { selectCollateral } from '../lib/tx-common.ts';
import { AdaError } from '../lib/errors.ts';
import type { UTxO } from '@meshsdk/core';

const utxo = (ref: string, amount: { unit: string; quantity: string }[]): UTxO => ({
  input: { txHash: ref, outputIndex: 0 },
  output: { address: 'addr_test1q...', amount },
} as UTxO);

const ada = (n: string) => ({ unit: 'lovelace', quantity: n });
const token = { unit: 'policy1.Silk', quantity: '10' };

describe('selecting collateral', () => {
  it('picks a pure-ADA output', () => {
    const chosen = selectCollateral([utxo('a', [ada('10000000')])], 5_000_000n);
    expect(chosen.input.txHash).toBe('a');
  });

  it('skips outputs carrying a native asset, however large', () => {
    // A 1000 ADA output with one token attached cannot serve as collateral.
    const chosen = selectCollateral([
      utxo('rich-but-tokenised', [ada('1000000000'), token]),
      utxo('plain', [ada('6000000')]),
    ], 5_000_000n);
    expect(chosen.input.txHash).toBe('plain');
  });

  it('prefers the smallest sufficient output, so a large one is not tied up', () => {
    const chosen = selectCollateral([
      utxo('big', [ada('900000000')]),
      utxo('right-sized', [ada('6000000')]),
      utxo('too-small', [ada('1000000')]),
    ], 5_000_000n);
    expect(chosen.input.txHash).toBe('right-sized');
  });

  it('explains how to create one when every output carries an asset', () => {
    // The failure that looks nothing like its cause. Naming the remedy is the
    // whole point of handling this case separately.
    try {
      selectCollateral([utxo('a', [ada('1000000000'), token])], 5_000_000n);
      expect.unreachable();
    } catch (e) {
      expect((e as AdaError).code).toBe('no_collateral');
      expect((e as AdaError).hint).toContain('ada transfer');
    }
  });

  it('distinguishes "none qualify" from "none large enough"', () => {
    try {
      selectCollateral([utxo('a', [ada('1000000')])], 5_000_000n);
      expect.unreachable();
    } catch (e) {
      expect((e as AdaError).code).toBe('insufficient_collateral');
      expect((e as AdaError).message).toMatch(/largest pure-ADA UTxO holds/);
    }
  });

  it('reports the shortfall in ADA rather than lovelace', () => {
    try {
      selectCollateral([utxo('a', [ada('1500000')])], 5_000_000n);
      expect.unreachable();
    } catch (e) {
      expect((e as AdaError).message).toContain('1.5');
    }
  });

  it('rejects an empty wallet with the actionable error, not a crash', () => {
    expect(() => selectCollateral([], 5_000_000n)).toThrow(AdaError);
  });
});
