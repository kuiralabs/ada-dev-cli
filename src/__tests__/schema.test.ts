// Checking values against the shape a blueprint declares.
//
// This is the thing CIP-57 gives us that the Midnight CLI cannot have. There,
// `coerceArg` guesses — an array of integers in 0–255 becomes a byte buffer —
// because `contract-info.json` carries no types at the call boundary. A blueprint
// does, so a malformed value is rejected here rather than encoded happily,
// submitted, and refused by the chain after a fee has been paid.
//
// The fixtures are the real definitions from aiken-lang/hello_world and its
// gift_card example.

import { describe, it, expect } from 'vitest';
import { validate, describe as describeSchema, type Definitions, type Schema } from '../lib/schema.ts';
import { AdaError } from '../lib/errors.ts';

const DEFS: Definitions = {
  ByteArray: { dataType: 'bytes' },
  Int: { dataType: 'integer' },
  Data: { title: 'Data', description: 'Any Plutus data.' },
  'aiken/crypto/VerificationKeyHash': { title: 'VerificationKeyHash', dataType: 'bytes' },
  'hello_world/Redeemer': {
    title: 'Redeemer',
    anyOf: [{ title: 'Redeemer', dataType: 'constructor', index: 0,
      fields: [{ title: 'msg', $ref: '#/definitions/ByteArray' }] }],
  },
  'hello_world/Datum': {
    title: 'Datum',
    anyOf: [{ title: 'Datum', dataType: 'constructor', index: 0,
      fields: [{ title: 'owner', $ref: '#/definitions/aiken~1crypto~1VerificationKeyHash' }] }],
  },
  'oneshot/Action': {
    title: 'Action',
    anyOf: [
      { title: 'Mint', dataType: 'constructor', index: 0, fields: [] },
      { title: 'Burn', dataType: 'constructor', index: 1, fields: [] },
    ],
  },
  'multi/Action': {
    title: 'Action',
    anyOf: [
      { title: 'Mint', dataType: 'constructor', index: 0, fields: [{ $ref: '#/definitions/Int' }] },
      { title: 'Burn', dataType: 'constructor', index: 1, fields: [] },
    ],
  },
};

const redeemer: Schema = { $ref: '#/definitions/hello_world~1Redeemer' };
const action: Schema = { $ref: '#/definitions/oneshot~1Action' };
const ok = (v: unknown, s: Schema = redeemer) => expect(() => validate(v, s, DEFS)).not.toThrow();
const bad = (v: unknown, s: Schema = redeemer) => {
  try { validate(v, s, DEFS); expect.unreachable(); } catch (e) { return e as AdaError; }
  throw new Error('unreachable');
};

describe('constructors', () => {
  it('accepts the declared shape', () => {
    ok({ alternative: 0, fields: ['48656c6c6f'] });
  });

  it('rejects an alternative the type does not declare, listing the valid ones', () => {
    const e = bad({ alternative: 7, fields: ['ab'] });
    expect(e.code).toBe('schema_mismatch');
    expect(e.message).toContain('valid: 0');
  });

  it('lists every alternative of a sum type', () => {
    // Mint and Burn. Reading both out of the blueprint is the whole point.
    expect(bad({ alternative: 2, fields: [] }, action).message).toContain('valid: 0, 1');
    ok({ alternative: 0, fields: [] }, action);
    ok({ alternative: 1, fields: [] }, action);
  });

  it('rejects a value that is not a constructor at all', () => {
    expect(bad('just a string').message).toMatch(/expected a constructor/);
    expect(bad(42).message).toMatch(/expected a constructor/);
    expect(bad(null).message).toMatch(/expected a constructor/);
  });
});

describe('field arity', () => {
  it('names the fields when the count is wrong', () => {
    // The most common mistake, and one an encoder accepts happily.
    expect(bad({ alternative: 0, fields: [] }).message).toContain('takes 1 field (msg), got 0');
    expect(bad({ alternative: 0, fields: ['ab', 'cd'] }).message).toContain('got 2');
  });

  it('reports "none" rather than an empty list for a no-field constructor', () => {
    expect(bad({ alternative: 1, fields: ['ab'] }, action).message).toContain('(none)');
  });

  it('checks a nested field against its own schema', () => {
    // multi/Action's Mint carries an Int.
    const multi: Schema = { $ref: '#/definitions/multi~1Action' };
    ok({ alternative: 0, fields: [5] }, multi);
    expect(bad({ alternative: 0, fields: ['not an int'] }, multi).message).toMatch(/whole number/);
  });
});

describe('bytes', () => {
  it('accepts hex', () => {
    ok({ alternative: 0, fields: ['48656c6c6f2c20576f726c6421'] });
  });

  it('rejects plain text, which would encode the wrong value silently', () => {
    // On-chain there are no strings, only bytes. "Hello" is not the same as its
    // hex encoding, and accepting it would produce a datum the validator never
    // sees the way the caller intended.
    const e = bad({ alternative: 0, fields: ['Hello'] });
    expect(e.message).toContain('is not hex');
    expect(e.hint).toMatch(/hex-encoded/);
  });

  it('rejects an odd-length hex string, which is not whole bytes', () => {
    expect(bad({ alternative: 0, fields: ['abc'] }).message).toContain('is not hex');
  });

  it('accepts empty bytes', () => {
    ok({ alternative: 0, fields: [''] });
  });

  it('rejects a number where bytes are declared, naming the field', () => {
    const e = bad({ alternative: 0, fields: [42] });
    expect(e.message).toContain('expected a hex string');
    expect(e.message).toContain('at msg');
  });

  it('truncates a long value rather than echoing it whole', () => {
    expect(bad({ alternative: 0, fields: ['z'.repeat(200)] }).message).toContain('…');
  });
});

describe('integers', () => {
  const int: Schema = { $ref: '#/definitions/Int' };
  it('accepts a number, a bigint and a numeric string', () => {
    ok(5, int); ok(5n, int); ok('5', int); ok(-3, int);
  });
  it('rejects a fraction', () => {
    expect(bad(1.5, int).message).toMatch(/whole number/);
  });
  it('rejects a non-numeric string', () => {
    expect(bad('five', int).message).toMatch(/whole number/);
  });
});

describe('deliberate permissiveness', () => {
  it('accepts anything for an untyped Data field', () => {
    // `Data` means "any Plutus data" by design. Inventing a rule the compiler
    // never stated would reject valid input, which is worse than not checking.
    const anyData: Schema = { $ref: '#/definitions/Data' };
    ok('anything', anyData); ok(42, anyData); ok({ alternative: 9, fields: [] }, anyData);
  });

  it('accepts anything for an unresolvable reference', () => {
    ok('anything', { $ref: '#/definitions/NotDefined' });
  });

  it('does not loop on a recursive type', () => {
    const defs: Definitions = { Loop: { $ref: '#/definitions/Loop' } };
    expect(() => validate('x', { $ref: '#/definitions/Loop' }, defs)).not.toThrow();
  });
});

describe('describing what is expected', () => {
  it('names a single constructor and its arity', () => {
    expect(describeSchema(redeemer, DEFS)).toBe('Redeemer (index 0, 1 field)');
  });

  it('lists the alternatives of a sum type', () => {
    const d = describeSchema(action, DEFS);
    expect(d).toContain('Mint (index 0, 0 fields)');
    expect(d).toContain('Burn (index 1, 0 fields)');
  });

  it('describes primitives in words a person can act on', () => {
    expect(describeSchema({ dataType: 'bytes' }, DEFS)).toBe('a hex string');
    expect(describeSchema({ dataType: 'integer' }, DEFS)).toBe('a whole number');
  });
});
