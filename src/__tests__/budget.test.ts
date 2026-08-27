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
import { assertBudgetCovers, declaredExUnits, underDeclared, redeemerKey } from '../lib/mesh.ts';
import { AdaError } from '../lib/errors.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const TX = readFileSync(join(HERE, 'fixtures', 'under-declared-budget.tx'), 'utf8').trim();

/** What this transaction declares, and what it turned out to need. */
const DECLARED = { mem: 87_767, steps: 29_702_744 };
const NEEDED = { mem: 102_021, steps: 33_859_095 };

/**
 * An evaluator reporting what the finished transaction costs.
 *
 * Its actions carry `tag` and `index` because real ones do: budgets are matched
 * to redeemers by purpose and position, and a mock without them would let a
 * matching bug pass here while failing on chain. The fixture runs one script,
 * spend #0.
 */
const needing = (budget: { mem: number; steps: number }) =>
  ({ evaluateTx: vi.fn().mockResolvedValue([{ tag: 'SPEND', index: 0, budget }]) }) as never;

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

describe('a budget is checked per redeemer, not in total', () => {
  const spend0 = { tag: 'SPEND', index: 0, mem: 100, steps: 1000 };
  const spend1 = { tag: 'SPEND', index: 1, mem: 100, steps: 1000 };
  const mint0 = { tag: 'MINT', index: 0, mem: 50, steps: 500 };

  // The ledger checks each redeemer against its own budget, so one script's
  // surplus cannot cover another's shortfall. Comparing totals said this
  // transaction was fine, and a node would have run the second spend, stopped
  // part way, and reported it as a failed validation.
  it('catches a shortfall another redeemer\'s surplus would hide in the total', () => {
    const declared = new Map([
      [redeemerKey('Spend', 0), { mem: 300, steps: 3000 }],  // generous
      [redeemerKey('Spend', 1), { mem: 10, steps: 100 }],    // short
    ]);
    const short = underDeclared([spend0, spend1], declared);
    expect(short.map((s) => s.key)).toEqual(['spend #1']);
  });

  it('tells a spend from a mint at the same index', () => {
    // Indices restart per purpose, so matching on the number alone compares a
    // spend's budget against a mint's.
    const declared = new Map([
      [redeemerKey('Spend', 0), { mem: 100, steps: 1000 }],
      [redeemerKey('Mint', 0), { mem: 1, steps: 1 }],
    ]);
    expect(underDeclared([spend0, mint0], declared).map((s) => s.key)).toEqual(['mint #0']);
  });

  it('treats a redeemer the transaction never declares as declaring nothing', () => {
    expect(underDeclared([spend0], new Map()).map((s) => s.key)).toEqual(['spend #0']);
  });

  it('is silent when every redeemer covers itself', () => {
    const declared = new Map([
      [redeemerKey('Spend', 0), { mem: 100, steps: 1000 }],
      [redeemerKey('Mint', 0), { mem: 50, steps: 500 }],
    ]);
    expect(underDeclared([spend0, mint0], declared)).toEqual([]);
  });
});
