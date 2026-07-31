// Aiken contracts — read the blueprint, and derive what a validator addresses to.
//
// The verbs are deliberately not the Midnight CLI's. On Midnight a contract is a
// stateful object: deploy creates it, calling a circuit mutates it, its state is
// read from it. On Cardano a validator is a pure predicate over
// (datum, redeemer, transaction) that holds nothing — so there is no deploy, its
// address is derived from a hash of its compiled code and exists the moment it
// compiles, and what people call "state" is the datums on UTxOs sitting at that
// address. Naming operations this chain does not have would teach the wrong model.

import type { UTxO, MeshTxBuilder } from '@meshsdk/core';
import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { loadConfig, resolveNetwork } from '../lib/cli-config.ts';
import { usageError, AdaError } from '../lib/errors.ts';
import { EXIT_CHAIN_REJECTED } from '../lib/exit-codes.ts';
import { writeJson } from '../lib/json-output.ts';
import { openActive, type ActiveContext } from '../lib/active-wallet.ts';
import { makeTxBuilder, makeEvaluator, costModelsFor, withoutCostModelNoise, type Provider } from '../lib/mesh.ts';
import { signAndSubmit, translateBuildFailure, translateHorizon, selectCollateral, requiredCollateral, assertMeetsMinValue } from '../lib/tx-common.ts';
import { adaToLovelace, formatAda, parseSignedQuantity, LOVELACE_UNIT } from '../lib/amount.ts';
import { resolveValidity, assertValidityShape, parseOutputRefs, parseSigners, type ValidityWindow } from '../lib/validity.ts';
import { fetchTip } from '../lib/mesh.ts';
import { assertAssetName } from './asset.ts';

import {
  loadBlueprint, selectValidator, scriptIdentity, scriptBytes, parseParams,
  checkAgainstSchema, describeExpected,
  type ScriptIdentity,
  splitTitle, listNames, handlersOf,
  type BlueprintValidator, type LoadedBlueprint,
} from '../lib/blueprint.ts';
import { runAiken } from '../lib/aiken.ts';
import { fields, heading } from '../ui/format.ts';
import { dim, bold } from '../ui/colors.ts';

const SUBCOMMANDS = ['build', 'check', 'inspect', 'address', 'utxos', 'lock', 'unlock', 'simulate', 'publish', 'mint'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

export default async function contract(args: Args): Promise<void> {
  const [sub] = args.positionals;
  if (!sub) throw usageError('contract needs a subcommand', `one of: ${SUBCOMMANDS.join(', ')}`);
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw usageError(`unknown contract subcommand: ${sub}`, `one of: ${SUBCOMMANDS.join(', ')}`);
  }

  switch (sub as Subcommand) {
    case 'build': return delegate(args, 'build');
    case 'check': return delegate(args, 'check');
    case 'utxos': return utxos(args);
    case 'inspect': return inspect(args);
    case 'address': return address(args);
    case 'lock': return lock(args);
    case 'unlock': return unlock(args);
    case 'simulate': return simulate(args);
    case 'publish': return publish(args);
    case 'mint': return mint(args);
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

  const datum = await buildDatum(args, ctx, loaded, validator);
  const output = { address: identity.address, amount: [{ unit: LOVELACE_UNIT, quantity: lovelace.toString() }] };

  // The chain refuses an output holding less ADA than its size demands. Checking
  // here means a dry run cannot approve something the chain will reject.
  const params = await ctx.provider.fetchProtocolParameters();
  assertMeetsMinValue(output.address, output.amount, params.coinsPerUtxoSize);

  const validity = await scriptlessValidity(args, ctx);
  const utxos = await ctx.wallet.getUtxos();

  // Inline (CIP-32) by default: the datum travels on the output, so anyone can
  // read it back. A hash-stored datum is never published — the spender must
  // already hold it, and the devnet indexer serves no lookup for one. The
  // encoding is supported anyway because the reference Aiken example uses it and
  // a UTxO created by another tool may well carry one.
  const asHash = hasFlag(args, 'datum-hash');

  const builder = makeTxBuilder(ctx.provider); // a lock is a plain payment — no script runs
  let unsigned: string;
  try {
    const b = builder.txOut(output.address, output.amount);
    if (asHash) b.txOutDatumHashValue(datum.value as never);
    else b.txOutInlineDatumValue(datum.value as never);
    applyExtras(b, { readOnly: [], signers: [], validity });

    unsigned = await withoutCostModelNoise(() => b
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
      datum: datum.describe, datumEncoding: asHash ? 'hash' : 'inline',
      ...(describeWindow(validity) ? { validity: describeWindow(validity) } : {}),
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
    ['encoding', asHash ? 'hash — keep the datum, the chain will not store it' : 'inline'],
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
async function buildDatum(
  args: Args, ctx: ActiveContext, loaded: LoadedBlueprint, validator: BlueprintValidator,
): Promise<{ value: unknown; describe: string }> {
  const raw = flagValue(args, 'datum');
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw usageError(`--datum is not valid JSON: ${(err as Error).message}`);
    }
    // The blueprint declares this shape, so a mismatch is knowable now rather
    // than after the chain has rejected a transaction we paid to submit.
    checkAgainstSchema(parsed, validator.datum?.schema, loaded, '--datum');
    return { value: parsed, describe: raw };
  }
  if (hasFlag(args, 'datum-signer')) {
    const hash = await pubKeyHashOf(ctx);
    const { mConStr0 } = await mesh();
    return { value: mConStr0([hash]), describe: `constructor 0 [${hash.slice(0, 16)}…] (my key hash)` };
  }
  const expected = describeExpected(validator.datum?.schema, loaded);
  throw usageError('lock needs a datum',
    expected
      ? `this validator expects ${expected} — use --datum-signer for your own key hash, or --datum <json>`
      : 'use --datum-signer for a datum holding your own key hash, or --datum <json>');
}

let meshData: typeof import('@meshsdk/core') | undefined;
/** Mesh's data helpers, loaded only on the paths that build a transaction. The
 *  read-only subcommands need none of them, and the module is not cheap. */
const mesh = async () => (meshData ??= await import('@meshsdk/core'));

const pubKeyHashOf = async (ctx: ActiveContext): Promise<string> =>
  (await mesh()).deserializeAddress(ctx.payment).pubKeyHash;


// ── the spend, built once ────────────────────────────────────────────
//
// `unlock` and `simulate` must produce the **same** transaction. Simulate exists
// to answer "what will unlock cost", so if the two ever built different things it
// would be reporting a number for a transaction nobody submits — a wrong answer
// delivered confidently, which is worse than no answer. Building it in one place
// makes divergence impossible rather than merely unlikely.

interface SpendContext {
  identity: ScriptIdentity;
  code: string;
  target: UTxO;
  redeemer: { value: unknown; describe: string };
  datumMode: { inline: boolean; value?: unknown };
  collateral: UTxO;
  utxos: UTxO[];
  protocol: Awaited<ReturnType<Provider['fetchProtocolParameters']>>;
  evaluator: Awaited<ReturnType<typeof makeEvaluator>>;
  /** The chain's, for the script integrity hash the ledger checks. */
  costModels?: number[][];
  extras: TxExtras;
}

/**
 * Capabilities a real validator commonly needs, and without which a contract
 * surface cannot express the usual patterns.
 */
interface TxExtras {
  /** CIP-31 reference inputs: read a UTxO's value and datum without spending it. */
  readOnly: { txHash: string; index: number }[];
  /** The window in slots during which the transaction may be accepted. */
  validity: ValidityWindow;
  /** Other parties whose signature the validator requires. */
  signers: string[];
}

interface ExtraFlags {
  readOnly: { txHash: string; index: number }[];
  signers: string[];
  from?: string;
  until?: string;
  forDuration?: string;
  needsTip: boolean;
}

/** Everything checkable without a chain. Throws on malformed input. */
function readExtraFlags(args: Args): ExtraFlags {
  const from = flagValue(args, 'valid-from');
  const until = flagValue(args, 'valid-until');
  const forDuration = flagValue(args, 'valid-for');
  const needsTip = forDuration !== undefined || from?.trim().toLowerCase() === 'now';

  // Everything checkable without a chain, checked now. Only the slot arithmetic
  // waits for the tip.
  assertValidityShape({ from, until, forDuration });
  if (!needsTip) resolveValidity({ from, until, forDuration }, 0);

  return {
    readOnly: parseOutputRefs(flagValue(args, 'read-only'), '--read-only'),
    signers: parseSigners(flagValue(args, 'signer')),
    from, until, forDuration, needsTip,
  };
}

/**
 * Turn a duration into a slot, anchored to the chain.
 *
 * A window derived from the local clock is a window the chain may disagree
 * with: a machine a few seconds fast produces a transaction that is not yet
 * valid, one a few seconds slow produces one already expired, and both fail in
 * ways that look like anything but a clock.
 */
async function anchorValidity(flags: ExtraFlags, ctx: ActiveContext): Promise<TxExtras> {
  const tipSlot = flags.needsTip ? (await fetchTip(ctx.provider)).slot ?? 0 : 0;
  return {
    readOnly: flags.readOnly,
    signers: flags.signers,
    validity: resolveValidity(
      { from: flags.from, until: flags.until, forDuration: flags.forDuration }, tipSlot),
  };
}

/**
 * The validity window alone, for transactions that run no script.
 *
 * A window bounds *any* transaction, so `lock` and `publish` accept it. Reference
 * inputs and extra signers only mean something to a validator, so passing them
 * where none runs is a mistake worth naming rather than ignoring — silently
 * dropping a flag someone typed is how a security assumption goes missing.
 */
async function scriptlessValidity(args: Args, ctx: ActiveContext): Promise<ValidityWindow> {
  for (const [flag, why] of [
    ['read-only', 'reference inputs are read by a validator, and none runs here'],
    ['signer', 'extra signers are checked by a validator, and none runs here'],
  ] as const) {
    if (flagValue(args, flag) !== undefined) {
      throw usageError(`--${flag} has no effect on this command`, why);
    }
  }
  const flags = readExtraFlags(args);
  return (await anchorValidity(flags, ctx)).validity;
}

/** How a window reads in output. Slots are meaningless without saying so. */
const describeWindow = (w: ValidityWindow): Record<string, number> | undefined =>
  w.invalidBefore === undefined && w.invalidHereafter === undefined
    ? undefined
    : {
      ...(w.invalidBefore !== undefined ? { fromSlot: w.invalidBefore } : {}),
      ...(w.invalidHereafter !== undefined ? { untilSlot: w.invalidHereafter } : {}),
    };

/** Apply the extras to a builder. One definition, so every command agrees. */
function applyExtras(b: MeshTxBuilder, extras: TxExtras): MeshTxBuilder {
  for (const r of extras.readOnly) b.readOnlyTxInReference(r.txHash, r.index);
  for (const hash of extras.signers) b.requiredSignerHash(hash);
  if (extras.validity.invalidBefore !== undefined) b.invalidBefore(extras.validity.invalidBefore);
  if (extras.validity.invalidHereafter !== undefined) b.invalidHereafter(extras.validity.invalidHereafter);
  return b;
}

/** Everything a script spend needs, resolved once. */
async function prepareSpend(args: Args, ctx: ActiveContext): Promise<SpendContext> {
  const loaded = open(args);
  const validator = selectValidator(loaded, selection(args));
  const params = parseParams(flagValue(args, 'params'));
  const identity = scriptIdentity(loaded, validator, ctx.network.name, params);
  const code = scriptBytes(validator, params);

  // Argument validation before any network call. A missing or malformed redeemer
  // is knowable without asking a chain anything, and making someone wait for a
  // round trip to be told they forgot a flag is both slower and less clear.
  const redeemer = await buildRedeemer(args, loaded, validator);
  // Every flag that can be checked without asking a chain anything, checked
  // here. A malformed --signer or an impossible validity window is knowable
  // now, and reporting "20 UTxOs sit at the script address" instead is both
  // slower and about the wrong thing entirely.
  const extraFlags = readExtraFlags(args);
  const target = await resolveScriptUtxo(args, ctx, identity.address);

  // How the datum is stored decides how it must be supplied back. An inline datum
  // (CIP-32) travels on the output and the builder just points at it; a datum
  // stored as a hash was never published, so the spender must already hold it.
  const datumMode = datumModeOf(target, flagValue(args, 'datum'));

  const utxos = await ctx.wallet.getUtxos();
  const protocol = await ctx.provider.fetchProtocolParameters();
  const collateral = pledgeCollateral(utxos, protocol);
  const evaluator = await makeEvaluator(ctx.provider, ctx.network);
  const { models: costModels } = await costModelsFor(ctx.network);
  const extras = await anchorValidity(extraFlags, ctx);

  return { identity, code, target, redeemer, datumMode, collateral, utxos, protocol, evaluator, costModels, extras };
}

/** Build the spending transaction. One definition, two callers. */
async function buildSpend(ctx: ActiveContext, spend: SpendContext): Promise<string> {
  const signerHash = await pubKeyHashOf(ctx);
  try {
    const b = makeTxBuilder(ctx.provider, { withScripts: true, evaluator: spend.evaluator, costModels: spend.costModels })
      .spendingPlutusScript(spend.identity.version)
      .txIn(spend.target.input.txHash, spend.target.input.outputIndex,
            spend.target.output.amount, spend.target.output.address)
      .txInScript(spend.code)
      .txInRedeemerValue(spend.redeemer.value as never);

    if (spend.datumMode.inline) b.txInInlineDatumPresent();
    else b.txInDatumValue(spend.datumMode.value as never);

    applyExtras(b, spend.extras);

    return await withoutCostModelNoise(() => b
      // Validators commonly check for a signature; supplying it is harmless when
      // they do not, and the transaction is unprovable without it when they do.
      .requiredSignerHash(signerHash)
      .txInCollateral(spend.collateral.input.txHash, spend.collateral.input.outputIndex,
                      spend.collateral.output.amount, spend.collateral.output.address)
      .changeAddress(ctx.payment)
      .selectUtxosFrom(spend.utxos)
      .complete());
  } catch (err) {
    throw translateScriptFailure(err, spend.identity.address);
  }
}

/**
 * Choose a UTxO to pledge as collateral, sized from the chain's own fee model.
 *
 * Shared by every command that runs a script, so the amount and the selection
 * rule cannot drift between them.
 */
function pledgeCollateral(
  utxos: UTxO[],
  protocol: { minFeeA: number; minFeeB: number; maxTxSize: number; collateralPercent: number },
): UTxO {
  return selectCollateral(utxos, requiredCollateral({
    minFeeA: protocol.minFeeA, minFeeB: protocol.minFeeB,
    maxTxSize: protocol.maxTxSize, collateralPercent: protocol.collateralPercent,
  }));
}

// ── unlock ───────────────────────────────────────────────────────────
//
// Spend a UTxO sitting at a script address, supplying a redeemer. **This is the
// call.** There is no other way to run a validator: it executes as part of
// validating the transaction that consumes its output, and it either approves or
// the whole transaction is rejected.

async function unlock(args: Args): Promise<void> {
  const ctx = await openActive(args);
  const spend = await prepareSpend(args, ctx);
  const { identity, target, redeemer, datumMode, collateral } = spend;
  const unsigned = await buildSpend(ctx, spend);

  const submitted = hasFlag(args, 'yes');
  const txHash = submitted ? await signAndSubmit(ctx, unsigned) : null;
  const recovered = target.output.amount.find((a) => a.unit === LOVELACE_UNIT)?.quantity ?? '0';

  if (hasFlag(args, 'json')) {
    writeJson({
      network: ctx.network.name, wallet: ctx.stored.name,
      scriptAddress: identity.address, scriptHash: identity.hash,
      spending: refOf(target),
      ada: formatAda(BigInt(recovered)), lovelace: recovered,
      redeemer: redeemer.describe,
      datumEncoding: datumMode.inline ? 'inline' : 'hash',
      // The window was resolved against the chain tip, so the caller does not
      // otherwise know which slots "30m" became.
      ...(describeWindow(spend.extras.validity) ? { validity: describeWindow(spend.extras.validity) } : {}),
      ...(spend.extras.readOnly.length ? { readOnly: spend.extras.readOnly.map((r) => `${r.txHash}#${r.index}`) } : {}),
      ...(spend.extras.signers.length ? { requiredSigners: spend.extras.signers } : {}),
      collateral: refOf(collateral),
      submitted, ...(txHash ? { txHash } : {}),
    });
    return;
  }

  process.stderr.write(heading(submitted ? 'Unlocked' : 'Unlock (dry run)') + '\n');
  process.stderr.write(fields([
    ['network', ctx.network.name],
    ['to', ctx.stored.name],
    ['spending', shortRef(target)],
    ['amount', `${formatAda(BigInt(recovered))} ADA`],
    ['redeemer', redeemer.describe],
    ['collateral', shortRef(collateral)],
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
const shortRef = (u: UTxO): string => `${u.input.txHash.slice(0, 16)}…#${u.input.outputIndex}`;

/**
 * Decide how to hand the datum back to the validator.
 *
 * No chain publishes the preimage of a hash-stored datum, and the devnet indexer
 * serves no lookup for one, so there is nowhere to fetch it from. Demanding it up
 * front is the honest behaviour — the alternative is a build that appears to work
 * and is rejected at submission.
 */
export function datumModeOf(utxo: UTxO, supplied: string | undefined): { inline: boolean; value?: unknown } {
  const out = utxo.output as { plutusData?: string | null; dataHash?: string | null };
  if (out.plutusData) return { inline: true };

  if (!out.dataHash) {
    throw new AdaError('no_datum', `${refOf(utxo)} carries no datum`, EXIT_CHAIN_REJECTED,
      'a spending validator is given a datum; this output has none, so it cannot be spent by one');
  }

  if (!supplied) {
    throw new AdaError('datum_required',
      `${refOf(utxo)} stores its datum as a hash, not inline`, EXIT_CHAIN_REJECTED,
      'the chain never published the datum itself, so it cannot be recovered — pass the original with --datum <json>');
  }
  try {
    return { inline: false, value: JSON.parse(supplied) };
  } catch (err) {
    throw usageError(`--datum is not valid JSON: ${(err as Error).message}`);
  }
}

async function buildRedeemer(
  args: Args, loaded: LoadedBlueprint, validator: BlueprintValidator,
): Promise<{ value: unknown; describe: string }> {
  const schema = validator.redeemer?.schema;
  const message = flagValue(args, 'redeemer-message');
  if (message !== undefined) {
    const { mConStr0, stringToHex } = await mesh();
    const value = mConStr0([stringToHex(message)]);
    checkAgainstSchema(value, schema, loaded, '--redeemer-message');
    return { value, describe: `constructor 0 ["${message}"]` };
  }
  const raw = flagValue(args, 'redeemer');
  if (!raw) {
    const expected = describeExpected(schema, loaded);
    throw usageError('needs a redeemer',
      expected
        ? `this validator expects ${expected} — use --redeemer <json>, or --redeemer-message <text> for a single text field`
        : 'use --redeemer-message <text> for a one-field message, or --redeemer <json>');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw usageError(`--redeemer is not valid JSON: ${(err as Error).message}`);
  }
  checkAgainstSchema(parsed, schema, loaded, '--redeemer');
  return { value: parsed, describe: raw };
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

  const horizon = translateHorizon(message);
  if (horizon) return horizon;

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

// ── build / check ────────────────────────────────────────────────────
//
// Delegated to `aiken`, which owns compilation and the validator's own tests.
// The same rule already applied to derivation: where an authoritative
// implementation exists, this tool makes it convenient rather than
// reimplementing it and disagreeing.

async function delegate(args: Args, subcommand: 'build' | 'check'): Promise<void> {
  const dir = flagValue(args, 'path') ?? process.cwd();
  const extra = args.positionals.slice(1);

  // Both halves of aiken's output are collected — the JSON report, and the
  // diagnostic it renders only to a terminal. See runAiken.
  const wantsJson = hasFlag(args, 'json');
  const { report, version } = runAiken([subcommand, ...extra], dir);
  const tests = report?.summary;

  if (wantsJson) {
    writeJson({
      ran: `aiken ${subcommand}`,
      compiler: version,
      directory: dir,
      ...(tests ? { tests: { total: tests.total, passed: tests.passed, failed: tests.failed } } : {}),
      ...(subcommand === 'build' ? { blueprint: `${dir.replace(/\/$/, '')}/plutus.json` } : {}),
    });
    return;
  }

  if (subcommand === 'build') {
    process.stderr.write('\n' + dim('  Wrote plutus.json. Next: ada contract inspect') + '\n');
  }
}

// ── utxos ────────────────────────────────────────────────────────────
//
// What sits at a script address. **This is the state.** A validator holds
// nothing, so the only thing that persists is the outputs at its address and
// the datums attached to them — which is why this is a listing rather than a
// single object with fields.

async function utxos(args: Args): Promise<void> {
  const ctx = await openActive(args);
  const loaded = open(args);
  const validator = selectValidator(loaded, selection(args));
  const identity = scriptIdentity(loaded, validator, ctx.network.name, parseParams(flagValue(args, 'params')));

  const at = await ctx.provider.fetchAddressUTxOs(identity.address);
  const entries = at.map((u) => {
    const out = u.output as { plutusData?: string | null; dataHash?: string | null };
    const lovelace = u.output.amount.find((a) => a.unit === LOVELACE_UNIT)?.quantity ?? '0';
    return {
      ref: refOf(u),
      lovelace,
      ada: formatAda(BigInt(lovelace)),
      assets: u.output.amount.filter((a) => a.unit !== LOVELACE_UNIT)
        .map((a) => ({ unit: a.unit, quantity: a.quantity })),
      // Inline datums are readable; a hash-stored one is not, anywhere, so saying
      // which it is tells the caller whether they need to supply it to spend.
      datumEncoding: out.plutusData ? 'inline' : out.dataHash ? 'hash' : 'none',
      datum: out.plutusData ?? null,
      datumHash: out.dataHash ?? null,
    };
  });

  const total = entries.reduce((sum, e) => sum + BigInt(e.lovelace), 0n);

  if (hasFlag(args, 'json')) {
    writeJson({
      network: ctx.network.name,
      scriptAddress: identity.address,
      scriptHash: identity.hash,
      count: entries.length,
      totalLovelace: total.toString(),
      totalAda: formatAda(total),
      utxos: entries,
    });
    return;
  }

  process.stderr.write(heading('Script UTxOs') + '\n');
  process.stderr.write(fields([
    ['network', ctx.network.name],
    ['address', identity.address],
    ['count', String(entries.length)],
    ['total', formatAda(total)],
  ]) + '\n');

  if (entries.length === 0) {
    process.stderr.write('\n' + dim('  Nothing locked here yet.') + '\n');
    return;
  }

  process.stderr.write('\n');
  for (const e of entries) {
    process.stderr.write(`  ${e.ref}\n`);
    process.stderr.write(`    ${e.ada}  ${dim(e.datumEncoding === 'inline' ? 'inline datum'
      : e.datumEncoding === 'hash' ? 'datum hash — supply the original to spend' : 'no datum')}\n`);
    for (const a of e.assets) process.stderr.write(`    ${dim(`${a.quantity} × ${a.unit}`)}\n`);
  }
  process.stderr.write('\n');
}

// ── simulate ─────────────────────────────────────────────────────────
//
// What a script costs, without paying for it.
//
// The ledger requires an execution budget declared up front. Too low and the
// script aborts mid-run and the collateral is forfeited; too high and you overpay
// or breach the per-transaction cap. The only way to know the number is to run
// the validator, so this runs it and reports rather than submitting.

async function simulate(args: Args): Promise<void> {
  const ctx = await openActive(args);
  const spend = await prepareSpend(args, ctx);
  const { identity, target, protocol, evaluator } = spend;
  // The very same transaction `unlock` would submit — that is what makes the
  // number below an answer about unlock rather than about something adjacent.
  const unsigned = await buildSpend(ctx, spend);

  // Ask the evaluator directly. The builder already used it to fill in the
  // budget; this is the same question asked so the number can be reported.
  const actions = await withoutCostModelNoise(() => evaluator.evaluateTx(unsigned, [], []));
  const used = actions.reduce(
    (acc, a) => ({ mem: acc.mem + Number(a.budget.mem), steps: acc.steps + Number(a.budget.steps) }),
    { mem: 0, steps: 0 },
  );

  const maxMem = Number(protocol.maxTxExMem);
  const maxSteps = Number(protocol.maxTxExSteps);
  const pct = (n: number, max: number) => (max > 0 ? Math.round((n / max) * 1000) / 10 : 0);
  // Script execution is priced separately from size, and this is the part a
  // contract author controls.
  const scriptFee = Math.ceil(used.mem * Number(protocol.priceMem) + used.steps * Number(protocol.priceStep));
  const sizeBytes = Math.floor(unsigned.length / 2);

  if (hasFlag(args, 'json')) {
    writeJson({
      network: ctx.network.name,
      scriptAddress: identity.address,
      spending: refOf(target),
      redeemers: actions.map((a) => ({ tag: a.tag, index: a.index, mem: Number(a.budget.mem), steps: Number(a.budget.steps) })),
      executionUnits: { mem: used.mem, steps: used.steps },
      limits: { maxMem, maxSteps },
      usage: { memPercent: pct(used.mem, maxMem), stepsPercent: pct(used.steps, maxSteps) },
      scriptFeeLovelace: String(scriptFee),
      txSizeBytes: sizeBytes,
      maxTxSize: protocol.maxTxSize,
      ...(describeWindow(spend.extras.validity) ? { validity: describeWindow(spend.extras.validity) } : {}),
      withinLimits: used.mem <= maxMem && used.steps <= maxSteps && sizeBytes <= protocol.maxTxSize,
    });
    return;
  }

  process.stderr.write(heading('Simulation') + '\n');
  process.stderr.write(fields([
    ['spending', refOf(target)],
    ['memory', `${used.mem.toLocaleString()} / ${maxMem.toLocaleString()}  (${pct(used.mem, maxMem)}%)`],
    ['steps', `${used.steps.toLocaleString()} / ${maxSteps.toLocaleString()}  (${pct(used.steps, maxSteps)}%)`],
    ['script fee', `${formatAda(BigInt(scriptFee))}`],
    ['tx size', `${sizeBytes} / ${protocol.maxTxSize} bytes`],
  ]) + '\n');
  process.stderr.write('\n' + dim('  Nothing submitted. The validator ran and approved.') + '\n\n');
}

// ── publish ──────────────────────────────────────────────────────────
//
// A CIP-33 reference script: the validator's bytes parked in a UTxO so later
// transactions can point at them instead of each carrying a copy.
//
// **This is the honest reading of "deploy"** — the only operation on this chain
// that genuinely publishes code once. It is still an optimisation rather than a
// prerequisite: a script always works inline, but a large one inlined breaches
// the transaction size limit, and every spend pays for the bytes again.

async function publish(args: Args): Promise<void> {
  const ctx = await openActive(args);
  const loaded = open(args);
  const validator = selectValidator(loaded, selection(args));
  const params = parseParams(flagValue(args, 'params'));
  const identity = scriptIdentity(loaded, validator, ctx.network.name, params);
  const code = scriptBytes(validator, params);
  const scriptBytesLength = Math.floor(code.length / 2);

  // Where the reference output lives is a choice with consequences. Its own
  // address by default: nobody can spend it, so the reference cannot be
  // withdrawn — which is what makes it dependable for everyone else. `--to-self`
  // keeps it spendable so the ADA can be recovered.
  const toSelf = hasFlag(args, 'to-self');
  const holder = toSelf ? ctx.payment : identity.address;

  const validity = await scriptlessValidity(args, ctx);
  const protocol = await ctx.provider.fetchProtocolParameters();
  const utxos = await ctx.wallet.getUtxos();

  let unsigned: string;
  try {
    const b = makeTxBuilder(ctx.provider)
      .txOut(holder, [])
      .txOutReferenceScript(code, identity.version);
    applyExtras(b, { readOnly: [], signers: [], validity });
    // A reference output still needs its minimum ADA, and the script bytes make
    // it large — this is the one case where that minimum is a real number rather
    // than a formality.
    if (toSelf) b.txOutInlineDatumValue((await unitDatum()) as never);

    unsigned = await withoutCostModelNoise(() => b
      .changeAddress(ctx.payment)
      .selectUtxosFrom(utxos)
      .complete());
  } catch (err) {
    throw translateBuildFailure(err, {
      what: `publish a ${scriptBytesLength}-byte reference script`,
      minValueHint: 'a reference output must hold minimum ADA proportional to the script it carries',
    });
  }

  const submitted = hasFlag(args, 'yes');
  const txHash = submitted ? await signAndSubmit(ctx, unsigned) : null;

  if (hasFlag(args, 'json')) {
    writeJson({
      network: ctx.network.name, wallet: ctx.stored.name,
      scriptHash: identity.hash,
      scriptSizeBytes: scriptBytesLength,
      referenceAddress: holder,
      recoverable: toSelf,
      ...(describeWindow(validity) ? { validity: describeWindow(validity) } : {}),
      submitted, ...(txHash ? { txHash, referenceInput: `${txHash}#0` } : {}),
    });
    return;
  }

  process.stderr.write(heading(submitted ? 'Published' : 'Publish (dry run)') + '\n');
  process.stderr.write(fields([
    ['script', identity.hash],
    ['size', `${scriptBytesLength} bytes`],
    ['parked at', toSelf ? `${ctx.stored.name} (recoverable)` : 'the script address (permanent)'],
  ]) + '\n');
  if (!submitted) {
    process.stderr.write('\n' + dim('  Nothing submitted. Add --yes to send it.') + '\n');
    return;
  }
  process.stderr.write('\n' + dim(`  Reference it as ${txHash}#0`) + '\n\n');
  process.stdout.write(`${txHash}#0\n`);
}

/** The unit datum — constructor 0 with no fields. Marks an output as script-owned. */
async function unitDatum(): Promise<unknown> {
  const { mConStr0 } = await mesh();
  return mConStr0([]);
}

// ── mint ─────────────────────────────────────────────────────────────
//
// Minting under a Plutus policy, as opposed to `asset mint`'s native script.
//
// Kept separate deliberately. The two share three flags and differ in seven: a
// Plutus mint needs a blueprint, a module, a validator, parameters, a redeemer,
// collateral and evaluation, none of which mean anything to a native-script mint.
// A command whose valid flag combinations form two non-overlapping sets is two
// commands wearing one name — and over MCP that becomes a schema an agent calls
// wrongly.
//
// The seam already exists downstream: `balance`, `asset send` and `swap` all work
// on `policyId + assetName` regardless of how a token came to be. How a token
// comes into existence is a policy question; what happens to it afterwards is an
// asset question.

async function mint(args: Args): Promise<void> {
  const ctx = await openActive(args);
  const loaded = open(args);
  // A minting policy is the `mint` handler, so prefer it when selecting.
  const validator = selectValidator(loaded, { ...selection(args), handler: 'mint' });
  const params = parseParams(flagValue(args, 'params'));
  const identity = scriptIdentity(loaded, validator, ctx.network.name, params);
  const code = scriptBytes(validator, params);

  const name = flagValue(args, 'name');
  if (!name) throw usageError('mint needs --name <asset-name>', 'example: --name GiftCard');
  // The ledger caps an asset name at 32 bytes. Shared with `asset mint` so both
  // reject the same names, rather than one of them discovering it on-chain.
  assertAssetName(name);
  const quantity = parseSignedQuantity(flagValue(args, 'qty') ?? '1');

  const redeemer = await buildRedeemer(args, loaded, validator);
  const extraFlags = readExtraFlags(args);
  const mintExtras = await anchorValidity(extraFlags, ctx);
  const { stringToHex } = await mesh();
  const assetName = stringToHex(name);
  // For a minting validator the script hash IS the policy id — the namespace
  // every token it mints lives under.
  const policyId = identity.hash;
  const unit = policyId + assetName;

  const utxos = await ctx.wallet.getUtxos();
  const protocol = await ctx.provider.fetchProtocolParameters();
  const collateral = pledgeCollateral(utxos, protocol);
  const evaluator = await makeEvaluator(ctx.provider, ctx.network);
  const { models: mintCostModels } = await costModelsFor(ctx.network);

  // A one-shot policy commonly requires a specific UTxO be spent, which is what
  // makes it one-shot: a UTxO can be spent once in all of history, so the mint
  // can happen once. --spend names it.
  const seedRef = flagValue(args, 'spend');
  const seed = seedRef ? utxos.find((u) => refOf(u) === seedRef) : undefined;
  if (seedRef && !seed) {
    throw usageError(`${seedRef} is not a UTxO in this wallet`,
      `available: ${utxos.slice(0, 4).map(refOf).join(', ')}`);
  }

  let unsigned: string;
  try {
    const b = makeTxBuilder(ctx.provider, { withScripts: true, evaluator, costModels: mintCostModels });
    if (seed) b.txIn(seed.input.txHash, seed.input.outputIndex, seed.output.amount, seed.output.address);

    b.mintPlutusScript(identity.version)
      .mint(quantity.toString(), policyId, assetName)
      .mintingScript(code)
      .mintRedeemerValue(redeemer.value as never);

    applyExtras(b, mintExtras);

    unsigned = await withoutCostModelNoise(() => b
      .txInCollateral(collateral.input.txHash, collateral.input.outputIndex,
                      collateral.output.amount, collateral.output.address)
      .changeAddress(ctx.payment)
      .selectUtxosFrom(seed ? utxos.filter((u) => refOf(u) !== seedRef) : utxos)
      .complete());
  } catch (err) {
    throw translateScriptFailure(err, identity.address);
  }

  const submitted = hasFlag(args, 'yes');
  const txHash = submitted ? await signAndSubmit(ctx, unsigned) : null;
  const burning = quantity < 0n;

  if (hasFlag(args, 'json')) {
    writeJson({
      network: ctx.network.name, wallet: ctx.stored.name,
      action: burning ? 'burn' : 'mint',
      assetName: name, quantity: quantity.toString(),
      policyId, unit,
      redeemer: redeemer.describe,
      ...(seedRef ? { spent: seedRef } : {}),
      ...(describeWindow(mintExtras.validity) ? { validity: describeWindow(mintExtras.validity) } : {}),
      submitted, ...(txHash ? { txHash } : {}),
    });
    return;
  }

  process.stderr.write(heading(burning ? 'Burn' : 'Mint') + (submitted ? '' : ' (dry run)') + '\n');
  process.stderr.write(fields([
    ['asset', name],
    ['quantity', quantity.toString()],
    ['policy id', policyId],
    ['redeemer', redeemer.describe],
    ...(seedRef ? [['spending', seedRef] as [string, string]] : []),
  ]) + '\n');
  if (!submitted) {
    process.stderr.write('\n' + dim('  Nothing submitted. Add --yes to send it.') + '\n');
    return;
  }
  process.stderr.write('\n');
  process.stdout.write(txHash + '\n');
}
