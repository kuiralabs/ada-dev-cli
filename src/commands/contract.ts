// Aiken contracts — read the blueprint, and derive what a validator addresses to.
//
// The verbs are deliberately not the Midnight CLI's. On Midnight a contract is a
// stateful object: deploy creates it, calling a circuit mutates it, its state is
// read from it. On Cardano a validator is a pure predicate over
// (datum, redeemer, transaction) that holds nothing — so there is no deploy, its
// address is derived from a hash of its compiled code and exists the moment it
// compiles, and what people call "state" is the datums on UTxOs sitting at that
// address. Naming operations this chain does not have would teach the wrong model.

import { mConStr0, deserializeAddress, stringToHex, type UTxO } from '@meshsdk/core';
import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { loadConfig, resolveNetwork } from '../lib/cli-config.ts';
import { usageError, AdaError } from '../lib/errors.ts';
import { EXIT_CHAIN_REJECTED } from '../lib/exit-codes.ts';
import { writeJson } from '../lib/json-output.ts';
import { openActive, type ActiveContext } from '../lib/active-wallet.ts';
import { makeTxBuilder, makeEvaluator, withoutCostModelNoise } from '../lib/mesh.ts';
import { signAndSubmit, translateBuildFailure, selectCollateral, assertMeetsMinValue } from '../lib/tx-common.ts';
import { adaToLovelace, formatAda, LOVELACE_UNIT } from '../lib/amount.ts';
import {
  loadBlueprint, selectValidator, scriptIdentity, scriptBytes, parseParams,
  splitTitle, listNames, handlersOf,
  type BlueprintValidator, type LoadedBlueprint,
} from '../lib/blueprint.ts';
import { fields, heading } from '../ui/format.ts';
import { dim, bold } from '../ui/colors.ts';

const SUBCOMMANDS = ['inspect', 'address', 'lock', 'unlock'] as const;
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
    case 'lock': return lock(args);
    case 'unlock': return unlock(args);
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

// ── lock ─────────────────────────────────────────────────────────────
//
// Pay funds to a script address, with a datum attached. This is how "state"
// comes into existence on this chain: not by writing to a contract, but by
// creating an output that sits at the validator's address carrying data.

async function lock(args: Args): Promise<void> {
  const ctx = await openActive(args);
  const loaded = open(args);
  const validator = selectValidator(loaded, selection(args));
  const identity = scriptIdentity(loaded, validator, ctx.network.name, parseParams(flagValue(args, 'params')));

  const amount = flagValue(args, 'amount');
  if (!amount) throw usageError('lock needs --amount <ada>', 'example: --amount 5');
  const lovelace = adaToLovelace(amount);

  const datum = buildDatum(args, ctx);
  const output = { address: identity.address, amount: [{ unit: LOVELACE_UNIT, quantity: lovelace.toString() }] };

  // The chain refuses an output holding less ADA than its size demands. Checking
  // here means a dry run cannot approve something the chain will reject.
  const params = await ctx.provider.fetchProtocolParameters();
  assertMeetsMinValue(output.address, output.amount, params.coinsPerUtxoSize);

  const utxos = await ctx.wallet.getUtxos();
  const builder = makeTxBuilder(ctx.provider); // a lock is a plain payment — no script runs
  let unsigned: string;
  try {
    unsigned = await withoutCostModelNoise(() => builder
      .txOut(output.address, output.amount)
      // Inline (CIP-32), not a datum hash. A hash-stored datum cannot be recovered
      // from the chain — the spender must already hold it — and the devnet indexer
      // serves no datum-by-hash lookup at all.
      .txOutInlineDatumValue(datum.value as never)
      .changeAddress(ctx.payment)
      .selectUtxosFrom(utxos)
      .complete());
  } catch (err) {
    throw translateBuildFailure(err, {
      what: `lock ${formatAda(lovelace)} ADA at ${identity.address}`,
      minValueHint: 'a script output must still hold the minimum ADA its size demands',
    });
  }

  const submitted = hasFlag(args, 'yes');
  const txHash = submitted ? await signAndSubmit(ctx, unsigned) : null;

  if (hasFlag(args, 'json')) {
    writeJson({
      network: ctx.network.name, wallet: ctx.stored.name,
      scriptAddress: identity.address, scriptHash: identity.hash,
      ada: formatAda(lovelace), lovelace: lovelace.toString(),
      datum: datum.describe, datumEncoding: 'inline',
      submitted, ...(txHash ? { txHash } : {}),
    });
    return;
  }

  process.stderr.write(heading(submitted ? 'Locked' : 'Lock (dry run)') + '\n');
  process.stderr.write(fields([
    ['network', ctx.network.name],
    ['from', ctx.stored.name],
    ['to script', identity.address],
    ['amount', `${formatAda(lovelace)} ADA`],
    ['datum', datum.describe],
  ]) + '\n');
  if (!submitted) {
    process.stderr.write('\n' + dim('  Nothing submitted. Add --yes to send it.') + '\n');
    return;
  }
  process.stderr.write('\n');
  process.stdout.write(txHash + '\n');
}

/**
 * The datum to attach.
 *
 * `--datum-signer` is the common case made easy: a datum of one field holding
 * the wallet's own public key hash, which is what an ownership-checking
 * validator like hello_world expects. `--datum` takes raw JSON for anything else.
 */
function buildDatum(args: Args, ctx: ActiveContext): { value: unknown; describe: string } {
  const raw = flagValue(args, 'datum');
  if (raw) {
    try {
      return { value: JSON.parse(raw), describe: raw };
    } catch (err) {
      throw usageError(`--datum is not valid JSON: ${(err as Error).message}`);
    }
  }
  if (hasFlag(args, 'datum-signer')) {
    const hash = pubKeyHashOf(ctx);
    return { value: mConStr0([hash]), describe: `constructor 0 [${hash.slice(0, 16)}…] (my key hash)` };
  }
  throw usageError('lock needs a datum',
    'use --datum-signer for a datum holding your own key hash, or --datum <json>');
}

const pubKeyHashOf = (ctx: ActiveContext): string => deserializeAddress(ctx.payment).pubKeyHash;

// ── unlock ───────────────────────────────────────────────────────────
//
// Spend a UTxO sitting at a script address, supplying a redeemer. **This is the
// call.** There is no other way to run a validator: it executes as part of
// validating the transaction that consumes its output, and it either approves or
// the whole transaction is rejected.

async function unlock(args: Args): Promise<void> {
  const ctx = await openActive(args);
  const loaded = open(args);
  const validator = selectValidator(loaded, selection(args));
  const params = parseParams(flagValue(args, 'params'));
  const identity = scriptIdentity(loaded, validator, ctx.network.name, params);
  const code = scriptBytes(validator, params);

  const target = await resolveScriptUtxo(args, ctx, identity.address);
  const redeemer = buildRedeemer(args);

  const utxos = await ctx.wallet.getUtxos();
  const protocol = await ctx.provider.fetchProtocolParameters();
  // Collateral is only forfeited when a script fails after the cheap checks pass,
  // and it must be pure ADA. Selected explicitly because nothing selects it for
  // you, and because once a wallet holds native assets the obvious candidates
  // stop qualifying — a failure that looks nothing like its cause.
  const collateral = selectCollateral(utxos, adaToLovelace('5'));

  // The evaluator runs the Plutus VM to discover the execution budget this script
  // needs, because the ledger requires that budget declared up front.
  const evaluator = await makeEvaluator(ctx.provider, ctx.network);

  let unsigned: string;
  try {
    unsigned = await withoutCostModelNoise(() => makeTxBuilder(ctx.provider, { withScripts: true, evaluator })
      .spendingPlutusScript(identity.version)
      .txIn(target.input.txHash, target.input.outputIndex, target.output.amount, target.output.address)
      .txInScript(code)
      .txInRedeemerValue(redeemer.value as never)
      .txInInlineDatumPresent()
      // Validators commonly check for a signature; supplying it is harmless when
      // they do not, and the transaction is unprovable without it when they do.
      .requiredSignerHash(pubKeyHashOf(ctx))
      .txInCollateral(collateral.input.txHash, collateral.input.outputIndex,
                      collateral.output.amount, collateral.output.address)
      .changeAddress(ctx.payment)
      .selectUtxosFrom(utxos)
      .complete());
  } catch (err) {
    throw translateScriptFailure(err, identity.address);
  }

  const submitted = hasFlag(args, 'yes');
  const txHash = submitted ? await signAndSubmit(ctx, unsigned) : null;
  const recovered = target.output.amount.find((a) => a.unit === LOVELACE_UNIT)?.quantity ?? '0';

  if (hasFlag(args, 'json')) {
    writeJson({
      network: ctx.network.name, wallet: ctx.stored.name,
      scriptAddress: identity.address, scriptHash: identity.hash,
      spending: `${target.input.txHash}#${target.input.outputIndex}`,
      ada: formatAda(BigInt(recovered)), lovelace: recovered,
      redeemer: redeemer.describe,
      collateral: `${collateral.input.txHash}#${collateral.input.outputIndex}`,
      submitted, ...(txHash ? { txHash } : {}),
    });
    return;
  }

  process.stderr.write(heading(submitted ? 'Unlocked' : 'Unlock (dry run)') + '\n');
  process.stderr.write(fields([
    ['network', ctx.network.name],
    ['to', ctx.stored.name],
    ['spending', `${target.input.txHash.slice(0, 16)}…#${target.input.outputIndex}`],
    ['amount', `${formatAda(BigInt(recovered))} ADA`],
    ['redeemer', redeemer.describe],
    ['collateral', `${collateral.input.txHash.slice(0, 16)}…#${collateral.input.outputIndex}`],
  ]) + '\n');
  if (!submitted) {
    process.stderr.write('\n' + dim('  Nothing submitted. Add --yes to send it.') + '\n');
    process.stderr.write(dim('  The validator already ran: a build that succeeds means it approved.') + '\n');
    return;
  }
  process.stderr.write('\n');
  process.stdout.write(txHash + '\n');
}

/** Which UTxO at the script address to spend. */
async function resolveScriptUtxo(args: Args, ctx: ActiveContext, scriptAddress: string): Promise<UTxO> {
  const at = await ctx.provider.fetchAddressUTxOs(scriptAddress);
  if (at.length === 0) {
    throw new AdaError('nothing_locked', `no UTxO at ${scriptAddress}`, EXIT_CHAIN_REJECTED,
      'lock funds there first: ada contract lock --amount 5 --datum-signer --yes');
  }

  const ref = flagValue(args, 'tx-in');
  if (!ref) {
    if (at.length > 1) {
      throw usageError(`${at.length} UTxOs sit at the script address`,
        `choose one with --tx-in <hash>#<index>: ${at.map(refOf).join(', ')}`);
    }
    return at[0];
  }

  const found = at.find((u) => refOf(u) === ref);
  if (!found) {
    throw usageError(`${ref} is not at the script address`, `available: ${at.map(refOf).join(', ')}`);
  }
  return found;
}

const refOf = (u: UTxO): string => `${u.input.txHash}#${u.input.outputIndex}`;

function buildRedeemer(args: Args): { value: unknown; describe: string } {
  const message = flagValue(args, 'redeemer-message');
  if (message !== undefined) {
    return { value: mConStr0([stringToHex(message)]), describe: `constructor 0 ["${message}"]` };
  }
  const raw = flagValue(args, 'redeemer');
  if (!raw) {
    throw usageError('unlock needs a redeemer',
      'use --redeemer-message <text> for a one-field message, or --redeemer <json>');
  }
  try {
    return { value: JSON.parse(raw), describe: raw };
  } catch (err) {
    throw usageError(`--redeemer is not valid JSON: ${(err as Error).message}`);
  }
}

/**
 * Turn a script failure into something actionable.
 *
 * A rejected validator is the single most common failure here and the one where
 * a raw builder error helps least — it arrives as "Evaluate redeemers failed"
 * followed by a wall of CBOR.
 */
function translateScriptFailure(err: unknown, scriptAddress: string): AdaError {
  const message = err instanceof Error ? err.message : String(err);

  if (/evaluate redeemers failed|validation failure|script.*fail/i.test(message)) {
    return new AdaError('script_rejected',
      'the validator rejected this transaction',
      EXIT_CHAIN_REJECTED,
      'the datum, the redeemer, or a condition on the transaction itself did not satisfy it — '
      + 'check the redeemer against `ada contract inspect`, and that you are signing with the key the datum names');
  }
  if (/exceeded|budget|ExUnits|max.*ex/i.test(message)) {
    return new AdaError('budget_exceeded',
      'the script needs more execution units than a transaction may use',
      EXIT_CHAIN_REJECTED,
      'this is not insufficient funds — the validator itself is too expensive for one transaction');
  }
  return translateBuildFailure(err, {
    what: `unlock from ${scriptAddress}`,
    detail: 'the transaction could not be built',
  });
}
