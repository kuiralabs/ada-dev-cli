// The budget a transaction declares must cover what its scripts need.
//
// This failure was mistaken for a broken validator across two separate
// investigations, so the mechanism is worth stating once. MeshJS evaluates the
// transaction while it is still being assembled, writes those execution units
// into the redeemer, and then finishes building. A validator whose cost depends
// on the finished transaction — one that sums the outputs, say — is therefore
// charged for something smaller than what the ledger will run.
//
// A node's response is to run the script, stop part way through, and report
// `ValidationTagMismatch (IsValid True) (FailedUnexpectedly …)`, which reads as
// "your validator is wrong" and sends you off to debug a correct contract.
//
// The fixture is the real transaction: a settling auction, built by this tool,
// refused by a devnet for exactly this reason.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { assertBudgetCovers, declaredExUnits } from '../lib/mesh.ts';
import { AdaError } from '../lib/errors.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TX = readFileSync(join(HERE, 'fixtures', 'under-declared-budget.tx'), 'utf8').trim();

/** What this transaction declares, and what it turned out to need. */
const DECLARED = { mem: 87_767, steps: 29_702_744 };
const NEEDED = { mem: 102_021, steps: 33_859_095 };

/** An evaluator reporting what the finished transaction costs. */
const needing = (budget: { mem: number; steps: number }) =>
  ({ evaluateTx: vi.fn().mockResolvedValue([{ budget }]) }) as never;

describe('reading a budget back out of a transaction', () => {
  it('reports what the transaction actually declares', async () => {
    // Read from the CBOR rather than tracked on the way in, because the number
    // that matters is the one the ledger will read — and the failure being
    // guarded against is the builder writing something other than it evaluated.
    await expect(declaredExUnits(TX)).resolves.toEqual(DECLARED);
  });
});

describe('an under-declared execution budget', () => {
  it('is caught before submitting, not by the chain afterwards', async () => {
    await expect(assertBudgetCovers(needing(NEEDED), TX))
      .rejects.toThrow(/declares less execution budget/);
  });

  it('names both figures, since the gap is the whole point', async () => {
    try {
      await assertBudgetCovers(needing(NEEDED), TX);
      expect.unreachable('should have thrown');
    } catch (err) {
      const detail = (err as AdaError).detail ?? '';
      expect(detail).toContain('29,702,744');
      expect(detail).toContain('33,859,095');
    }
  });

  it('blames the builder rather than the validator', async () => {
    // The entire cost of this bug was investigations aimed at the contract.
    try {
      await assertBudgetCovers(needing(NEEDED), TX);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AdaError).code).toBe('budget_under_declared');
      expect((err as AdaError).hint).toMatch(/builder fault/);
    }
  });

  it('catches a shortfall in memory alone', async () => {
    await expect(assertBudgetCovers(needing({ mem: 200_000, steps: 1 }), TX))
      .rejects.toThrow(/declares less execution budget/);
  });

  it('accepts a budget that covers the requirement', async () => {
    // What the margin produces: double the draft, comfortably over the real cost.
    await expect(assertBudgetCovers(needing({ mem: 50_000, steps: 20_000_000 }), TX))
      .resolves.toBeUndefined();
  });

  it('accepts a budget that matches exactly', async () => {
    await expect(assertBudgetCovers(needing(DECLARED), TX)).resolves.toBeUndefined();
  });

  it('stays silent for a transaction that runs no scripts', async () => {
    await expect(assertBudgetCovers({ evaluateTx: vi.fn().mockResolvedValue([]) } as never, TX))
      .resolves.toBeUndefined();
  });

  it('stays silent when the evaluator cannot answer', async () => {
    // A guard against one known failure, not a second gate every transaction has
    // to pass. The chain remains the authority.
    const broken = { evaluateTx: vi.fn().mockRejectedValue(new Error('nope')) } as never;
    await expect(assertBudgetCovers(broken, TX)).resolves.toBeUndefined();
  });
});
