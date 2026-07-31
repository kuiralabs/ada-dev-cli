// Checking a datum or redeemer against the shape the blueprint declares.
//
// This is the advantage CIP-57 hands us that the Midnight CLI does not have.
// There, `coerceArg` *guesses*: an array of integers in 0–255 becomes a byte
// buffer, a string matching /^-?\d+n$/ becomes a bigint. It has to guess, because
// `contract-info.json` carries no types at the call boundary.
//
// A blueprint does. Every datum, redeemer and parameter declares a `dataType`,
// and sum types enumerate their constructors. So a malformed value can be
// rejected here — naming the expected shape — instead of being encoded happily,
// submitted, and refused by the chain after a fee has been paid.

import { AdaError } from './errors.ts';
import { EXIT_INVALID_ARGS } from './exit-codes.ts';

/** A CIP-57 schema node: either a `$ref`, a sum type, or a concrete dataType. */
export interface Schema {
  title?: string;
  description?: string;
  $ref?: string;
  dataType?: string;
  index?: number;
  anyOf?: Schema[];
  fields?: Schema[];
  items?: Schema | Schema[];
  keys?: Schema;
  values?: Schema;
}

export type Definitions = Record<string, Schema>;

/**
 * Resolve a `$ref` into the document's definitions.
 *
 * References are JSON-Pointer escaped, so `aiken/crypto/VerificationKeyHash`
 * appears as `#/definitions/aiken~1crypto~1VerificationKeyHash`.
 */
function resolve(schema: Schema, defs: Definitions, seen = new Set<string>()): Schema {
  if (!schema.$ref) return schema;
  const key = decodeURIComponent(schema.$ref.replace(/^#\/definitions\//, ''))
    .replace(/~1/g, '/')
    .replace(/~0/g, '~');
  if (seen.has(key)) return schema; // a recursive type; stop unrolling
  const target = defs[key];
  if (!target) return schema; // unknown definition: accept rather than invent a rule
  seen.add(key);
  return resolve(target, defs, seen);
}

/** A human description of what a schema expects, for error messages. */
export function describe(schema: Schema, defs: Definitions): string {
  const s = resolve(schema, defs);
  if (s.anyOf) {
    const alts = s.anyOf.map((a) => {
      const n = a.fields?.length ?? 0;
      return `${a.title ?? 'constructor'} (index ${a.index}, ${n} field${n === 1 ? '' : 's'})`;
    });
    return alts.length === 1 ? alts[0] : `one of: ${alts.join(', ')}`;
  }
  switch (s.dataType) {
    case 'bytes': return 'a hex string';
    case 'integer': return 'a whole number';
    case 'list': return 'an array';
    case 'map': return 'a map';
    case 'constructor': return `constructor ${s.index}`;
    default: return s.title ?? 'any Plutus data';
  }
}

/** Where in the value a mismatch was found, so the message can point at it. */
const at = (path: string[]): string => (path.length ? ` at ${path.join('.')}` : '');

function fail(message: string, expected: string, path: string[]): never {
  throw new AdaError('schema_mismatch', `${message}${at(path)}`, EXIT_INVALID_ARGS,
    `the blueprint declares ${expected} — check it with: ada contract inspect`);
}

const isConstructor = (v: unknown): v is { alternative: number; fields: unknown[] } =>
  typeof v === 'object' && v !== null && 'alternative' in v && 'fields' in v;

/**
 * Check a value against a schema, throwing a message that names the shape.
 *
 * Deliberately permissive where the blueprint is: an unresolvable `$ref` or an
 * untyped `Data` field accepts anything, because a checker that invents rules
 * the compiler never stated would reject valid input — worse than not checking.
 */
export function validate(value: unknown, schema: Schema, defs: Definitions, path: string[] = []): void {
  const s = resolve(schema, defs);

  // `Data` — declared with no dataType — means "any Plutus data" by design.
  if (!s.dataType && !s.anyOf) return;

  if (s.anyOf) {
    if (!isConstructor(value)) {
      fail(`expected a constructor like {"alternative":N,"fields":[…]}, got ${typeName(value)}`,
        describe(s, defs), path);
    }
    const match = s.anyOf.find((a) => a.index === value.alternative);
    if (!match) {
      const valid = s.anyOf.map((a) => a.index).join(', ');
      fail(`alternative ${value.alternative} is not one this type declares (valid: ${valid})`,
        describe(s, defs), path);
    }
    validateFields(value.fields, match, defs, path, match.title ?? `constructor ${match.index}`);
    return;
  }

  switch (s.dataType) {
    case 'constructor':
      if (!isConstructor(value)) {
        fail(`expected a constructor, got ${typeName(value)}`, describe(s, defs), path);
      }
      if (s.index !== undefined && value.alternative !== s.index) {
        fail(`expected alternative ${s.index}, got ${value.alternative}`, describe(s, defs), path);
      }
      validateFields(value.fields, s, defs, path, s.title ?? `constructor ${s.index}`);
      return;

    case 'bytes':
      if (typeof value !== 'string') {
        fail(`expected a hex string, got ${typeName(value)}`, describe(s, defs), path);
      }
      // On-chain there are no strings, only bytes — so text must arrive
      // hex-encoded, and silently accepting "Hello" would encode the wrong value.
      if (!/^([0-9a-fA-F]{2})*$/.test(value)) {
        fail(`"${truncate(value)}" is not hex`, 'a hex string — text must be hex-encoded', path);
      }
      return;

    case 'integer':
      if (typeof value === 'number') {
        if (!Number.isInteger(value)) {
          fail(`expected a whole number, got ${value}`, describe(s, defs), path);
        }
        return;
      }
      if (typeof value === 'bigint') return;
      if (typeof value === 'string' && /^-?\d+$/.test(value)) return;
      fail(`expected a whole number, got ${typeName(value)}`, describe(s, defs), path);
      return;

    case 'list':
      if (!Array.isArray(value)) {
        fail(`expected an array, got ${typeName(value)}`, describe(s, defs), path);
      }
      if (s.items && !Array.isArray(s.items)) {
        value.forEach((v, i) => validate(v, s.items as Schema, defs, [...path, `[${i}]`]));
      }
      return;

    case 'map':
      // Accepted as an array of pairs or a Map; the encoder handles both.
      if (!Array.isArray(value) && !(value instanceof Map)) {
        fail(`expected a map, got ${typeName(value)}`, describe(s, defs), path);
      }
      return;

    default:
      return; // a dataType we do not model: accept rather than guess
  }
}

function validateFields(
  fields: unknown, schema: Schema, defs: Definitions, path: string[], label: string,
): void {
  const declared = schema.fields ?? [];
  if (!Array.isArray(fields)) {
    fail(`${label} needs a "fields" array`, describe(schema, defs), path);
  }
  if (fields.length !== declared.length) {
    // The most common mistake, and the one an encoder would happily accept.
    const names = declared.map((f, i) => f.title ?? `#${i}`).join(', ');
    fail(`${label} takes ${declared.length} field${declared.length === 1 ? '' : 's'} (${names || 'none'}), got ${fields.length}`,
      describe(schema, defs), path);
  }
  declared.forEach((f, i) => validate(fields[i], f, defs, [...path, f.title ?? `field ${i}`]));
}

const typeName = (v: unknown): string =>
  v === null ? 'null'
    : Array.isArray(v) ? 'an array'
    : typeof v === 'object' ? 'an object'
    : typeof v === 'string' ? 'a string'
    : typeof v;

const truncate = (s: string): string => (s.length > 24 ? `${s.slice(0, 24)}…` : s);
