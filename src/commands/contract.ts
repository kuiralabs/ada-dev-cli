// Aiken contracts — read the blueprint, and derive what a validator addresses to.
//
// The verbs are deliberately not the Midnight CLI's. On Midnight a contract is a
// stateful object: deploy creates it, calling a circuit mutates it, its state is
// read from it. On Cardano a validator is a pure predicate over
// (datum, redeemer, transaction) that holds nothing — so there is no deploy, its
// address is derived from a hash of its compiled code and exists the moment it
// compiles, and what people call "state" is the datums on UTxOs sitting at that
// address. Naming operations this chain does not have would teach the wrong model.

import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { loadConfig, resolveNetwork } from '../lib/cli-config.ts';
import { usageError } from '../lib/errors.ts';
import { writeJson } from '../lib/json-output.ts';
import {
  loadBlueprint, selectValidator, scriptIdentity, parseParams,
  splitTitle, listNames, handlersOf,
  type BlueprintValidator, type LoadedBlueprint,
} from '../lib/blueprint.ts';
import { fields, heading } from '../ui/format.ts';
import { dim, bold } from '../ui/colors.ts';

const SUBCOMMANDS = ['inspect', 'address'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export default async function contract(args: Args): Promise<void> {
  const [sub] = args.positionals;
  if (!sub) throw usageError('contract needs a subcommand', `one of: ${SUBCOMMANDS.join(', ')}`);
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw usageError(`unknown contract subcommand: ${sub}`, `one of: ${SUBCOMMANDS.join(', ')}`);
  }

  switch (sub as Subcommand) {
    case 'inspect': return inspect(args);
    case 'address': return address(args);
  }
}

/** Selection flags shared by every subcommand — the axis `aiken` itself uses. */
function selection(args: Args) {
  return { module: flagValue(args, 'module'), validator: flagValue(args, 'validator') };
}

function open(args: Args): LoadedBlueprint {
  return loadBlueprint(flagValue(args, 'blueprint'));
}

// ── inspect ──────────────────────────────────────────────────────────
//
// The counterpart of `mn contract inspect`. What it reads is different — a
// CIP-57 blueprint rather than a Compact contract-info.json — but the job is the
// same: tell me what this thing expects before I spend a fee finding out.

async function inspect(args: Args): Promise<void> {
  const loaded = open(args);
  const names = listNames(loaded.doc.validators);

  // With no selection and several validators, list them rather than guessing.
  const selected = names.length > 1 && !flagValue(args, 'module') && !flagValue(args, 'validator')
    ? undefined
    : selectValidator(loaded, selection(args));

  const summary = names.map((name) => ({ name, handlers: handlersOf(loaded.doc.validators, name) }));

  if (hasFlag(args, 'json')) {
    writeJson({
      blueprint: loaded.path,
      plutusVersion: loaded.version,
      compiler: loaded.doc.preamble.compiler ?? null,
      title: loaded.doc.preamble.title ?? null,
      validators: summary,
      ...(selected ? { selected: describe(loaded, selected) } : {}),
    });
    return;
  }

  process.stderr.write(heading('Contract') + '\n');
  process.stderr.write(fields([
    ['blueprint', loaded.path],
    ['title', loaded.doc.preamble.title ?? '(none)'],
    ['plutus', loaded.version],
    ['compiler', compilerOf(loaded)],
  ]) + '\n');

  process.stderr.write('\n' + bold('  Validators') + '\n');
  for (const v of summary) {
    process.stderr.write(`    ${v.name}  ${dim(v.handlers.join(', '))}\n`);
  }

  if (!selected) {
    process.stderr.write('\n' + dim('  Several validators — narrow with --module and --validator') + '\n');
    return;
  }

  const d = describe(loaded, selected);
  process.stderr.write('\n' + bold(`  ${d.module}.${d.validator}`) + '\n');
  process.stderr.write(fields([
    ['handlers', d.handlers.join(', ')],
    ['hash', d.hash ?? '(uncompiled)'],
    ['datum', d.datum ?? '(none)'],
    ['redeemer', d.redeemer ?? '(none)'],
  ]) + '\n');

  if (d.parameters.length > 0) {
    process.stderr.write('\n' + bold('  Parameters') + dim(' — compile-time, must be applied') + '\n');
    for (const p of d.parameters) process.stderr.write(`    ${p}\n`);
    process.stderr.write('\n' + dim('  Applying parameters changes the hash, and so the address.') + '\n');
    process.stderr.write(dim(`  Supply them: ada contract address --params '[…]'`) + '\n');
  }
}

interface Described {
  module: string;
  validator: string;
  handlers: string[];
  hash: string | null;
  datum: string | null;
  redeemer: string | null;
  parameters: string[];
}

function describe(loaded: LoadedBlueprint, v: BlueprintValidator): Described {
  const n = splitTitle(v.title);
  return {
    module: n.module,
    validator: n.validator,
    handlers: handlersOf(loaded.doc.validators, `${n.module}.${n.validator}`),
    hash: v.hash ?? null,
    datum: v.datum?.title ?? null,
    redeemer: v.redeemer?.title ?? null,
    parameters: (v.parameters ?? []).map((p, i) => p.title ?? `#${i}`),
  };
}

const compilerOf = (l: LoadedBlueprint): string => {
  const c = l.doc.preamble.compiler;
  return c ? `${c.name ?? '?'} ${c.version ?? ''}`.trim() : '(unknown)';
};

// ── address ──────────────────────────────────────────────────────────
//
// The honest replacement for `deploy`. No chain call, no fee, no transaction:
// the address is a hash of the compiled code, so it exists the moment the
// contract compiles.

async function address(args: Args): Promise<void> {
  const network = resolveNetwork(loadConfig(), flagValue(args, 'network'));
  const loaded = open(args);
  const validator = selectValidator(loaded, selection(args));
  const params = parseParams(flagValue(args, 'params'));

  // Throws `parameters_required` when a parameterised validator has unapplied
  // parameters. That refusal is the point: such a validator has one address per
  // parameter set, so any single answer would be wrong.
  const identity = scriptIdentity(loaded, validator, network.name, params);
  const n = splitTitle(validator.title);

  if (hasFlag(args, 'json')) {
    writeJson({
      network: network.name,
      blueprint: loaded.path,
      module: n.module,
      validator: n.validator,
      plutusVersion: identity.version,
      scriptHash: identity.hash,
      // For a minting validator the script hash *is* the policy id. Emitting it
      // under both names saves an agent having to know that.
      policyId: identity.hash,
      address: identity.address,
      parametersApplied: params.length,
    });
    return;
  }

  process.stderr.write(heading('Script address') + '\n');
  process.stderr.write(fields([
    ['network', network.name],
    ['validator', `${n.module}.${n.validator}`],
    ['plutus', identity.version],
    ['hash', identity.hash],
    ['policy id', identity.hash],
  ]) + '\n');
  process.stderr.write('\n' + dim('  No chain call: the address is derived from the compiled code.') + '\n\n');

  // The address alone on stdout, so `addr=$(ada contract address)` composes.
  process.stdout.write(identity.address + '\n');
}
