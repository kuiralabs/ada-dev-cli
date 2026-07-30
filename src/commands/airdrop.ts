// Fund an address from the devnet faucet.
//
// Named to match the mental model carried over from the Midnight tool rather than
// the devkit's own term ("topup"). Devnet only — a public network has no faucet,
// and saying so plainly beats a confusing HTTP error.

import type { Args } from '../lib/argv.ts';
import { hasFlag, flagValue } from '../lib/argv.ts';
import { writeJson } from '../lib/json-output.ts';
import { usageError, networkError, configError } from '../lib/errors.ts';
import { loadConfig, resolveNetwork } from '../lib/cli-config.ts';
import { openActive, openNetwork } from '../lib/active-wallet.ts';
import { faucetOf } from '../lib/mesh.ts';
import { adaToLovelace, lovelaceToAda, formatAda } from '../lib/amount.ts';
import { ok, fields, emphasis } from '../ui/format.ts';

export default async function airdrop(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const [amountArg] = args.positionals;
  if (!amountArg) {
    throw usageError('airdrop needs an amount in ADA', 'example: ada airdrop 1000');
  }

  // Parsed and re-rendered through integer arithmetic so the amount requested is
  // provably the amount reported.
  const lovelace = adaToLovelace(amountArg);
  const ada = lovelaceToAda(lovelace);

  // Checked before any provider is built. Otherwise `airdrop --network preprod`
  // reports "no API key" — true, but the wrong problem: there is no faucet on a
  // public network no matter how well configured it is.
  const requested = resolveNetwork(loadConfig(), flagValue(args, 'network'));
  if (!requested.isLocal) {
    throw configError(
      `${requested.name} has no faucet`,
      'airdrop only works on the local devnet — a public network will not give you free ADA',
    );
  }

  const explicitAddress = flagValue(args, 'address');
  let address: string;
  let networkName: string;
  let walletName: string | null = null;
  let provider;

  if (explicitAddress) {
    const opened = openNetwork(args);
    provider = opened.provider;
    networkName = opened.network.name;
    address = explicitAddress;
  } else {
    const ctx = await openActive(args, flagValue(args, 'wallet'));
    provider = ctx.provider;
    networkName = ctx.network.name;
    address = ctx.payment;
    walletName = ctx.stored.name;
  }

  const faucet = faucetOf(provider);

  try {
    // The devkit's faucet takes ADA, not lovelace.
    await faucet.addressTopup(address, ada);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw networkError(
      `faucet request failed: ${message}`,
      'is the devnet running? check: ada localnet status',
    );
  }

  if (json) {
    writeJson({
      network: networkName,
      wallet: walletName,
      address,
      ada,
      lovelace: lovelace.toString(),
      note: 'the faucet transaction needs a block to confirm before it shows in a balance',
    });
    return;
  }

  process.stdout.write(ok(`sent ${emphasis(formatAda(lovelace))} to ${walletName ?? 'address'}`) + '\n');
  process.stdout.write(fields([
    ['network', networkName],
    ['address', address],
  ]) + '\n');
  process.stdout.write('\n  it needs one block to confirm — then: ada balance\n');
}
