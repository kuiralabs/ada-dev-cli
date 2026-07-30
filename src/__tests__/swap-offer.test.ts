// Offer encoding, validation, and the misrepresentation check.
//
// The vulnerability these pin was found by driving the tool, not by the suite:
// an offer carries a transaction *and* a description of it, and the first
// implementation displayed and signed against the description. Editing one JSON
// field produced an offer reading "you give 0.000001 ADA" while the transaction
// took 50. A received offer is untrusted input, and that includes its account of
// itself.

import { describe, it, expect } from 'vitest';
import {
  encodeOffer, decodeOffer, isExpired, OFFER_VERSION, type SwapOffer,
} from '../lib/swap-offer.ts';
import { claimMismatches, type NetEffect } from '../lib/swap-verify.ts';
import { AdaError } from '../lib/errors.ts';
import { LOVELACE_UNIT } from '../lib/amount.ts';

const SILK = `${'2b'.repeat(28)}53696c6b`;

const offer = (over: Partial<SwapOffer> = {}): SwapOffer => ({
  version: OFFER_VERSION,
  network: 'devnet',
  tx: 'deadbeef',
  maker: { address: 'addr_test1maker', gives: [{ unit: SILK, quantity: '20' }] },
  taker: { address: 'addr_test1taker', gives: [{ unit: LOVELACE_UNIT, quantity: '50000000' }] },
  makerSigned: true,
  createdAt: 1_000_000,
  expiresAt: 2_000_000,
  ...over,
});

const effect = (over: Partial<NetEffect> = {}): NetEffect => ({
  deltas: [], gains: [], losses: [], grossReceived: [], ...over,
});

describe('encoding round-trips', () => {
  it('survives encode then decode', () => {
    const original = offer();
    expect(decodeOffer(encodeOffer(original))).toEqual(original);
  });

  it('tolerates surrounding whitespace from a paste', () => {
    expect(decodeOffer(`  ${encodeOffer(offer())}\n`).network).toBe('devnet');
  });
});

describe('a decoded offer is validated, not trusted', () => {
  it('rejects anything that is not an offer', () => {
    for (const bad of ['', 'not-base64!!', Buffer.from('{}').toString('base64')]) {
      expect(() => decodeOffer(bad), bad).toThrowError(AdaError);
    }
  });

  it('rejects an unknown version rather than guessing at its shape', () => {
    const wrong = encodeOffer({ ...offer(), version: 99 });
    expect(() => decodeOffer(wrong)).toThrowError(/version/);
  });

  it('rejects a missing transaction', () => {
    const bad = Buffer.from(JSON.stringify({ ...offer(), tx: '' })).toString('base64');
    expect(() => decodeOffer(bad)).toThrowError(AdaError);
  });

  it('rejects a malformed side', () => {
    const bad = Buffer.from(JSON.stringify({ ...offer(), taker: { address: 'x' } })).toString('base64');
    expect(() => decodeOffer(bad)).toThrowError(AdaError);
  });

  it('treats a missing makerSigned as unsigned rather than signed', () => {
    // Defaulting the other way would let an offer omit the field to look signed.
    const raw = { ...offer() } as Record<string, unknown>;
    delete raw.makerSigned;
    expect(decodeOffer(Buffer.from(JSON.stringify(raw)).toString('base64')).makerSigned).toBe(false);
  });
});

describe('expiry', () => {
  // expiresAt is in seconds; the clock passed in is milliseconds. Getting that
  // backwards is exactly the kind of unit slip worth a test — an offer that never
  // expires is a replay window.
  const deadlineSeconds = 5_000;
  const deadlineMs = deadlineSeconds * 1000;

  it('is live before the deadline', () => {
    expect(isExpired(offer({ expiresAt: deadlineSeconds }), deadlineMs - 1)).toBe(false);
    expect(isExpired(offer({ expiresAt: deadlineSeconds }), 1_000)).toBe(false);
  });

  it('is expired at the deadline and after', () => {
    expect(isExpired(offer({ expiresAt: deadlineSeconds }), deadlineMs)).toBe(true);
    expect(isExpired(offer({ expiresAt: deadlineSeconds }), deadlineMs + 60_000)).toBe(true);
  });
});

describe('the description is checked against the transaction', () => {
  it('accepts an honest offer', () => {
    // Promised 20 Silk, receives 20 Silk gross; agreed to give 50 ADA, net loses
    // slightly less because the maker pays the fee.
    const honest = claimMismatches(offer(), effect({
      grossReceived: [{ unit: SILK, quantity: '20' }, { unit: LOVELACE_UNIT, quantity: '1137840' }],
      losses: [{ unit: LOVELACE_UNIT, quantity: '48862160' }],
      gains: [{ unit: SILK, quantity: '20' }],
    }));
    expect(honest).toEqual([]);
  });

  it('catches a transaction that takes more than the offer admits', () => {
    // The attack: the description was edited to claim a trivial amount.
    const lying = offer({ taker: { address: 'addr_test1taker', gives: [{ unit: LOVELACE_UNIT, quantity: '1' }] } });
    const problems = claimMismatches(lying, effect({
      grossReceived: [{ unit: SILK, quantity: '20' }],
      losses: [{ unit: LOVELACE_UNIT, quantity: '50000000' }],
    }));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toMatch(/takes 50000000/);
  });

  it('catches a transaction that pays less than promised', () => {
    const problems = claimMismatches(offer(), effect({
      grossReceived: [{ unit: SILK, quantity: '5' }],
      losses: [{ unit: LOVELACE_UNIT, quantity: '50000000' }],
    }));
    expect(problems.join(' ')).toMatch(/promises you 20 .* pays you 5/);
  });

  it('catches an asset leaving that the offer never mentions', () => {
    const problems = claimMismatches(offer(), effect({
      grossReceived: [{ unit: SILK, quantity: '20' }],
      losses: [
        { unit: LOVELACE_UNIT, quantity: '50000000' },
        { unit: `${'ff'.repeat(28)}4a616465`, quantity: '99' },
      ],
    }));
    expect(problems.join(' ')).toMatch(/does not mention/);
  });

  it('does not flag a net loss smaller than agreed', () => {
    // Losing less than promised is not a misrepresentation — it is the maker
    // absorbing the fee, which is the normal case.
    expect(claimMismatches(offer(), effect({
      grossReceived: [{ unit: SILK, quantity: '20' }],
      losses: [{ unit: LOVELACE_UNIT, quantity: '40000000' }],
    }))).toEqual([]);
  });
});
