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
import { EXIT_CHAIN_REJECTED, EXIT_INTERNAL } from '../lib/exit-codes.ts';
import { writeJson } from '../lib/json-output.ts';
import { openActive, type ActiveContext } from '../lib/active-wallet.ts';
import { makeTxBuilder, makeEvaluator, costModelsFor, withoutCostModelNoise, assertBudgetCovers, rawEvaluate, declaredExUnits, type Provider } from '../lib/mesh.ts';
import { signAndSubmit, translateBuildFailure, translateHorizon, selectCollateral, requiredCollateral, assertMeetsMinValue, assertRecipient, withMinValue } from '../lib/tx-common.ts';
import { adaToLovelace, formatAda, parseSignedQuantity, LOVELACE_UNIT } from '../lib/amount.ts';
import { resolveValidity, assertValidityShape, parseOutputRefs, parseSigners, type ValidityWindow } from '../lib/validity.ts';
import { fetchTip } from '../lib/mesh.ts';
import { assertAssetName, parseAssetPair } from './asset.ts';
import { formatAsset } from '../lib/assets.ts';

import {
  loadBlueprint, selectValidator, scriptIdentity, scriptBytes, parseParams,
  checkAgainstSchema, describeExpected,
  type ScriptIdentity,
  splitTitle, listNames, handlersOf,
  type BlueprintValidator, type LoadedBlueprint,
} from '../lib/blueprint.ts';
import { runAiken } from '../lib/aiken.ts';
import { crossCheckScriptHash } from '../lib/cardano-cli.ts';
import { probeOgmios, evaluateWithOgmios } from '../lib/ogmios.ts';
import { fields, heading, warn } from '../ui/format.ts';
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

/**
 * The project directory a subcommand works in.
 *
 * `--path` selects the project; without it, the directory you are standing in.
 * `build` and `check` honoured it and the eight subcommands that read a blueprint
 * did not — so `contract inspect --path ./bounty` scanned the current directory,
 * found nothing, and reported `blueprint_not_found` while pointing at a project
 * that had been built. One flag that works on two of ten subcommands is worse
 * than no flag, because nothing says which two.
 */
function projectDir(args: Args): string {
  return flagValue(args, 'path') ?? process.cwd();
}

function open(args: Args): LoadedBlueprint {
  return loadBlueprint(flagValue(args, 'blueprint'), projectDir(args));
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

  process.stdout.write(heading('Contract') + '\n');
  process.stdout.write(fields([
    ['blueprint', loaded.path],
    ['title', loaded.doc.preamble.title ?? '(none)'],
    ['plutus', loaded.version],
    ['compiler', compilerOf(loaded)],
  ]) + '\n');

  process.stdout.write('\n' + bold('  Validators') + '\n');
  for (const v of summary) {
    process.stdout.write(`    ${v.name}  ${dim(v.handlers.join(', '))}\n`);
  }

  if (!selected) {
    process.stdout.write('\n' + dim('  Several validators — narrow with --module and --validator') + '\n');
    return;
  }

  const d = describe(loaded, selected);
  process.stdout.write('\n' + bold(`  ${d.module}.${d.validator}`) + '\n');
  process.stdout.write(fields([
    ['handlers', d.handlers.join(', ')],
    ['hash', d.hash ?? '(uncompiled)'],
    ['datum', d.datum ?? '(none)'],
    ['redeemer', d.redeemer ?? '(none)'],
  ]) + '\n');

  if (d.parameters.length > 0) {
    process.stdout.write('\n' + bold('  Parameters') + dim(' — compile-time, must be applied') + '\n');
    const width = d.parameters.reduce((max, p) => Math.max(max, p.name.length), 0);
    for (const p of d.parameters) {
      process.stdout.write(`    ${p.name.padEnd(width)}  ${dim(p.expects ?? '(shape not declared)')}\n`);
    }
    process.stdout.write('\n' + dim('  Applying parameters changes the hash, and so the address.') + '\n');
    process.stdout.write(dim(`  Supply them: ada contract address --params '[…]'`) + '\n');
  }
}

interface Described {
  module: string;
  validator: string;
  handlers: string[];
  hash: string | null;
  datum: string | null;
  redeemer: string | null;
  parameters: { name: string; expects: string | null }[];
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
    parameters: (v.parameters ?? []).map((p, i) => ({
      name: p.title ?? `#${i}`,
      // The shape, not only the name. A parameter that is a bare hash is
      // guessable; one that is a structured Address is not, and working out
      // that it wanted nested constructors cost an afternoon.
      expects: describeExpected(p.schema, loaded) ?? null,
    })),
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

  // A third opinion, on request. Ours comes from MeshJS and the blueprint's from
  // Aiken; cardano-cli is the implementation the ledger is built from. An address
  // that is confidently wrong strands funds where nobody can reach them, so the
  // disagreement is the part worth knowing about.
  const crossCheck = hasFlag(args, 'cross-check')
    ? crossCheckScriptHash(scriptBytes(validator, params), identity.version, identity.hash)
    : undefined;

  if (crossCheck && crossCheck.agrees === false) {
    throw new AdaError('cross_check_failed',
      `cardano-cli computes ${crossCheck.hash} where we compute ${identity.hash}`,
      EXIT_INTERNAL,
      'two implementations disagree about this script — do not send funds to this address');
  }

  if (hasFlag(args, 'json')) {
    writeJson({
      network: network.name,
      blueprint: loaded.path,
      ...(crossCheck ? { crossCheck } : {}),
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
  if (crossCheck) {
    process.stderr.write(fields([['cross-check', crossCheck.agrees
      ? `${crossCheck.version ?? 'cardano-cli'} agrees`
      : crossCheck.unavailable ?? 'unavailable']]) + '\n');
  }
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
  const scriptParams = parseParams(flagValue(args, 'params'));
  const identity = scriptIdentity(loaded, validator, ctx.network.name, scriptParams);

  const amount = flagValue(args, 'amount');
  if (!amount) throw usageError('lock needs --amount <ada>', 'example: --amount 5');
  const lovelace = adaToLovelace(amount);

  const datum = await buildDatum(args, ctx, loaded, validator);
  // A mint carried by the same transaction as the lock — the creation-side twin
  // of `unlock --mint`. A validator that admits state only when a token is issued
  // alongside (a discovery beacon, a state-thread token) makes the state and its
  // marker inseparable; built separately, each transaction would fail alone. A
  // positive mint is delivered into the locked output, where such validators
  // require it; a negative quantity burns from the wallet as usual.
  const mintAlong = await readMintAlong(args, loaded, validator);
  const output = {
    address: identity.address,
    amount: [
      { unit: LOVELACE_UNIT, quantity: lovelace.toString() },
      ...(mintAlong && mintAlong.quantity > 0n
        ? [{ unit: identity.hash + mintAlong.assetName, quantity: mintAlong.quantity.toString() }]
        : []),
    ],
  };

  // The chain refuses an output holding less ADA than its size demands. Checking
  // here means a dry run cannot approve something the chain will reject.
  const params = await ctx.provider.fetchProtocolParameters();
  assertMeetsMinValue(output.address, output.amount, params.coinsPerUtxoSize);

  // With a mint, this validator's mint handler runs, so the script-only flags
  // (--signer, --read-only) mean something; without one, refuse them by name.
  const extras = mintAlong
    ? await anchorValidity(readExtraFlags(args), ctx)
    : { readOnly: [], signers: [], validity: await scriptlessValidity(args, ctx) };
  const utxos = await ctx.wallet.getUtxos();
  const scripted = mintAlong
    ? {
        code: scriptBytes(validator, scriptParams),
        collateral: pledgeCollateral(utxos, params),
        evaluator: await makeEvaluator(ctx.provider, ctx.network),
        costModels: (await costModelsFor(ctx.network)).models,
      }
    : undefined;

  // Inline (CIP-32) by default: the datum travels on the output, so anyone can
  // read it back. A hash-stored datum is never published — the spender must
  // already hold it, and the devnet indexer serves no lookup for one. The
  // encoding is supported anyway because the reference Aiken example uses it and
  // a UTxO created by another tool may well carry one.
  const asHash = hasFlag(args, 'datum-hash');

  // Built through a function so it can be built again at a price the ledger
  // will accept; see signAndSubmit. A Mesh builder is single-use, so a retry
  // cannot reuse the one already completed.
  const build = async (fee?: string): Promise<string> => {
    const b = scripted
      ? makeTxBuilder(ctx.provider, {
          withScripts: true, evaluator: scripted.evaluator, costModels: scripted.costModels })
      : makeTxBuilder(ctx.provider); // a plain lock is a payment — no script runs
    if (fee) b.setFee(fee);
    if (mintAlong && scripted) {
      b.mintPlutusScript(identity.version)
        .mint(mintAlong.quantity.toString(), identity.hash, mintAlong.assetName)
        .mintingScript(scripted.code)
        .mintRedeemerValue(mintAlong.redeemer as never);
    }
    b.txOut(output.address, output.amount);
    if (asHash) b.txOutDatumHashValue(datum.value as never);
    else b.txOutInlineDatumValue(datum.value as never);
    applyExtras(b, extras);
    if (scripted) {
      b.txInCollateral(scripted.collateral.input.txHash, scripted.collateral.input.outputIndex,
                       scripted.collateral.output.amount, scripted.collateral.output.address);
    }

    return withoutCostModelNoise(() => b
      .changeAddress(ctx.payment)
      .selectUtxosFrom(utxos)
      .complete());
  };

  let unsigned: string;
  try {
    unsigned = await build();
  } catch (err) {
    throw translateBuildFailure(err, {
      what: `lock ${formatAda(lovelace)} at ${identity.address}`
        + (mintAlong ? ` minting ${mintAlong.describe}` : ''),
      minValueHint: 'a script output must still hold the minimum ADA its size demands',
    });
  }

  const submitted = hasFlag(args, 'yes');
  const txHash = submitted ? await signAndSubmit(ctx, unsigned, build) : null;

  if (hasFlag(args, 'json')) {
    writeJson({
      network: ctx.network.name, wallet: ctx.stored.name,
      scriptAddress: identity.address, scriptHash: identity.hash,
      ada: formatAda(lovelace), lovelace: lovelace.toString(),
      datum: datum.describe, datumEncoding: asHash ? 'hash' : 'inline',
      ...(mintAlong ? { minted: mintAlong.describe, policyId: identity.hash } : {}),
      ...(describeWindow(extras.validity) ? { validity: describeWindow(extras.validity) } : {}),
      submitted, ...(txHash ? { txHash } : {}),
    });
    return;
  }

  process.stderr.write(heading(submitted ? 'Locked' : 'Lock (dry run)') + '\n');
  process.stderr.write(fields([
    ['network', ctx.network.name],
    ['from', ctx.stored.name],
    ['to script', identity.address],
    ['amount', formatAda(lovelace)],
    ['datum', datum.describe],
    ['encoding', asHash ? 'hash — keep the datum, the chain will not store it' : 'inline'],
    ...(mintAlong ? [['minted', mintAlong.describe] as [string, string]] : []),
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

/**
 * A mint carried by the same transaction as a spend.
 *
 * Common enough to be a shape rather than an edge case: a validator that
 * releases funds only if a token is issued in the same transaction makes the
 * release and the token inseparable — nobody can take the reward without also
 * being credited, and nobody can be credited without earning it. Building the
 * two separately cannot express it, because each transaction would fail on its
 * own.
 */
interface MintAlong {
  assetName: string;
  quantity: bigint;
  redeemer: unknown;
  describe: string;
}

interface SpendContext {
  identity: ScriptIdentity;
  code: string;
  /**
   * The script UTxOs being spent. Several is the batch case: one transaction,
   * one fee, and — where the validator allows it — one atomic outcome instead of
   * a race between separate transactions.
   */
  targets: Target[];
  redeemer: { value: unknown; describe: string };
  collateral: UTxO;
  utxos: UTxO[];
  protocol: Awaited<ReturnType<Provider['fetchProtocolParameters']>>;
  evaluator: Awaited<ReturnType<typeof makeEvaluator>>;
  /** The chain's, for the script integrity hash the ledger checks. */
  costModels?: number[][];
  /** Set when --mint asks the same transaction to issue a token. */
  mintAlong?: MintAlong;
  /** Set when --continue carries the contract's state forward. */
  carryOn?: CarryOn;
  /** A published copy of this validator, pointed at instead of carried. */
  scriptRef?: { txHash: string; index: number };
  /** Outputs to third parties: refunds, payouts, fee splits. */
  payouts: Payout[];
  extras: TxExtras;
}

/** One script UTxO to spend, with the datum it must be handed back. */
interface Target {
  utxo: UTxO;
  /** How its datum was stored, which decides how it is supplied. */
  datumMode: { inline: boolean; value?: unknown };
}

/**
 * A continuing output: value returned to the script with a new datum.
 *
 * This is what makes a validator a **state machine** rather than a one-shot
 * escrow. An auction's raise, a vesting schedule's partial release, an order
 * book's partial fill and an AMM's swap are all the same transaction shape —
 * spend the contract's UTxO, produce another at the same address whose datum
 * says what changed.
 *
 * Without it `unlock` could only ever drain a script: every validator that
 * checks its own continuing output rejected the transaction, and the failure
 * arrived as a script error rather than as "this tool cannot build that".
 */
interface CarryOn {
  lovelace: bigint;
  datum: unknown;
}

/** Lovelace to an ordinary address, alongside whatever else the transaction does. */
export interface Payout {
  address: string;
  lovelace: bigint;
  /** Native assets paid alongside, for a validator that wants something other than ADA. */
  assets: Array<{ unit: string; quantity: bigint }>;
  /**
   * An inline datum on the payout, in Mesh's Plutus-data JSON.
   *
   * A validator that is satisfied by "someone was paid" cannot tell two claims
   * apart when one transaction settles both — one output looks like payment for
   * each of them. A datum on the output says which claim it answers for.
   */
  datum?: unknown;
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
  // Same rule: a continuing output missing its datum, or a malformed --pay, is
  // knowable without asking a chain anything. Read below the UTxO lookup these
  // reported the wrong problem — a fake --tx-in was blamed for a missing
  // --continue-datum, because the network call happened first.
  const carryOn = readCarryOn(args, loaded, validator);
  const payouts = [...readPayouts(args), ...readPayoutsJson(args)];
  const scriptRef = readScriptRef(args);
  const wanted = readTargetRefs(args);

  const chosen = await resolveScriptUtxos(wanted, ctx, identity.address);

  // How the datum is stored decides how it must be supplied back. An inline datum
  // (CIP-32) travels on the output and the builder just points at it; a datum
  // stored as a hash was never published, so the spender must already hold it.
  const supplied = flagValue(args, 'datum');
  const targets: Target[] = chosen.map((utxo) => ({ utxo, datumMode: datumModeOf(utxo, supplied) }));

  const utxos = await ctx.wallet.getUtxos();
  const protocol = await ctx.provider.fetchProtocolParameters();
  const collateral = pledgeCollateral(utxos, protocol);
  const evaluator = await makeEvaluator(ctx.provider, ctx.network);
  const { models: costModels } = await costModelsFor(ctx.network);
  const extras = await anchorValidity(extraFlags, ctx);
  const mintAlong = await readMintAlong(args, loaded, validator);

  return {
    identity, code, targets, redeemer, collateral, utxos, protocol,
    evaluator, costModels, mintAlong, carryOn, payouts, scriptRef, extras,
  };
}

/**
 * `--continue <ada>` with `--continue-datum <json>`: the new state.
 *
 * The address is not asked for. A continuing output by definition returns to the
 * validator being spent, and letting it be named would let a typo send the
 * contract's state somewhere it can never be spent from again.
 *
 * The datum is checked against the validator's declared datum schema, not its
 * redeemer's — a state machine's new state is the same type as its old one, and
 * checking the wrong schema rejects correct input.
 */
function readCarryOn(
  args: Args, loaded: LoadedBlueprint, validator: BlueprintValidator,
): CarryOn | undefined {
  const amount = flagValue(args, 'continue');
  const raw = flagValue(args, 'continue-datum');

  if (!amount && !raw) return undefined;
  if (!amount) {
    throw usageError('--continue-datum needs --continue',
      'a continuing output carries both a value and the state that describes it');
  }
  if (!raw) {
    throw usageError('--continue needs --continue-datum',
      'an output back to the script with no datum can never be spent — the validator '
      + 'would have nothing to read');
  }

  let datum: unknown;
  try {
    datum = JSON.parse(raw);
  } catch (err) {
    throw usageError(`--continue-datum is not valid JSON: ${(err as Error).message}`);
  }

  if (validator.datum?.schema) {
    checkAgainstSchema(datum, validator.datum.schema, loaded, '--continue-datum');
  }

  return { lovelace: adaToLovelace(amount), datum };
}

/**
 * `--script-ref <hash>#<ix>` — spend using a published copy of the validator.
 *
 * A CIP-33 reference script lives in somebody's UTxO, and a transaction that
 * points at it does not carry the validator's bytes itself. For a large script
 * that is the difference between fitting in a transaction and not, and it is
 * exactly what `contract publish` writes — `publish --json` reports the
 * reference to pass here.
 *
 * The script still has to be the right one: its hash is declared alongside, so
 * a reference holding a different validator is rejected by the ledger rather
 * than silently running something else.
 */
function readScriptRef(args: Args): { txHash: string; index: number } | undefined {
  const raw = flagValue(args, 'script-ref');
  if (!raw) return undefined;

  // parseOutputRefs rejects a malformed reference itself, and takes a list —
  // one script is spent per transaction here, so only the first is meaningful.
  const [ref] = parseOutputRefs(raw, '--script-ref');
  return ref;
}

/**
 * `--pay <addr>:<ada>` — value to somebody who is not the spender.
 *
 * Change alone cannot express this: it all returns to one address. A validator
 * that requires the party it displaces to be made whole — an outbid bidder, a
 * cancelled order, a royalty — needs an output naming them, and comma-separated
 * pairs follow the same shape `--signer` already uses for a list.
 */
function readPayouts(args: Args): Payout[] {
  const raw = flagValue(args, 'pay');
  if (!raw) return [];

  return raw.split(',').map((p) => p.trim()).filter((p) => p !== '').map((spec) => {
    // Two shapes, told apart by how many colons there are — a bech32 address
    // contains none, so this is unambiguous, and an unexpected count is named
    // rather than guessed at:
    //   <address>:<ada>          pay ADA
    //   <address>:<unit>:<qty>   pay a native asset
    const parts = spec.split(':');
    if (parts.length < 2 || parts.length > 3 || parts[0] === '') {
      throw usageError(
        `--pay expects <address>:<ada> or <address>:<unit>:<quantity>, got: ${spec}`,
        'for example --pay addr_test1...:12.5, or --pay addr_test1...:<policy><hexname>:100',
      );
    }
    const [address] = parts;
    assertRecipient(address, { what: '--pay: not a Cardano address' });
    if (parts.length === 2) {
      return { address, lovelace: adaToLovelace(parts[1]), assets: [] };
    }
    // An asset payout: the ADA the output must still carry is attached at build
    // time and reported, never folded in silently.
    const { unit, quantity } = parseAssetPair(`${parts[1]}:${parts[2]}`);
    return { address, lovelace: 0n, assets: [{ unit, quantity }] };
  });
}

/**
 * The general payout form, for what a colon spec cannot express.
 *
 * Kept as a second flag rather than more colons, mirroring --datum beside
 * --datum-signer: the short form for the common case, the full one when the
 * shape demands it. Entries are appended to any --pay ones.
 */
function readPayoutsJson(args: Args): Payout[] {
  const raw = flagValue(args, 'payouts');
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw usageError('--payouts must be JSON',
      'an array, for example: --payouts \'[{"address":"addr_test1...","ada":"1.5"}]\'');
  }
  if (!Array.isArray(parsed)) {
    throw usageError('--payouts must be a JSON array of payouts', 'wrap a single payout in [ ]');
  }
  return parsed.map((entry, i) => {
    const where = `--payouts[${i}]`;
    if (typeof entry !== 'object' || entry === null) throw usageError(`${where} is not an object`);
    const { address, ada, assets, datum } = entry as Record<string, unknown>;
    if (typeof address !== 'string') throw usageError(`${where} needs an "address"`);
    assertRecipient(address, { what: `${where}: not a Cardano address` });
    if (ada !== undefined && typeof ada !== 'string' && typeof ada !== 'number') {
      throw usageError(`${where}.ada must be a number or a string of ADA`);
    }
    const list = assets === undefined ? [] : assets;
    if (!Array.isArray(list)) throw usageError(`${where}.assets must be an array`);
    // Through the same parser the colon form uses, so a unit that is valid in one
    // shape cannot be invalid in the other.
    const parsedAssets = list.map((a, j) => {
      if (typeof a !== 'object' || a === null) throw usageError(`${where}.assets[${j}] is not an object`);
      const { unit, quantity } = a as Record<string, unknown>;
      if (typeof unit !== 'string') throw usageError(`${where}.assets[${j}] needs a "unit"`);
      return parseAssetPair(`${unit}:${String(quantity)}`);
    });
    if (ada === undefined && parsedAssets.length === 0) {
      throw usageError(`${where} pays nothing`, 'give "ada", "assets", or both');
    }
    return {
      address,
      lovelace: ada === undefined ? 0n : adaToLovelace(String(ada)),
      assets: parsedAssets,
      ...(datum !== undefined ? { datum } : {}),
    };
  });
}

/** A payout as the ledger will see it, and whatever the ledger itself added. */
export interface PayoutOutput {
  address: string;
  amount: Array<{ unit: string; quantity: string }>;
  /** ADA attached to satisfy min-UTxO, out of the payer's own pocket. */
  adaAttached: bigint;
  datum?: unknown;
}

/**
 * Turn payouts into outputs.
 *
 * An output carrying native assets must also hold ADA, so an asset payout is
 * topped up to the ledger's minimum — which is why the top-up is reported: it
 * leaves the payer's pocket, and is not part of what the recipient was promised.
 * An ADA payout is passed through exactly as written. The caller named a number
 * there, and quietly paying more than they said is worse than the ledger
 * refusing an output that is too small.
 */
export function payoutOutputs(payouts: readonly Payout[], coinsPerUtxoSize: number): PayoutOutput[] {
  return payouts.map((payout) => {
    const carries = payout.datum !== undefined ? { datum: payout.datum } : {};
    const lovelace = { unit: LOVELACE_UNIT, quantity: payout.lovelace.toString() };
    if (payout.assets.length === 0) {
      return { address: payout.address, amount: [lovelace], adaAttached: 0n, ...carries };
    }
    const requested = [lovelace, ...payout.assets.map((a) => ({ unit: a.unit, quantity: a.quantity.toString() }))];
    return {
      address: payout.address,
      ...withMinValue(payout.address, requested, coinsPerUtxoSize, payout.datum),
      ...carries,
    };
  });
}

/** One payout, read back the way the payer needs to check it. */
function describePayout(p: PayoutOutput): string {
  const value = p.amount
    .map((a) => (a.unit === LOVELACE_UNIT ? formatAda(BigInt(a.quantity)) : `${a.quantity} ${formatAsset(a.unit)}`))
    .join(' + ');
  const added = p.adaAttached > 0n ? ` (includes ${formatAda(p.adaAttached)} the ledger requires for a token output)` : '';
  // The datum is what tells a validator which claim this payment settles, so a
  // caller checking a dry run needs to see that it is there.
  const tagged = p.datum !== undefined ? ', carrying an inline datum' : '';
  return `${value} to ${p.address}${added}${tagged}`;
}

/** Build the spending transaction. One definition, two callers. */
async function buildSpend(ctx: ActiveContext, spend: SpendContext, fee?: string): Promise<string> {
  const signerHash = await pubKeyHashOf(ctx);
  try {
    const b = makeTxBuilder(ctx.provider, { withScripts: true, evaluator: spend.evaluator, costModels: spend.costModels });
    // A price the ledger named, when it refused the first attempt. See
    // signAndSubmit: the builder cannot know what the change output will finally
    // hold, so a transaction whose change carries native assets is under-priced.
    if (fee) b.setFee(fee);
    // Each script input is its own complete block: the ledger asks for a
    // redeemer per input, not per transaction, and the builder is positional —
    // whatever follows a txIn belongs to it.
    for (const { utxo, datumMode } of spend.targets) {
      b
        .spendingPlutusScript(spend.identity.version)
        .txIn(utxo.input.txHash, utxo.input.outputIndex,
              utxo.output.amount, utxo.output.address)
        .txInRedeemerValue(spend.redeemer.value as never);

      // Point at a published copy, or carry the bytes. `publish` existed and
      // nothing could consume what it wrote, so the manual's whole argument for
      // it — later transactions point at the script instead of each carrying a
      // copy — was a claim the tool could not honour.
      if (spend.scriptRef) {
        b.spendingTxInReference(
          spend.scriptRef.txHash, spend.scriptRef.index,
          String(Math.ceil(spend.code.length / 2)), spend.identity.hash,
        );
      } else {
        b.txInScript(spend.code);
      }

      if (datumMode.inline) b.txInInlineDatumPresent();
      else b.txInDatumValue(datumMode.value as never);
    }

    // The mint rides along in the same transaction, under this validator's own
    // policy — which for a script is simply its hash.
    if (spend.mintAlong) {
      b.mintPlutusScript(spend.identity.version)
        .mint(spend.mintAlong.quantity.toString(), spend.identity.hash, spend.mintAlong.assetName)
        .mintingScript(spend.code)
        .mintRedeemerValue(spend.mintAlong.redeemer as never);
    }

    // The continuing output, before any payout: a validator that expects exactly
    // one output back to itself is checking the whole output list, so what
    // matters is that it is present and correct, not where it sits.
    if (spend.carryOn) {
      b.txOut(spend.identity.address, [{ unit: LOVELACE_UNIT, quantity: spend.carryOn.lovelace.toString() }])
        .txOutInlineDatumValue(spend.carryOn.datum as never);
    }

    for (const { address, amount, datum } of payoutOutputs(spend.payouts, spend.protocol.coinsPerUtxoSize)) {
      b.txOut(address, amount);
      if (datum !== undefined) b.txOutInlineDatumValue(datum as never);
    }

    // A --signer naming this wallet's own key would duplicate the hash added
    // just below, and the ledger's strict set decoder rejects the duplicate as a
    // malformed transaction — a cryptic decode failure for a harmless request.
    applyExtras(b, {
      ...spend.extras,
      signers: spend.extras.signers.filter((h) => h !== signerHash),
    });

    const unsigned = await withoutCostModelNoise(() => b
      // Validators commonly check for a signature; supplying it is harmless when
      // they do not, and the transaction is unprovable without it when they do.
      .requiredSignerHash(signerHash)
      .txInCollateral(spend.collateral.input.txHash, spend.collateral.input.outputIndex,
                      spend.collateral.output.amount, spend.collateral.output.address)
      .changeAddress(ctx.payment)
      .selectUtxosFrom(spend.utxos)
      .complete());

    // The builder declares the budget of a draft, not of what it finished
    // building. Checked here, where the transaction is complete and the answer
    // is still ours to give.
    await withoutCostModelNoise(() => assertBudgetCovers(spend.evaluator, unsigned));
    return unsigned;
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
  const { identity, targets, redeemer, collateral } = spend;
  const unsigned = await buildSpend(ctx, spend);

  const submitted = hasFlag(args, 'yes');
  const txHash = submitted
    ? await signAndSubmit(ctx, unsigned, (fee) => buildSpend(ctx, spend, fee))
    : null;
  // Across every input: a batch recovers what all of them held, and reporting
  // only the first would understate it by the rest.
  const recovered = targets
    .reduce((total, t) => total + BigInt(t.utxo.output.amount.find((a) => a.unit === LOVELACE_UNIT)?.quantity ?? '0'), 0n)
    .toString();
  // Money leaving for a third party was never reported, so a caller could not
  // tell what a --pay actually sent — least of all the ADA the ledger attaches.
  const paying = payoutOutputs(spend.payouts, spend.protocol.coinsPerUtxoSize);

  if (hasFlag(args, 'json')) {
    writeJson({
      network: ctx.network.name, wallet: ctx.stored.name,
      scriptAddress: identity.address, scriptHash: identity.hash,
      spending: targets.map((t) => refOf(t.utxo)),
      ada: formatAda(BigInt(recovered)), lovelace: recovered,
      redeemer: redeemer.describe,
      datumEncoding: targets.every((t) => t.datumMode.inline) ? 'inline' : 'hash',
      // The window was resolved against the chain tip, so the caller does not
      // otherwise know which slots "30m" became.
      ...(describeWindow(spend.extras.validity) ? { validity: describeWindow(spend.extras.validity) } : {}),
      ...(spend.extras.readOnly.length ? { readOnly: spend.extras.readOnly.map((r) => `${r.txHash}#${r.index}`) } : {}),
      ...(spend.extras.signers.length ? { requiredSigners: spend.extras.signers } : {}),
      ...(spend.mintAlong ? { minted: spend.mintAlong.describe, policyId: spend.identity.hash } : {}),
      ...(paying.length
        ? { payouts: paying.map((p) => ({
            address: p.address,
            amount: p.amount,
            ...(p.adaAttached > 0n ? { adaAttached: formatAda(p.adaAttached), adaAttachedLovelace: p.adaAttached.toString() } : {}),
          })) }
        : {}),
      collateral: refOf(collateral),
      submitted, ...(txHash ? { txHash } : {}),
    });
    return;
  }

  process.stderr.write(heading(submitted ? 'Unlocked' : 'Unlock (dry run)') + '\n');
  process.stderr.write(fields([
    ['network', ctx.network.name],
    ['to', ctx.stored.name],
    ...targets.map((t) => ['spending', shortRef(t.utxo)] as [string, string]),
    ['amount', formatAda(BigInt(recovered))],
    ['redeemer', redeemer.describe],
    ['collateral', shortRef(collateral)],
    ...(spend.mintAlong ? [['minted', spend.mintAlong.describe] as [string, string]] : []),
    ...paying.map((p) => ['paying', describePayout(p)] as [string, string]),
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
/**
 * Which script UTxOs `--tx-in` names, read without asking a chain anything.
 *
 * Comma-separated, like every other list this CLI takes: several UTxOs in one
 * transaction is the batch case, and whether the validator permits it is the
 * validator's business — it will say so by refusing to build. Whether the list
 * is well formed is knowable here, and the file already learned once that
 * checking below the network call blames the wrong flag.
 */
function readTargetRefs(args: Args): string[] | undefined {
  const raw = flagValue(args, 'tx-in');
  if (!raw) return undefined;
  const refs = raw.split(',').map((r) => r.trim()).filter((r) => r !== '');
  if (refs.length === 0) throw usageError('--tx-in names no UTxO');
  const seen = new Set<string>();
  for (const ref of refs) {
    if (seen.has(ref)) {
      throw usageError(`--tx-in names ${ref} twice`,
        'a transaction cannot spend the same output more than once');
    }
    seen.add(ref);
  }
  return refs;
}

async function resolveScriptUtxos(
  refs: string[] | undefined, ctx: ActiveContext, scriptAddress: string,
): Promise<UTxO[]> {
  const at = await ctx.provider.fetchAddressUTxOs(scriptAddress);
  if (at.length === 0) {
    throw new AdaError('nothing_locked', `no UTxO at ${scriptAddress}`, EXIT_CHAIN_REJECTED,
      'lock funds there first: ada contract lock --amount 5 --datum-signer --yes');
  }

  if (!refs) {
    if (at.length > 1) {
      throw usageError(`${at.length} UTxOs sit at the script address`,
        `choose one with --tx-in <hash>#<index>: ${at.map(refOf).join(', ')}`);
    }
    return [at[0]];
  }

  return refs.map((ref) => {
    const found = at.find((u) => refOf(u) === ref);
    if (!found) {
      throw usageError(`${ref} is not at the script address`, `available: ${at.map(refOf).join(', ')}`);
    }
    return found;
  });
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
/**
 * The part of an evaluator's complaint worth showing.
 *
 * A rejection carries the validator's own `trace` output when the contract
 * emitted any, and that names the condition that did not hold — which is the
 * difference between "something in your contract said no" and "the deadline
 * check said no". Around it sits CBOR and stack noise that helps nobody, so the
 * lines that carry a trace or an explicit reason are kept and the rest dropped.
 *
 * Empty when there is nothing specific to add, so a caller never renders a
 * heading over the evaluator clearing its throat.
 */
function scriptDetail(message: string): string | undefined {
  const interesting = message
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    // Hex blobs are the transaction, not an explanation.
    .filter((l) => !/^[0-9a-f]{64,}$/i.test(l))
    .filter((l) => /trace|reason|cause|error message|Trace|because|expect/i.test(l));

  if (interesting.length === 0) return undefined;
  // Bounded: an evaluator that decides to be verbose must not push the hint and
  // the message off the top of a terminal.
  return interesting.slice(0, 6).join('\n');
}

function translateScriptFailure(err: unknown, scriptAddress: string): AdaError {
  // Already ours, and already specific. Re-translating turned the
  // under-declared-budget guard into "the validator is too expensive", which is
  // a different problem with a different fix.
  if (err instanceof AdaError) return err;

  const message = err instanceof Error ? err.message : String(err);

  const horizon = translateHorizon(message);
  if (horizon) return horizon;

  if (/evaluate redeemers failed|validation failure|script.*fail/i.test(message)) {
    return new AdaError('script_rejected',
      'the validator rejected this transaction',
      EXIT_CHAIN_REJECTED,
      'the datum, the redeemer, or a condition on the transaction itself did not satisfy it — '
      + 'check the redeemer against `ada contract inspect`, and that you are signing with the key the datum names. '
      + 'For a second opinion, `ada contract simulate --verify-budget` asks a node about the same transaction '
      + 'where one is reachable — `ada status` says whether it is, and docs/DEVNET.md how to run one',
      scriptDetail(message));
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
  const dir = projectDir(args);
  const extra = args.positionals.slice(1);

  // Both halves of aiken's output are collected — the JSON report, and the
  // diagnostic it renders only to a terminal. See runAiken.
  const wantsJson = hasFlag(args, 'json');
  const { report, version, mismatch } = runAiken([subcommand, ...extra], dir);
  const tests = report?.summary;

  if (wantsJson) {
    writeJson({
      ran: `aiken ${subcommand}`,
      compiler: version,
      directory: dir,
      ...(tests ? { tests: { total: tests.total, passed: tests.passed, failed: tests.failed } } : {}),
      // Surfaced here because aiken's own warning is never emitted in this mode:
      // it renders warnings only to a terminal, and --json pipes stdout.
      ...(mismatch ? { compilerMismatch: mismatch } : {}),
      ...(subcommand === 'build' ? { blueprint: `${dir.replace(/\/$/, '')}/plutus.json` } : {}),
    });
    return;
  }

  if (mismatch) {
    process.stderr.write('\n' + warn(
      `built with ${mismatch.running}, but aiken.toml declares ${mismatch.declared}`) + '\n');
    process.stderr.write(dim('  The compiler changes the script hash, so this blueprint addresses '
      + 'somewhere the project did not ask for.') + '\n');
    process.stderr.write(dim(`  Switch with: aikup ${mismatch.declared}`) + '\n');
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

  process.stdout.write(heading('Script UTxOs') + '\n');
  process.stdout.write(fields([
    ['network', ctx.network.name],
    ['address', identity.address],
    ['count', String(entries.length)],
    ['total', formatAda(total)],
  ]) + '\n');

  if (entries.length === 0) {
    process.stdout.write('\n' + dim('  Nothing locked here yet.') + '\n');
    return;
  }

  process.stdout.write('\n');
  for (const e of entries) {
    process.stdout.write(`  ${e.ref}\n`);
    process.stdout.write(`    ${e.ada}  ${dim(e.datumEncoding === 'inline' ? 'inline datum'
      : e.datumEncoding === 'hash' ? 'datum hash — supply the original to spend' : 'no datum')}\n`);
    for (const a of e.assets) process.stdout.write(`    ${dim(`${a.quantity} × ${a.unit}`)}\n`);
  }
  process.stdout.write('\n');
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
  const { identity, targets, protocol, evaluator } = spend;
  // The very same transaction `unlock` would submit — that is what makes the
  // number below an answer about unlock rather than about something adjacent.
  const unsigned = await buildSpend(ctx, spend);

  // What the scripts cost, and separately what the transaction declares.
  //
  // These are not the same number and reporting one as the other is misleading
  // in both directions: the cost is what a node independently arrives at, while
  // the declared figure carries the margin that covers the builder measuring a
  // draft. Showing only the margined one made `--verify-budget` report a
  // disagreement of exactly the margin between two evaluators that agreed
  // exactly.
  const { total: used, actions } = await withoutCostModelNoise(() => rawEvaluate(evaluator, unsigned));
  const declared = await declaredExUnits(unsigned);

  // A second opinion, when one is reachable and asked for.
  //
  // Our number comes from a Plutus VM reimplemented in JavaScript; the node's
  // comes from the implementation that will judge the transaction. Agreement is
  // reassurance and disagreement is information — but a missing second opinion
  // must never fail an operation that already has a first, so this only ever adds
  // to the report.
  let verify: Record<string, unknown> | undefined;
  if (hasFlag(args, 'verify-budget')) {
    const status = await probeOgmios(ctx.network);
    if (!status.reachable || !status.url) {
      verify = { available: false, reason: status.reason ?? 'unreachable', ...(status.url ? { url: status.url } : {}) };
    } else {
      const { budgets, error } = await evaluateWithOgmios(status.url, unsigned);
      if (error || !budgets) {
        verify = { available: true, url: status.url, error: error ?? 'no budgets returned' };
      } else {
        const theirs = budgets.reduce(
          (acc, b) => ({ mem: acc.mem + b.mem, steps: acc.steps + b.steps }), { mem: 0, steps: 0 });
        verify = {
          available: true, url: status.url, version: status.version,
          node: theirs,
          agrees: theirs.mem === used.mem && theirs.steps === used.steps,
        };
      }
    }
  }

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
      spending: targets.map((t) => refOf(t.utxo)),
      redeemers: actions,
      executionUnits: { mem: used.mem, steps: used.steps },
      declaredExecutionUnits: { mem: declared.mem, steps: declared.steps },
      limits: { maxMem, maxSteps },
      usage: { memPercent: pct(used.mem, maxMem), stepsPercent: pct(used.steps, maxSteps) },
      scriptFeeLovelace: String(scriptFee),
      txSizeBytes: sizeBytes,
      maxTxSize: protocol.maxTxSize,
      ...(describeWindow(spend.extras.validity) ? { validity: describeWindow(spend.extras.validity) } : {}),
      withinLimits: used.mem <= maxMem && used.steps <= maxSteps && sizeBytes <= protocol.maxTxSize,
      ...(verify ? { verifyBudget: verify } : {}),
    });
    return;
  }

  process.stdout.write(heading('Simulation') + '\n');
  process.stdout.write(fields([
    ...targets.map((t) => ['spending', refOf(t.utxo)] as [string, string]),
    ['memory', `${used.mem.toLocaleString()} / ${maxMem.toLocaleString()}  (${pct(used.mem, maxMem)}%)`],
    ['steps', `${used.steps.toLocaleString()} / ${maxSteps.toLocaleString()}  (${pct(used.steps, maxSteps)}%)`],
    ['declared', `${declared.mem.toLocaleString()} mem, ${declared.steps.toLocaleString()} steps`],
    ['script fee', `${formatAda(BigInt(scriptFee))}`],
    ['tx size', `${sizeBytes} / ${protocol.maxTxSize} bytes`],
  ]) + '\n');
  if (verify) {
    const node = verify.node as { mem: number; steps: number } | undefined;
    process.stdout.write(fields([['verified', node
      ? (verify.agrees ? 'the node agrees' : `the node says ${node.mem.toLocaleString()} / ${node.steps.toLocaleString()}`)
      : `unavailable — ${verify.reason ?? verify.error}`]]) + '\n');
  }
  process.stdout.write('\n' + dim('  Nothing submitted. The validator ran and approved.') + '\n');

  // Suggest the second opinion exactly once: when a node is answering and was
  // not asked. Not on every simulate — a suggestion you cannot act on is noise,
  // and one repeated after you have taken it is worse. Silent when Ogmios is
  // absent, because the useful thing to say then is nothing at all.
  if (!hasFlag(args, 'verify-budget')) {
    const status = await probeOgmios(ctx.network);
    if (status.reachable) {
      process.stdout.write(dim('  A node is answering at ' + status.url
        + ' — add --verify-budget to have it check these figures.') + '\n');
    }
  }
  process.stdout.write('\n');
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

  // Rebuildable at the ledger's price; see signAndSubmit.
  const build = async (fee?: string): Promise<string> => {
    const b = makeTxBuilder(ctx.provider)
      .txOut(holder, [])
      .txOutReferenceScript(code, identity.version);
    if (fee) b.setFee(fee);
    applyExtras(b, { readOnly: [], signers: [], validity });
    // A reference output still needs its minimum ADA, and the script bytes make
    // it large — this is the one case where that minimum is a real number rather
    // than a formality.
    if (toSelf) b.txOutInlineDatumValue((await unitDatum()) as never);

    return withoutCostModelNoise(() => b
      .changeAddress(ctx.payment)
      .selectUtxosFrom(utxos)
      .complete());
  };

  let unsigned: string;
  try {
    unsigned = await build();
  } catch (err) {
    throw translateBuildFailure(err, {
      what: `publish a ${scriptBytesLength}-byte reference script`,
      minValueHint: 'a reference output must hold minimum ADA proportional to the script it carries',
    });
  }

  const submitted = hasFlag(args, 'yes');
  const txHash = submitted ? await signAndSubmit(ctx, unsigned, build) : null;

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

  // Rebuildable at the ledger's price; see signAndSubmit.
  const build = async (fee?: string): Promise<string> => {
    const b = makeTxBuilder(ctx.provider, { withScripts: true, evaluator, costModels: mintCostModels });
    if (fee) b.setFee(fee);
    if (seed) b.txIn(seed.input.txHash, seed.input.outputIndex, seed.output.amount, seed.output.address);

    b.mintPlutusScript(identity.version)
      .mint(quantity.toString(), policyId, assetName)
      .mintingScript(code)
      .mintRedeemerValue(redeemer.value as never);

    applyExtras(b, mintExtras);

    return withoutCostModelNoise(() => b
      .txInCollateral(collateral.input.txHash, collateral.input.outputIndex,
                      collateral.output.amount, collateral.output.address)
      .changeAddress(ctx.payment)
      .selectUtxosFrom(seed ? utxos.filter((u) => refOf(u) !== seedRef) : utxos)
      .complete());
  };

  let unsigned: string;
  try {
    unsigned = await build();
  } catch (err) {
    throw translateScriptFailure(err, identity.address);
  }

  const submitted = hasFlag(args, 'yes');
  const txHash = submitted ? await signAndSubmit(ctx, unsigned, build) : null;
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


/**
 * Read `--mint <name>:<qty>`, for a spend that must also issue a token.
 *
 * The policy is not asked for: it is this validator's own hash, because the
 * mint handler and the spend handler are the same script. That is exactly the
 * relationship that makes a circular `--policy` parameter impossible, and the
 * reason the validator reads its own hash off the input it is spending.
 */
async function readMintAlong(
  args: Args, loaded: LoadedBlueprint, validator: BlueprintValidator,
): Promise<MintAlong | undefined> {
  const spec = flagValue(args, 'mint');
  if (!spec) return undefined;

  const at = spec.lastIndexOf(':');
  if (at <= 0) {
    throw usageError(`--mint expects <name>:<quantity>, got: ${spec}`,
      'for example --mint Badge:1, or --mint Badge:-1 to burn');
  }
  const name = spec.slice(0, at);
  const quantity = parseSignedQuantity(spec.slice(at + 1));
  assertAssetName(name);

  const raw = flagValue(args, 'mint-redeemer');
  if (!raw) {
    throw usageError('--mint needs --mint-redeemer',
      'the mint handler takes its own redeemer, separate from the spend\'s');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw usageError(`--mint-redeemer is not valid JSON: ${(err as Error).message}`);
  }

  // The mint handler declares its own redeemer shape, which is usually a
  // different type from the spend's — checking against the spend's would reject
  // a correct value.
  const mintHandler = selectValidator(loaded, {
    module: splitTitle(validator.title).module,
    validator: splitTitle(validator.title).validator,
    handler: 'mint',
  });
  checkAgainstSchema(parsed, mintHandler.redeemer?.schema, loaded, '--mint-redeemer');

  const { stringToHex } = await mesh();
  return {
    assetName: stringToHex(name),
    quantity,
    redeemer: parsed,
    describe: `${quantity} × ${name}`,
  };
}
