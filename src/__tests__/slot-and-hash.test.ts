// The two helpers that exist because a contract could not be written without
// reaching outside the toolchain for them.

import { describe, it, expect } from 'vitest';
import { slotToMs, msToSlot, type SlotConfig } from '../lib/slot-config.ts';
import { blake2b } from '@noble/hashes/blake2b';

// The devnet used throughout: genesis at a known moment, one second per slot.
const devnet: SlotConfig = { zeroTime: 1_785_477_201_000, zeroSlot: 0, slotLength: 1000 };
// Preprod, whose zeroSlot is not zero — an earlier era precedes it.
const preprod: SlotConfig = { zeroTime: 1_655_769_600_000, zeroSlot: 86_400, slotLength: 1000 };

describe('slots and time convert both ways', () => {
  it('turns a slot into the millisecond its window begins at', () => {
    expect(slotToMs(3031, devnet)).toBe(1_785_480_232_000);
  });

  it('turns a millisecond back into its slot', () => {
    expect(msToSlot(1_785_480_232_000, devnet)).toBe(3031);
  });

  it('round-trips', () => {
    for (const s of [0, 1, 999, 129_797_048]) {
      expect(msToSlot(slotToMs(s, preprod), preprod)).toBe(s);
    }
  });

  it('honours a zeroSlot that is not zero', () => {
    // Preprod's slot numbering continues from an earlier era; ignoring the
    // offset puts every answer out by a day.
    expect(slotToMs(129_797_048, preprod)).toBe(1_785_480_248_000);
  });

  it('floors a millisecond inside a slot to that slot', () => {
    // A moment 400ms into a slot is still that slot, not the next one.
    expect(msToSlot(slotToMs(500, devnet) + 400, devnet)).toBe(500);
  });

  it('is the arithmetic that was silently wrong', () => {
    // MeshJS's testnet entry has slotLength 0, which maps everything to 1970 —
    // a validator then judged its deadline against the wrong century.
    const broken: SlotConfig = { zeroTime: 0, zeroSlot: 0, slotLength: 0 };
    expect(slotToMs(3031, broken)).toBe(0);
    expect(slotToMs(3031, devnet)).not.toBe(0);
  });
});

describe('hashing a commitment', () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

  it('reproduces the bounty commitment the chain accepted', () => {
    // This exact digest was the answer_hash a validator checked against on both
    // devnet and preprod, so it is verified by more than this test.
    expect(hex(blake2b(Buffer.from('a river', 'utf8'), { dkLen: 32 })))
      .toBe('54208163d449b1610394cac1fdf425a7dfd8fa76058109efa9173dad6b559698');
  });

  it('hashes bytes, so text and its hex spelling must agree', () => {
    // The trap: hashing the characters "61207269766572" instead of the bytes
    // they denote gives a different digest, and nothing says which was meant.
    const fromText = hex(blake2b(Buffer.from('a river', 'utf8'), { dkLen: 32 }));
    const fromHexBytes = hex(blake2b(Buffer.from('61207269766572', 'hex'), { dkLen: 32 }));
    const fromHexChars = hex(blake2b(Buffer.from('61207269766572', 'utf8'), { dkLen: 32 }));
    expect(fromHexBytes).toBe(fromText);
    expect(fromHexChars).not.toBe(fromText);
  });

  it('does 224 bits as well, which is what a script hash is', () => {
    expect(hex(blake2b(Buffer.from('x'), { dkLen: 28 }))).toHaveLength(56);
  });
});
