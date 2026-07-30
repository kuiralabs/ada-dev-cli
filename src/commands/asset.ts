// Native assets: mint under a policy, and move bundles.
//
// Cardano treats custom tokens as ledger citizens — no contract is needed to
// create or move one, and a single output can carry many different assets at once.
// That is why `send` moves a *bundle* rather than one token: it is what the ledger
// natively does, and any real use of assets needs it.
//
// Minting uses a **native script** policy controlled by one key, not Plutus. For a
// developer tool that is the right trade: no script authoring, no redeemers, no
// execution units, and the policy is deterministic from the wallet — the same
// wallet always produces the same policy id, so a mint is repeatable.

import { ForgeScript, resolveScriptHash } from '@meshsdk/core';
import type { Args } from '../lib/argv.ts';
import { hasFlag, flagValue } from '../lib/argv.ts';
import { writeJson } from '../lib/json-output.ts';
import { usageError, AdaError } from '../lib/errors.ts';
import { EXIT_CHAIN_REJECTED } from '../lib/exit-codes.ts';
import { openActive } from '../lib/active-wallet.ts';
import { makeTxBuilder, meshNetworkName, withoutCostModelNoise } from '../lib/mesh.ts';
import { lovelaceToAda, formatAda, sumLovelace, LOVELACE_UNIT } from '../lib/amount.ts';
import { fields, heading, ok, warn, emphasis } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

const SUBCOMMANDS = ['mint', 'send', 'policy'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/** CIP-25 is the established convention for native-asset metadata. Using the
 *  ecosystem's label rather than inventing one is what makes an asset minted here
 *  display correctly in wallets and explorers. */
const CIP25_METADATA_LABEL = 721;

/** Asset names are hex-encoded on-chain and capped by the ledger. */
export const MAX_ASSET_NAME_BYTES = 32;

export default async function asset(args: Args): Promise<void> {
  const [sub] = args.positionals;
  if (!sub) throw usageError('asset needs a subcommand', `one of: ${SUBCOMMANDS.join(', ')}`);
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw usageError(`unknown asset subcommand: ${sub}`, `one of: ${SUBCOMMANDS.join(', ')}`);
  }
  switch (sub as Subcommand) {
    case 'mint': return mint(args);
    case 'send': return send(args);
    case 'policy': return policy(args);
  }
}

/**
 * The policy this wallet mints under.
 *
 * Separate from `mint` because knowing your policy id without minting anything is
 * a real need — it is half of every asset identifier you will type afterwards.
 */
async function policy(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const ctx = await openActive(args, flagValue(args, 'wallet'));
  const forgeScript = ForgeScript.withOneSignature(ctx.payment);
  const policyId = resolveScriptHash(forgeScript);

  if (json) {
    writeJson({
      network: ctx.network.name,
      wallet: ctx.stored.name,
      policyId,
      controlledBy: ctx.payment,
      scriptType: 'native/one-signature',
    });
    return;
  }
  process.stdout.write(heading(`Minting policy — ${ctx.stored.name}`) + '\n');
  process.stdout.write(fields([
    ['policy id', policyId],
    ['controlled by', ctx.payment],
    ['type', 'native script, one signature'],
  ]) + '\n');
  process.stdout.write(dim('  the same wallet always produces this policy, so mints are repeatable\n'));
}

async function mint(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const name = flagValue(args, 'name') ?? args.positionals[1];
  const qtyRaw = flagValue(args, 'qty') ?? args.positionals[2] ?? '1';

  if (!name) {
    throw usageError(
      'asset mint needs a name',
      'example: ada asset mint --name Silk --qty 100',
    );
  }
  assertAssetName(name);

  const quantity = parseQuantity(qtyRaw);
  const ctx = await openActive(args, flagValue(args, 'wallet'));

  const forgeScript = ForgeScript.withOneSignature(ctx.payment);
  const policyId = resolveScriptHash(forgeScript);
  const assetNameHex = Buffer.from(name, 'utf-8').toString('hex');
  const unit = `${policyId}${assetNameHex}`;

  const utxos = await ctx.wallet.getUtxos();
  if (utxos.length === 0) {
    throw new AdaError('no_utxos', `wallet ${ctx.stored.name} has nothing to pay the fee with`,
      EXIT_CHAIN_REJECTED, 'fund it with: ada airdrop 1000');
  }

  const builder = makeTxBuilder(ctx.provider);
  builder
    .mint(quantity.toString(), policyId, assetNameHex)
    .mintingScript(forgeScript)
    // CIP-25 keys metadata by policy id then asset name, which is what wallets and
    // explorers look for. Inventing a shape here would mint an asset nothing can
    // display.
    .metadataValue(CIP25_METADATA_LABEL, {
      [policyId]: { [name]: { name, description: flagValue(args, 'description') ?? `Minted with ada-wallet-cli` } },
    })
    .changeAddress(ctx.payment)
    .selectUtxosFrom(utxos)
    .setNetwork(meshNetworkName(ctx.network.name));

  let unsignedTx: string;
  try {
    unsignedTx = await withoutCostModelNoise(() => builder.complete());
  } catch (err) {
    throw translateFailure(err, 'mint');
  }
  const fee = builder.getActualFee();

  // Same shape as transfer: nothing happens without --yes, and the dry run reports
  // the real fee because the transaction was really built.
  if (!hasFlag(args, 'yes')) {
    if (json) {
      writeJson({
        minted: false, network: ctx.network.name, wallet: ctx.stored.name,
        assetName: name, quantity: quantity.toString(), policyId, unit,
        feeLovelace: fee.toString(), feeAda: lovelaceToAda(fee),
        hint: 'pass --yes to submit this mint',
      });
      return;
    }
    printMintPlan(ctx.stored.name, name, quantity, policyId, unit, fee);
    process.stdout.write('\n' + warn('nothing was minted — pass --yes to submit') + '\n');
    return;
  }

  const txHash = await signAndSubmit(ctx, unsignedTx);

  if (json) {
    writeJson({
      minted: true, txHash, network: ctx.network.name, wallet: ctx.stored.name,
      assetName: name, quantity: quantity.toString(), policyId, unit,
      feeLovelace: fee.toString(), feeAda: lovelaceToAda(fee),
      note: 'needs a block to confirm before it shows in a balance',
    });
    return;
  }
  process.stdout.write(ok(`minted ${emphasis(`${quantity} ${name}`)}`) + '\n');
  process.stdout.write(fields([['tx', txHash], ['unit', unit], ['fee', formatAda(fee)]]) + '\n');
}

async function send(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const [, to, ...pairs] = args.positionals;

  if (!to || pairs.length === 0) {
    throw usageError(
      'asset send needs a recipient and at least one asset',
      'example: ada asset send addr_test1... <unit>:100 <otherUnit>:5',
    );
  }
  if (!to.startsWith('addr')) {
    throw usageError(`not a Cardano address: ${to}`, 'expected a bech32 address');
  }

  // A bundle, not a single asset: many distinct tokens travel in one output, which
  // is what the ledger natively supports.
  const bundle = pairs.map(parseAssetPair);

  const ctx = await openActive(args, flagValue(args, 'wallet'));
  const utxos = await ctx.wallet.getUtxos();
  if (utxos.length === 0) {
    throw new AdaError('no_utxos', `wallet ${ctx.stored.name} has no unspent outputs`,
      EXIT_CHAIN_REJECTED, 'fund it with: ada airdrop 1000');
  }

  const held = new Map<string, bigint>();
  for (const u of utxos) {
    for (const a of u.output.amount as Array<{ unit: string; quantity: string }>) {
      held.set(a.unit, (held.get(a.unit) ?? 0n) + BigInt(a.quantity));
    }
  }
  // Checked before building so the failure names the asset rather than surfacing as
  // a coin-selection error about a unit the user never mentioned.
  for (const { unit, quantity } of bundle) {
    const have = held.get(unit) ?? 0n;
    if (have < quantity) {
      throw new AdaError(
        'insufficient_asset',
        `holds ${have} of ${unit}, needs ${quantity}`,
        EXIT_CHAIN_REJECTED,
        'check what is held with: ada balance',
      );
    }
  }

  const builder = makeTxBuilder(ctx.provider);
  builder
    .txOut(to, bundle.map(({ unit, quantity }) => ({ unit, quantity: quantity.toString() })))
    .changeAddress(ctx.payment)
    .selectUtxosFrom(utxos)
    .setNetwork(meshNetworkName(ctx.network.name));

  let unsignedTx: string;
  try {
    unsignedTx = await withoutCostModelNoise(() => builder.complete());
  } catch (err) {
    throw translateFailure(err, 'send');
  }
  const fee = builder.getActualFee();
  const attachedAda = sumLovelace(
    (builder.meshTxBuilderBody.outputs ?? [])
      .filter((o) => o.address === to)
      .flatMap((o) => o.amount as Array<{ unit: string; quantity: string }>),
  );

  if (!hasFlag(args, 'yes')) {
    if (json) {
      writeJson({
        submitted: false, network: ctx.network.name, wallet: ctx.stored.name, to,
        assets: bundle.map((b) => ({ unit: b.unit, quantity: b.quantity.toString() })),
        feeLovelace: fee.toString(), feeAda: lovelaceToAda(fee),
        minAdaAttachedLovelace: attachedAda.toString(),
        hint: 'pass --yes to submit this transfer',
      });
      return;
    }
    process.stdout.write(heading('Asset transfer plan') + '\n');
    process.stdout.write(fields([
      ['to', to],
      ['assets', String(bundle.length)],
      ['fee', formatAda(fee)],
      // Every output must carry ADA, so sending a token always costs a little ADA
      // that travels with it. Surfacing it stops that looking like a bug.
      ['ada attached', formatAda(attachedAda)],
    ]) + '\n');
    for (const b of bundle) process.stdout.write(`    ${b.quantity}  ${b.unit}\n`);
    process.stdout.write('\n' + warn('nothing was sent — pass --yes to submit') + '\n');
    return;
  }

  const txHash = await signAndSubmit(ctx, unsignedTx);

  if (json) {
    writeJson({
      submitted: true, txHash, network: ctx.network.name, wallet: ctx.stored.name, to,
      assets: bundle.map((b) => ({ unit: b.unit, quantity: b.quantity.toString() })),
      feeLovelace: fee.toString(), minAdaAttachedLovelace: attachedAda.toString(),
    });
    return;
  }
  process.stdout.write(ok(`sent ${bundle.length} asset(s) to ${to.slice(0, 24)}…`) + '\n');
  process.stdout.write(fields([['tx', txHash], ['fee', formatAda(fee)]]) + '\n');
}

async function signAndSubmit(
  ctx: Awaited<ReturnType<typeof openActive>>,
  unsignedTx: string,
): Promise<string> {
  try {
    return await ctx.wallet.submitTx(await ctx.wallet.signTx(unsignedTx));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdaError('submit_failed', `the chain rejected the transaction: ${message}`,
      EXIT_CHAIN_REJECTED, 'chain state may have moved since the transaction was built');
  }
}

function printMintPlan(
  wallet: string, name: string, quantity: bigint, policyId: string, unit: string, fee: bigint,
): void {
  process.stdout.write(heading('Mint plan') + '\n');
  process.stdout.write(fields([
    ['wallet', wallet],
    ['asset', name],
    ['quantity', quantity.toString()],
    ['policy id', policyId],
    ['unit', unit],
    ['fee', formatAda(fee)],
  ]) + '\n');
}

/** `<unit>:<quantity>`, where unit is policyId + hex asset name. */
export function parseAssetPair(pair: string): { unit: string; quantity: bigint } {
  const at = pair.lastIndexOf(':');
  if (at <= 0) {
    throw usageError(
      `malformed asset: ${pair}`,
      'expected <unit>:<quantity>, where unit is the policy id followed by the hex asset name',
    );
  }
  const unit = pair.slice(0, at);
  if (unit === LOVELACE_UNIT) {
    throw usageError('use `ada transfer` to send ADA', 'asset send is for native assets');
  }
  return { unit, quantity: parseQuantity(pair.slice(at + 1)) };
}

export function parseQuantity(raw: string): bigint {
  const cleaned = raw.trim().replace(/_/g, '');
  if (!/^\d+$/.test(cleaned)) {
    throw usageError(`not a valid quantity: ${raw}`, 'native asset quantities are whole numbers');
  }
  const value = BigInt(cleaned);
  if (value <= 0n) throw usageError('quantity must be greater than zero');
  return value;
}

export function assertAssetName(name: string): void {
  const bytes = Buffer.from(name, 'utf-8').length;
  if (bytes === 0 || bytes > MAX_ASSET_NAME_BYTES) {
    throw usageError(
      `asset name must be 1 to ${MAX_ASSET_NAME_BYTES} bytes, got ${bytes}`,
      'the ledger caps asset names, and multi-byte characters count for more than one',
    );
  }
}

function translateFailure(err: unknown, what: string): AdaError {
  const message = err instanceof Error ? err.message : String(err);
  if (/insufficient|not enough|UTxO Balance Insufficient/i.test(message)) {
    return new AdaError('insufficient_funds', `not enough ADA to cover the ${what} and its fee`,
      EXIT_CHAIN_REJECTED, 'fund the wallet with: ada airdrop 1000');
  }
  if (/minimum|min.?ada|min.?utxo|too small/i.test(message)) {
    return new AdaError('output_below_min_value',
      `the output is below the ledger's minimum value: ${message}`,
      EXIT_CHAIN_REJECTED,
      'an output carrying assets needs more ADA attached than a plain one');
  }
  return new AdaError('build_failed', `could not build the ${what}: ${message}`, EXIT_CHAIN_REJECTED);
}
