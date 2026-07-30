// CIP-57 Plutus blueprints — the only file that reads `plutus.json`.
//
// Same discipline as mesh.ts: one file owns one boundary. Commands ask for a
// validator and never parse the document themselves, so discovery, handler
// naming and the encoding rule below are decided once.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyParamsToScript, serializePlutusScript, resolveScriptHash } from '@meshsdk/core';
import { AdaError, usageError } from './errors.ts';
import { EXIT_INVALID_ARGS } from './exit-codes.ts';
import type { NetworkName } from './cli-config.ts';

export const BLUEPRINT_FILENAME = 'plutus.json';

/**
 * Where a blueprint might live, in the order we look.
 *
 * CIP-57 places `plutus.json` at a project root only *by convention*, and the
 * Midnight CLI already paid for assuming one layout: projects that differed
 * "silently miss our scan and force users into --managed". A monorepo commonly
 * keeps validators under an `onchain/` or `contract/` subdirectory.
 */
const SCAN_CANDIDATES = ['', 'onchain', 'contract', 'contracts', 'aiken', 'validators'] as const;

export type PlutusVersion = 'V1' | 'V2' | 'V3';

export interface BlueprintParameter {
  title?: string;
  schema?: unknown;
}

export interface BlueprintValidator {
  /** `module.validator.handler`, e.g. `hello_world.hello_world.spend`. */
  title: string;
  compiledCode?: string;
  hash?: string;
  datum?: { title?: string; schema?: unknown };
  redeemer?: { title?: string; schema?: unknown };
  parameters?: BlueprintParameter[];
}

export interface Blueprint {
  preamble: {
    title?: string;
    version?: string;
    plutusVersion?: string;
    compiler?: { name?: string; version?: string };
  };
  validators: BlueprintValidator[];
}

export interface LoadedBlueprint {
  path: string;
  doc: Blueprint;
  /** Plutus version from the preamble, normalised. Never assumed. */
  version: PlutusVersion;
}

/** A validator's three parts, split out of `module.validator.handler`. */
export interface ValidatorName {
  module: string;
  validator: string;
  handler: string;
}

export function splitTitle(title: string): ValidatorName {
  const parts = title.split('.');
  if (parts.length < 3) {
    // Older or hand-written blueprints may omit the handler segment.
    return { module: parts[0] ?? '', validator: parts[1] ?? parts[0] ?? '', handler: parts[2] ?? '' };
  }
  return { module: parts[0], validator: parts[1], handler: parts.slice(2).join('.') };
}

/**
 * Find and parse a blueprint.
 *
 * `explicit` is a direct path to the file or to a directory containing one.
 */
export function loadBlueprint(explicit?: string, cwd: string = process.cwd()): LoadedBlueprint {
  const path = findBlueprint(explicit, cwd);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new AdaError('blueprint_unreadable', `cannot read ${path}: ${(err as Error).message}`,
      EXIT_INVALID_ARGS);
  }

  let doc: Blueprint;
  try {
    doc = JSON.parse(raw) as Blueprint;
  } catch (err) {
    throw new AdaError('blueprint_invalid', `${path} is not valid JSON: ${(err as Error).message}`,
      EXIT_INVALID_ARGS, 'run `aiken build` to regenerate it');
  }

  if (!Array.isArray(doc.validators)) {
    throw new AdaError('blueprint_invalid', `${path} has no validators array`, EXIT_INVALID_ARGS,
      'this does not look like a CIP-57 blueprint');
  }

  return { path, doc, version: plutusVersionOf(doc, path) };
}

function findBlueprint(explicit: string | undefined, cwd: string): string {
  if (explicit) {
    const target = resolve(explicit);
    if (!existsSync(target)) {
      throw new AdaError('blueprint_not_found', `no such path: ${target}`, EXIT_INVALID_ARGS);
    }
    const file = statSync(target).isDirectory() ? join(target, BLUEPRINT_FILENAME) : target;
    if (!existsSync(file)) {
      throw new AdaError('blueprint_not_found', `no ${BLUEPRINT_FILENAME} in ${target}`,
        EXIT_INVALID_ARGS, 'run `aiken build` in the project first');
    }
    return file;
  }

  for (const candidate of SCAN_CANDIDATES) {
    const file = join(resolve(cwd), candidate, BLUEPRINT_FILENAME);
    if (existsSync(file)) return file;
  }

  throw new AdaError('blueprint_not_found',
    `no ${BLUEPRINT_FILENAME} found in ${cwd} or its usual subdirectories`, EXIT_INVALID_ARGS,
    'run `aiken build`, or pass --blueprint <path>');
}

/**
 * The Plutus version, read from the preamble rather than assumed.
 *
 * Hardcoding V3 would silently misbuild a V2 project: the version selects the
 * cost model the chain prices the script with.
 */
function plutusVersionOf(doc: Blueprint, path: string): PlutusVersion {
  const raw = (doc.preamble?.plutusVersion ?? '').toLowerCase();
  switch (raw) {
    case 'v1': return 'V1';
    case 'v2': return 'V2';
    case 'v3': return 'V3';
    default:
      throw new AdaError('blueprint_invalid',
        `${path} declares plutusVersion "${doc.preamble?.plutusVersion ?? '(missing)'}"`,
        EXIT_INVALID_ARGS, 'expected v1, v2 or v3 in the blueprint preamble');
  }
}

export interface SelectOptions {
  module?: string;
  validator?: string;
  /** Restrict to one handler, e.g. `spend` or `mint`. */
  handler?: string;
}

/**
 * Pick one validator from the document.
 *
 * A blueprint lists an entry per **handler**, not per validator — `.spend`,
 * `.mint` and `.else` of one validator share a hash and one compiled program. So
 * a project with a single validator still yields several entries, and the
 * selection axis that matters is module + validator, which is exactly what
 * `aiken` itself takes.
 */
export function selectValidator(loaded: LoadedBlueprint, opts: SelectOptions = {}): BlueprintValidator {
  const all = loaded.doc.validators;
  const matches = all.filter((v) => {
    const n = splitTitle(v.title);
    if (opts.module && n.module !== opts.module) return false;
    if (opts.validator && n.validator !== opts.validator) return false;
    if (opts.handler && n.handler !== opts.handler) return false;
    return true;
  });

  if (matches.length === 0) {
    throw new AdaError('validator_not_found',
      `no validator in ${loaded.path} matches ${describeSelection(opts) || 'the given selection'}`,
      EXIT_INVALID_ARGS, `available: ${listNames(all).join(', ')}`);
  }

  // Several handlers of ONE validator is not ambiguity — they are one program.
  const distinct = new Set(matches.map((v) => {
    const n = splitTitle(v.title);
    return `${n.module}.${n.validator}`;
  }));
  if (distinct.size > 1) {
    throw new AdaError('validator_ambiguous',
      `${distinct.size} validators match in ${loaded.path}`, EXIT_INVALID_ARGS,
      `narrow it with --module and --validator: ${[...distinct].join(', ')}`);
  }

  // Prefer a handler that carries the parameters/schemas, and never `.else`.
  return matches.find((v) => !splitTitle(v.title).handler.startsWith('else')) ?? matches[0];
}

const describeSelection = (o: SelectOptions): string =>
  [o.module && `module ${o.module}`, o.validator && `validator ${o.validator}`,
   o.handler && `handler ${o.handler}`].filter(Boolean).join(', ');

/** Distinct `module.validator` names present in a document. */
export function listNames(validators: BlueprintValidator[]): string[] {
  const seen = new Set<string>();
  for (const v of validators) {
    const n = splitTitle(v.title);
    seen.add(`${n.module}.${n.validator}`);
  }
  return [...seen].sort();
}

/** Every handler declared for one `module.validator`. */
export function handlersOf(validators: BlueprintValidator[], name: string): string[] {
  return validators
    .filter((v) => { const n = splitTitle(v.title); return `${n.module}.${n.validator}` === name; })
    .map((v) => splitTitle(v.title).handler)
    .filter(Boolean)
    .sort();
}

/**
 * The script bytes that actually get hashed.
 *
 * **`compiledCode` is not it.** The blueprint stores a single-CBOR-encoded
 * script; the hash — and therefore the address and the policy id — is computed
 * over the DOUBLE-wrapped form. `applyParamsToScript` performs that wrapping,
 * which is why reference code calls it even with an empty parameter list, a line
 * that reads like a no-op and is not.
 *
 * Measured on the hello-world blueprint: the raw value yields
 * `addr_test1wrajwv4l3…` while the wrapped form yields `addr_test1wpscvtvh92…`,
 * and only the second matches `aiken blueprint address`. Getting this wrong
 * produces a confident, wrong address and funds that are not where the tool said.
 */
export function scriptBytes(validator: BlueprintValidator, params: unknown[] = []): string {
  const code = validator.compiledCode;
  if (!code) {
    throw new AdaError('validator_not_compiled',
      `${validator.title} has no compiledCode`, EXIT_INVALID_ARGS,
      'run `aiken build` to produce a compiled blueprint');
  }
  return applyParamsToScript(code, params as never[]);
}

/**
 * Refuse to answer for a validator whose parameters have not been applied.
 *
 * Applying parameters changes the compiled code, so it changes the hash, so it
 * changes the address. A parameterised validator has one address *per parameter
 * set* — there is no single correct answer to report, and reporting one anyway
 * is worse than refusing.
 */
export function assertParametersApplied(validator: BlueprintValidator, supplied: number): void {
  const required = validator.parameters?.length ?? 0;
  if (supplied >= required) return;

  const missing = (validator.parameters ?? []).slice(supplied)
    .map((p, i) => p.title ?? `#${supplied + i}`);
  throw new AdaError('parameters_required',
    `${validator.title} takes ${required} parameter${required === 1 ? '' : 's'}; ${supplied} supplied`,
    EXIT_INVALID_ARGS,
    `applying parameters changes the script hash and therefore the address — supply: ${missing.join(', ')}`);
}

/** Cardano's network discriminator, as MeshJS wants it for a script address. */
const discriminator = (network: NetworkName): 0 | 1 => (network === 'mainnet' ? 1 : 0);

export interface ScriptIdentity {
  /** blake2b-224 of the wrapped script — the address's payment credential, and a minting policy id. */
  hash: string;
  address: string;
  version: PlutusVersion;
}

/** Hash, address and policy id for a validator, with parameters applied. */
export function scriptIdentity(
  loaded: LoadedBlueprint,
  validator: BlueprintValidator,
  network: NetworkName,
  params: unknown[] = [],
): ScriptIdentity {
  assertParametersApplied(validator, params.length);
  const code = scriptBytes(validator, params);
  const version = loaded.version;
  return {
    hash: resolveScriptHash(code, version),
    address: serializePlutusScript({ code, version }, undefined, discriminator(network)).address,
    version,
  };
}

/** Parse `--params` as a JSON array. Kept here so every command agrees. */
export function parseParams(raw: string | undefined): unknown[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw usageError(`--params is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw usageError('--params must be a JSON array, in the order the blueprint declares them');
  }
  return parsed;
}
