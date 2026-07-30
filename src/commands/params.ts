// Protocol parameters — the numbers that decide what a transaction costs and
// whether an output is allowed.
//
// The counterpart of `mn inspect-cost`. Worth having as its own command because
// two of these values explain most first-week confusion: the fee coefficients,
// and the per-byte cost that sets the minimum an output must hold.

import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { loadConfig, resolveNetwork } from '../lib/cli-config.ts';
import { makeProvider } from '../lib/mesh.ts';
import { networkError, notRunningError, AdaError } from '../lib/errors.ts';
import { writeJson } from '../lib/json-output.ts';
import { fields, heading } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

export default async function params(args: Args): Promise<void> {
  const network = resolveNetwork(loadConfig(), flagValue(args, 'network'));
  const provider = makeProvider(network);

  let p;
  try {
    p = await provider.fetchProtocolParameters();
  } catch (err) {
    if (err instanceof AdaError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw network.isLocal
      ? notRunningError(`cannot reach the devnet at ${network.apiUrl}`, 'start it with: ada localnet up')
      : networkError(`could not read protocol parameters from ${network.name}: ${message}`);
  }

  if (hasFlag(args, 'json')) {
    writeJson({
      network: network.name,
      epoch: p.epoch,
      fee: { minFeeA: p.minFeeA, minFeeB: p.minFeeB },
      // The fee for a transaction of N bytes is minFeeA * N + minFeeB. Stated here
      // because it is the whole reason a fee is knowable before submitting.
      feeFormula: 'fee = minFeeA * txSizeBytes + minFeeB',
      coinsPerUtxoSize: p.coinsPerUtxoSize,
      limits: {
        maxTxSize: p.maxTxSize,
        maxValSize: p.maxValSize,
        maxBlockSize: p.maxBlockSize,
        maxCollateralInputs: p.maxCollateralInputs,
      },
      deposits: { keyDeposit: p.keyDeposit, poolDeposit: p.poolDeposit },
      scripts: {
        priceMem: p.priceMem,
        priceStep: p.priceStep,
        collateralPercent: p.collateralPercent,
        maxTxExMem: p.maxTxExMem,
        maxTxExSteps: p.maxTxExSteps,
        minFeeRefScriptCostPerByte: p.minFeeRefScriptCostPerByte,
      },
      raw: p,
    });
    return;
  }

  process.stdout.write(heading(`Protocol parameters (${network.name}, epoch ${p.epoch})`) + '\n');
  process.stdout.write(fields([
    ['fee per byte', String(p.minFeeA)],
    ['fee base', String(p.minFeeB)],
    ['coins per UTxO byte', String(p.coinsPerUtxoSize)],
    ['max tx size', `${p.maxTxSize} bytes`],
    ['max value size', `${p.maxValSize} bytes`],
    ['key deposit', String(p.keyDeposit)],
  ]) + '\n');
  process.stdout.write(dim(`  fee = ${p.minFeeA} x txSizeBytes + ${p.minFeeB}\n`));
  process.stdout.write(dim('  every output must hold at least (its size in bytes) x coins-per-UTxO-byte\n'));
}
