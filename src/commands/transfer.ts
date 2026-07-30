// Send ADA.
//
// One code path, two outcomes. Without `--yes` the transaction is fully built and
// its fee, change and outputs are reported, but nothing is submitted. With `--yes`
// the same build is signed and submitted.
//
// That shape is deliberate: it makes "surface the fee, the change and the
// minimum-value check before submitting" structurally true rather than a promise —
// you cannot submit without having been able to see all three first. It also means
// a fee estimate is the same command minus a flag, instead of a second code path
// that could disagree with the real one.

import type { Args } from '../lib/argv.ts';
import { hasFlag, flagValue } from '../lib/argv.ts';
import { writeJson } from '../lib/json-output.ts';
import { usageError, AdaError } from '../lib/errors.ts';
import { EXIT_CHAIN_REJECTED } from '../lib/exit-codes.ts';
import { openActive } from '../lib/active-wallet.ts';
import { makeTxBuilder, meshNetworkName, withoutCostModelNoise } from '../lib/mesh.ts';
import {
  adaToLovelace, parseLovelace, lovelaceToAda, formatAda, sumLovelace, LOVELACE_UNIT,
} from '../lib/amount.ts';
import { fields, heading, ok, warn, emphasis } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

export default async function transfer(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const [to, amountArg] = args.positionals;

  if (!to || !amountArg) {
    throw usageError(
      'transfer needs a recipient and an amount',
      'example: ada transfer addr_test1... 10',
    );
  }
  if (!to.startsWith('addr')) {
    throw usageError(
      `not a Cardano address: ${to}`,
      'expected a bech32 address beginning with addr or addr_test',
    );
  }

  const amount = hasFlag(args, 'lovelace') ? parseLovelace(amountArg) : adaToLovelace(amountArg);
  if (amount <= 0n) throw usageError('amount must be greater than zero');

  const ctx = await openActive(args, flagValue(args, 'wallet'));

  // Network discrimination as a real check, not a comment: a test address on
  // mainnet, or the reverse, is a mistake worth catching before a fee is paid.
  const wantsTestAddress = ctx.network.name !== 'mainnet';
  if (wantsTestAddress && !to.startsWith('addr_test')) {
    throw usageError(
      `that is a mainnet address, but the active network is ${ctx.network.name}`,
      'use an addr_test... address, or switch networks with --network',
    );
  }

  const utxos = await ctx.wallet.getUtxos();
  if (utxos.length === 0) {
    throw new AdaError(
      'no_utxos',
      `wallet ${ctx.stored.name} has no unspent outputs to spend`,
      EXIT_CHAIN_REJECTED,
      'fund it with: ada airdrop 1000',
    );
  }

  const available = sumLovelace(utxos.flatMap((u) => u.output.amount));

  const builder = makeTxBuilder(ctx.provider);
  builder
    .txOut(to, [{ unit: LOVELACE_UNIT, quantity: amount.toString() }])
    .changeAddress(ctx.payment)
    .selectUtxosFrom(utxos)
    .setNetwork(meshNetworkName(ctx.network.name));

  let unsignedTx: string;
  try {
    unsignedTx = await withoutCostModelNoise(() => builder.complete());
  } catch (err) {
    throw translateBuildFailure(err, amount, available);
  }

  const fee = builder.getActualFee();
  // The builder's body after complete() carries the outputs it actually settled on,
  // change included — read from there rather than recomputing, so the reported
  // numbers are the ones the transaction contains.
  const bodyOutputs: Array<{ address: string; amount: Array<{ unit: string; quantity: string }> }> =
    builder.meshTxBuilderBody.outputs ?? [];
  const outputs = bodyOutputs.map((o) => {
    const lovelace = sumLovelace(o.amount);
    return {
      address: o.address,
      lovelace: lovelace.toString(),
      ada: lovelaceToAda(lovelace),
      isChange: o.address === ctx.payment,
    };
  });
  const change = outputs
    .filter((o) => o.isChange)
    .reduce((sum, o) => sum + BigInt(o.lovelace), 0n);

  // Dry run: everything above is real work against real protocol parameters, so
  // the numbers reported are the numbers that would apply.
  if (!hasFlag(args, 'yes')) {
    if (json) {
      writeJson({
        submitted: false,
        network: ctx.network.name,
        wallet: ctx.stored.name,
        from: ctx.payment,
        to,
        amountLovelace: amount.toString(),
        amountAda: lovelaceToAda(amount),
        feeLovelace: fee.toString(),
        feeAda: lovelaceToAda(fee),
        changeLovelace: change.toString(),
        changeAda: lovelaceToAda(change),
        totalLovelace: (amount + fee).toString(),
        availableLovelace: available.toString(),
        inputCount: utxos.length,
        outputs,
        hint: 'pass --yes to submit this transaction',
      });
      return;
    }
    printPlan(ctx.stored.name, ctx.network.name, to, amount, fee, change, available, outputs.length);
    process.stdout.write('\n' + warn('nothing was submitted — pass --yes to send it') + '\n');
    return;
  }

  let txHash: string;
  try {
    const signedTx = await ctx.wallet.signTx(unsignedTx);
    txHash = await ctx.wallet.submitTx(signedTx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new AdaError(
      'submit_failed',
      `the chain rejected the transaction: ${message}`,
      EXIT_CHAIN_REJECTED,
      'the fee and inputs were valid at build time — the chain state may have moved',
    );
  }

  if (json) {
    writeJson({
      submitted: true,
      txHash,
      network: ctx.network.name,
      wallet: ctx.stored.name,
      from: ctx.payment,
      to,
      amountLovelace: amount.toString(),
      amountAda: lovelaceToAda(amount),
      feeLovelace: fee.toString(),
      feeAda: lovelaceToAda(fee),
      changeLovelace: change.toString(),
      note: 'submitted — it needs a block to confirm before it shows in a balance',
    });
    return;
  }

  process.stdout.write(ok(`sent ${emphasis(formatAda(amount))} to ${to.slice(0, 24)}…`) + '\n');
  process.stdout.write(fields([
    ['tx', txHash],
    ['fee', formatAda(fee)],
    ['change', formatAda(change)],
  ]) + '\n');
  process.stdout.write('\n  it needs one block to confirm — then: ada balance\n');
}

function printPlan(
  wallet: string, network: string, to: string,
  amount: bigint, fee: bigint, change: bigint, available: bigint, outputCount: number,
): void {
  process.stdout.write(heading('Transfer plan') + '\n');
  process.stdout.write(fields([
    ['from', `${wallet} (${network})`],
    ['to', to],
    ['amount', formatAda(amount)],
    ['fee', formatAda(fee)],
    ['change', formatAda(change)],
    ['total', formatAda(amount + fee)],
    ['available', formatAda(available)],
    ['outputs', String(outputCount)],
  ]) + '\n');
  process.stdout.write(dim('  fees on Cardano are a function of size, so this figure is exact\n'));
}

/**
 * Turn a builder failure into something actionable.
 *
 * The two that actually happen are not having enough to cover amount-plus-fee, and
 * an output falling under the minimum-value rule. Both are reported by the builder
 * as prose, so they are matched here once rather than left to surface as a wall of
 * library text.
 */
function translateBuildFailure(err: unknown, amount: bigint, available: bigint): AdaError {
  const message = err instanceof Error ? err.message : String(err);

  if (/insufficient|not enough|UTxO Balance Insufficient/i.test(message)) {
    return new AdaError(
      'insufficient_funds',
      `cannot cover ${lovelaceToAda(amount)} ADA plus fees from ${lovelaceToAda(available)} ADA available`,
      EXIT_CHAIN_REJECTED,
      'fund the wallet with: ada airdrop 1000',
    );
  }

  if (/minimum|min.?ada|min.?utxo|too small/i.test(message)) {
    return new AdaError(
      'output_below_min_value',
      `the output is below the minimum value the ledger allows: ${message}`,
      EXIT_CHAIN_REJECTED,
      'every output must hold a minimum amount of ADA proportional to its size — send more',
    );
  }

  return new AdaError(
    'build_failed',
    `could not build the transaction: ${message}`,
    EXIT_CHAIN_REJECTED,
  );
}
