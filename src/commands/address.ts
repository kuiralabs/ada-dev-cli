// Decode an address into its parts.
//
// `derive` is deliberately absent: turning a recovery phrase into an address is the
// highest-consequence step in the stack, and this tool delegates that to the
// official `cardano-address` binary rather than adding a second implementation that
// could disagree with the authoritative one. `inspect` is safe to do here because
// decoding cannot lose anyone's money.

import { deserializeAddress } from '@meshsdk/core';
import type { Args } from '../lib/argv.ts';
import { hasFlag } from '../lib/argv.ts';
import { usageError } from '../lib/errors.ts';
import { writeJson } from '../lib/json-output.ts';
import { fields, heading } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

const SUBCOMMANDS = ['inspect'] as const;

export default async function address(args: Args): Promise<void> {
  const [sub, value] = args.positionals;
  if (sub !== 'inspect') {
    throw usageError(
      sub ? `unknown address subcommand: ${sub}` : 'address needs a subcommand',
      `one of: ${SUBCOMMANDS.join(', ')} — derivation is delegated to the cardano-address tool`,
    );
  }
  if (!value) throw usageError('address inspect needs an address', 'example: ada address inspect addr_test1...');

  const isTestnet = value.startsWith('addr_test') || value.startsWith('stake_test');
  const isStake = value.startsWith('stake');
  if (!value.startsWith('addr') && !isStake) {
    throw usageError(
      `not a Cardano address: ${value}`,
      'expected a bech32 string beginning with addr, addr_test, stake or stake_test',
    );
  }

  let parts: ReturnType<typeof deserializeAddress>;
  try {
    parts = deserializeAddress(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw usageError(`could not decode the address: ${message}`, 'a checksum failure usually means a truncated copy-paste');
  }

  // A base address carries both a payment credential and a stake credential; an
  // enterprise address carries only payment and therefore earns no rewards. That
  // distinction is the practical reason to inspect an address at all.
  const hasStake = parts.stakeCredentialHash !== '' || parts.stakeScriptCredentialHash !== '';
  const isScript = parts.scriptHash !== '';
  const kind = isStake ? 'stake' : hasStake ? 'base' : 'enterprise';

  if (hasFlag(args, 'json')) {
    writeJson({
      address: value,
      kind,
      network: isTestnet ? 'testnet' : 'mainnet',
      isScript,
      paymentKeyHash: parts.pubKeyHash || null,
      paymentScriptHash: parts.scriptHash || null,
      stakeKeyHash: parts.stakeCredentialHash || null,
      stakeScriptHash: parts.stakeScriptCredentialHash || null,
    });
    return;
  }

  process.stdout.write(heading('Address') + '\n');
  process.stdout.write(fields([
    ['kind', kind],
    ['network', isTestnet ? 'testnet' : 'mainnet'],
    ['payment', parts.pubKeyHash || parts.scriptHash || '—'],
    ['stake', parts.stakeCredentialHash || parts.stakeScriptCredentialHash || '—'],
    ['script', isScript ? 'yes' : 'no'],
  ]) + '\n');
  if (kind === 'enterprise') {
    process.stdout.write(dim('  no stake credential — this address cannot earn staking rewards\n'));
  }
}
