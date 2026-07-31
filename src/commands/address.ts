// Decode an address into its parts.
//
// `derive` is deliberately absent: turning a recovery phrase into an address is the
// highest-consequence step in the stack, and this tool delegates that to the
// official `cardano-address` binary rather than adding a second implementation that
// could disagree with the authoritative one. `inspect` is safe to do here because
// decoding cannot lose anyone's money.

import { deserializeAddress } from '@meshsdk/core';
import type { Args } from '../lib/argv.ts';
import { hasFlag, flagValue } from '../lib/argv.ts';
import { usageError, configError, AdaError } from '../lib/errors.ts';
import { EXIT_INTERNAL } from '../lib/exit-codes.ts';
import { loadConfig, resolveNetwork } from '../lib/cli-config.ts';
import { loadWallet } from '../lib/wallet-store.ts';
import { derive as deriveWithReference } from '../lib/cardano-address.ts';
import { writeJson } from '../lib/json-output.ts';
import { fields, heading } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

const SUBCOMMANDS = ['inspect', 'derive'] as const;

export default async function address(args: Args): Promise<void> {
  const [sub, value] = args.positionals;
  if (sub === 'derive') return derive(args);
  if (sub !== 'inspect') {
    throw usageError(
      sub ? `unknown address subcommand: ${sub}` : 'address needs a subcommand',
      `one of: ${SUBCOMMANDS.join(', ')}`,
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


// ── derive ───────────────────────────────────────────────────────────
//
// Delegated to `cardano-address`, IntersectMBO's own tool, and never
// reimplemented. Derivation is the highest-consequence cryptography here: it
// does not fail loudly when wrong, it succeeds at the wrong address, and funds
// sent there are gone. A second implementation could only disagree with the
// authoritative one.
//
// Which makes this also a cross-check. Our wallet derives through MeshJS; asking
// the reference tool the same question for the same phrase is exactly the oracle
// property the whole stack was chosen for.

async function derive(args: Args): Promise<void> {
  const config = loadConfig();
  const network = resolveNetwork(config, flagValue(args, 'network'));

  const name = args.positionals[1] ?? flagValue(args, 'wallet') ?? config.activeWallet;
  if (!name) {
    throw configError('no wallet selected', 'pass a name, or set one with: ada wallet use <name>');
  }
  const stored = loadWallet(name);

  const account = Number(flagValue(args, 'account') ?? stored.accountIndex ?? 0);
  const index = Number(flagValue(args, 'index') ?? 0);
  const role = Number(flagValue(args, 'role') ?? 0);
  for (const [label, n] of [['--account', account], ['--index', index], ['--role', role]] as const) {
    if (!Number.isInteger(n) || n < 0) throw usageError(`${label} must be a whole number, got: ${n}`);
  }

  const derived = deriveWithReference(stored.mnemonic, network.name, account, index, role);

  // Compare against what the wallet itself holds, when the path is the one it
  // was created at. A disagreement here is the most serious thing this tool
  // could report, so it is surfaced rather than left for someone to notice.
  const stem = index === 0 && role === 0 && account === (stored.accountIndex ?? 0);
  const ours = stem ? stored.addresses?.[network.name] : undefined;
  const agrees = ours ? ours === derived.paymentAddress : undefined;

  if (agrees === false) {
    throw new AdaError('derivation_mismatch',
      `cardano-address derives ${derived.paymentAddress} where this wallet holds ${ours}`,
      EXIT_INTERNAL,
      'two implementations disagree about this wallet\'s address — do not send funds to it');
  }

  if (hasFlag(args, 'json')) {
    writeJson({
      wallet: name,
      network: network.name,
      path: derived.path,
      paymentAddress: derived.paymentAddress,
      stakeAddress: derived.stakeAddress,
      enterpriseAddress: derived.enterpriseAddress,
      derivedBy: derived.tool,
      ...(agrees === undefined ? {} : { matchesWallet: agrees }),
    });
    return;
  }

  process.stderr.write(heading('Derived address') + '\n');
  process.stderr.write(fields([
    ['wallet', name],
    ['network', network.name],
    ['path', derived.path],
    ['payment', derived.paymentAddress],
    ['stake', derived.stakeAddress],
    ['enterprise', derived.enterpriseAddress],
    ['derived by', derived.tool],
    ...(agrees === undefined ? [] : [['matches wallet', agrees ? 'yes' : 'NO'] as [string, string]]),
  ]) + '\n\n');
  process.stdout.write(derived.paymentAddress + '\n');
}
