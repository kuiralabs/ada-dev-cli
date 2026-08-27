// Wallet lifecycle: generate, list, use, info, remove.
//
// A named-wallet model with one active wallet, so most other commands take no
// address argument. Keys live in ~/.ada/wallets — see lib/wallet-store.ts for why
// they are unencrypted and why mainnet is refused.

import { generateMnemonic } from '@meshsdk/core';
import type { Args } from '../lib/argv.ts';
import { flagValue, hasFlag } from '../lib/argv.ts';
import { loadConfig, saveConfig, resolveNetwork } from '../lib/cli-config.ts';
import { usageError, configError } from '../lib/errors.ts';
import { writeJson } from '../lib/json-output.ts';
import {
  assertWalletName, listWallets, loadWallet, saveWallet, removeWallet,
  walletExists, rememberAddresses, walletPath, type StoredWallet,
} from '../lib/wallet-store.ts';
import { makeProvider, openWallet, addressesOf } from '../lib/mesh.ts';
import { seal, open, sameSecret, passphraseFromEnv, PASSPHRASE_ENV } from '../lib/keystore.ts';
import { EXIT_INTERNAL } from '../lib/exit-codes.ts';
import { AdaError } from '../lib/errors.ts';
import { fields, heading, ok, warn, emphasis } from '../ui/format.ts';
import { dim } from '../ui/colors.ts';

const SUBCOMMANDS = ['generate', 'import', 'encrypt', 'list', 'use', 'info', 'remove'] as const;
type Subcommand = (typeof SUBCOMMANDS)[number];

/**
 * BIP-39 strength in **bits of entropy**, not words — `generateMnemonic` comes
 * straight from bip39 and takes bits. 256 bits yields the 24-word phrase that is
 * the Cardano convention; passing 24 raises "Invalid entropy", which is how this
 * was found.
 */
const MNEMONIC_ENTROPY_BITS = 256;
const EXPECTED_WORDS = 24;

export default async function wallet(args: Args): Promise<void> {
  const [sub] = args.positionals;
  if (!sub) throw usageError('wallet needs a subcommand', `one of: ${SUBCOMMANDS.join(', ')}`);
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw usageError(`unknown wallet subcommand: ${sub}`, `one of: ${SUBCOMMANDS.join(', ')}`);
  }

  switch (sub as Subcommand) {
    case 'generate': return generate(args);
    case 'import': return importWallet(args);
    case 'encrypt': return encryptWallet(args);
    case 'list': return list(args);
    case 'use': return use(args);
    case 'info': return info(args);
    case 'remove': return remove(args);
  }
}

async function generate(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const name = assertWalletName(args.positionals[1] ?? requireName());

  if (walletExists(name) && !hasFlag(args, 'force')) {
    throw configError(
      `a wallet named ${name} already exists`,
      'choose another name, or pass --force to replace it',
    );
  }

  const config = loadConfig();
  const network = resolveNetwork(config, flagValue(args, 'network'));

  const stored: StoredWallet = {
    name,
    mnemonic: assertWordCount(generateMnemonic(MNEMONIC_ENTROPY_BITS)),
    addresses: {},
    stakeAddresses: {},
    accountIndex: 0,
    createdAt: new Date().toISOString(),
  };
  saveWallet(stored);

  // Derive immediately so the wallet is useful without a second call, and cache
  // the result so `wallet list` never has to touch key material.
  const provider = makeProvider(network);
  const mesh = await openWallet(stored, network, provider);
  const { payment, stake } = await addressesOf(mesh);
  rememberAddresses(stored, network.name, payment, stake);

  // A freshly generated wallet becomes active: it is what the user just asked for,
  // and leaving the previous one active is a reliable source of confusion.
  saveConfig({ ...config, activeWallet: name });

  if (json) {
    writeJson({
      name, network: network.name, paymentAddress: payment, stakeAddress: stake,
      active: true, createdAt: stored.createdAt,
      // The phrase is deliberately NOT included. `wallet info --show-mnemonic`
      // exists for that, so it never lands in a log by accident.
      mnemonicStored: walletPath(name),
    });
    return;
  }

  process.stdout.write(ok(`created wallet ${emphasis(name)} and made it active`) + '\n');
  process.stdout.write(fields([
    ['network', network.name],
    ['payment', payment],
    ['stake', stake],
    ['keys', walletPath(name)],
  ]) + '\n');
  process.stdout.write('\n' + warn('the recovery phrase is stored unencrypted — development keys only') + '\n');
}

/**
 * Take an existing recovery phrase into the named-wallet model.
 *
 * The phrase is read from **stdin**, never an argument: an argument lands in
 * shell history and is visible in `ps` to every process on the machine, which is
 * a poor place for key material even by the standards of a development tool.
 *
 *   ada wallet import trader < phrase.txt
 *   pbpaste | ada wallet import trader
 *
 * Everything after the phrase is the same work `generate` does, so a wallet that
 * arrived this way is indistinguishable from one this tool created.
 */
async function importWallet(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const name = assertWalletName(args.positionals[1] ?? requireName());

  if (walletExists(name) && !hasFlag(args, 'force')) {
    throw configError(
      `a wallet named ${name} already exists`,
      'choose another name, or pass --force to replace it',
    );
  }

  const mnemonic = normalizeMnemonic(await readStdin());
  const config = loadConfig();
  const network = resolveNetwork(config, flagValue(args, 'network'));

  const stored: StoredWallet = {
    name,
    mnemonic,
    addresses: {},
    stakeAddresses: {},
    accountIndex: 0,
    createdAt: new Date().toISOString(),
  };

  // Derive BEFORE writing anything. A phrase with one word mistyped has the
  // right word count and fails only here; saving first would leave a wallet file
  // for a phrase that was refused, which the user then has to know to delete.
  const provider = makeProvider(network);
  const { payment, stake } = await deriveOrExplain(stored, network, provider);

  saveWallet(stored);
  rememberAddresses(stored, network.name, payment, stake);
  saveConfig({ ...config, activeWallet: name });

  if (json) {
    // The phrase is never echoed: the caller already has it, and a copy in a log
    // or a captured stdout is a copy that outlives the reason for it.
    writeJson({
      name, network: network.name, paymentAddress: payment, stakeAddress: stake,
      active: true, imported: true, createdAt: stored.createdAt,
      mnemonicStored: walletPath(name),
    });
    return;
  }

  process.stdout.write(ok(`imported wallet ${emphasis(name)} and made it active`) + '\n');
  process.stdout.write(fields([
    ['network', network.name],
    ['payment', payment],
    ['stake', stake],
    ['keys', walletPath(name)],
  ]) + '\n');
  process.stdout.write('\n' + warn('the recovery phrase is stored unencrypted — development keys only') + '\n');
}

/** The phrase, from stdin. Refuses an interactive terminal rather than hanging. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw usageError(
      'the recovery phrase is read from stdin',
      'pipe it in, so it never reaches shell history: ada wallet import <name> < phrase.txt',
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The phrase with its incidental whitespace and casing removed. */
function normalizeMnemonic(raw: string): string {
  const words = raw.trim().toLowerCase().split(/\s+/).filter((w) => w !== '');
  if (words.length !== EXPECTED_WORDS) {
    throw usageError(
      `expected a ${EXPECTED_WORDS}-word recovery phrase, got ${words.length}`,
      'Cardano wallets use 24 words',
    );
  }
  return words.join(' ');
}

/**
 * Derive the addresses, turning a rejected phrase into an answer about the phrase.
 *
 * BIP-39's checksum is the check that matters, and the key derivation already
 * enforces it — so no separate word-list dependency is needed to catch a
 * mistyped word. What derivation does not do is explain itself: it says
 * "Invalid mnemonic checksum", which reads as an internal fault rather than
 * "you typed a word wrong". The distinction is worth making, because a phrase
 * that is merely *different* would derive a perfectly good address for a wallet
 * the user does not own, and anything sent there is gone.
 */
async function deriveOrExplain(
  stored: StoredWallet,
  network: Parameters<typeof openWallet>[1],
  provider: Parameters<typeof openWallet>[2],
): Promise<{ payment: string; stake: string }> {
  try {
    return await addressesOf(await openWallet(stored, network, provider));
  } catch (err) {
    if (/mnemonic|checksum/i.test(String((err as Error)?.message ?? err))) {
      throw usageError(
        'that is not a valid recovery phrase — a word is misspelled, or the words are out of order',
        'the BIP-39 checksum did not match. A single wrong word would otherwise derive a '
        + 'different wallet rather than fail, so it is refused here',
      );
    }
    throw err;
  }
}

/**
 * Seal a wallet's recovery phrase at rest.
 *
 * The passphrase comes from ADA_WALLET_PASSPHRASE. Not a prompt, because no path
 * an agent needs may block on one; not an argument, because command lines land
 * in shell history and in `ps` output for every process on the machine.
 *
 * This is what lets a wallet be used on mainnet: the refusal elsewhere is about
 * the phrase being readable, so it lifts exactly when it stops being readable.
 */
async function encryptWallet(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const name = assertWalletName(args.positionals[1] ?? requireName());
  const stored = loadWallet(name);

  if (stored.sealed !== undefined) {
    throw configError(`wallet ${name} is already encrypted`,
      'to change the passphrase, import the phrase again under a new name');
  }

  const passphrase = passphraseFromEnv();
  const sealed = seal(stored.mnemonic, passphrase);

  // Prove the seal opens before dropping the only readable copy. Sealing and
  // then failing to open would destroy the wallet, and the phrase is the wallet.
  if (!sameSecret(open(sealed, passphrase), stored.mnemonic)) {
    throw new AdaError('keystore_roundtrip_failed',
      'the encrypted phrase did not decrypt back to the original',
      EXIT_INTERNAL,
      'nothing was written; the wallet is untouched');
  }

  const { mnemonic: _dropped, ...rest } = stored;
  saveWallet({ ...rest, mnemonic: '', sealed });

  if (json) {
    writeJson({ name, encrypted: true, kdf: sealed.kdf, cipher: sealed.cipher, keys: walletPath(name) });
    return;
  }
  process.stdout.write(ok(`encrypted wallet ${emphasis(name)}`) + '\n');
  process.stdout.write(fields([
    ['kdf', `${sealed.kdf} (N=${sealed.n}, r=${sealed.r}, p=${sealed.p})`],
    ['cipher', sealed.cipher],
    ['keys', walletPath(name)],
  ]) + '\n');
  process.stdout.write('\n' + warn(
    `keep ${PASSPHRASE_ENV} safe — there is no recovery path for it, and without it `
    + 'this wallet cannot be opened') + '\n');
}

async function list(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const config = loadConfig();
  const network = resolveNetwork(config, flagValue(args, 'network'));
  const wallets = listWallets();

  if (json) {
    writeJson({
      network: network.name,
      activeWallet: config.activeWallet ?? null,
      wallets: wallets.map((w) => ({
        name: w.name,
        active: w.name === config.activeWallet,
        paymentAddress: w.addresses[network.name] ?? null,
        stakeAddress: w.stakeAddresses[network.name] ?? null,
        createdAt: w.createdAt,
      })),
    });
    return;
  }

  if (wallets.length === 0) {
    process.stdout.write('no wallets yet — create one with: ada wallet generate <name>\n');
    return;
  }

  process.stdout.write(heading(`Wallets (${network.name})`) + '\n');
  const width = wallets.reduce((max, w) => Math.max(max, w.name.length), 0);
  for (const w of wallets) {
    const marker = w.name === config.activeWallet ? '*' : ' ';
    const address = w.addresses[network.name];
    const shown = address ? `${address.slice(0, 24)}…` : dim('not derived for this network');
    process.stdout.write(` ${marker} ${w.name.padEnd(width)}  ${shown}\n`);
  }
}

async function use(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const name = assertWalletName(args.positionals[1] ?? requireName());
  loadWallet(name); // fails with an actionable message if absent

  const config = loadConfig();
  saveConfig({ ...config, activeWallet: name });

  if (json) writeJson({ activeWallet: name });
  else process.stdout.write(ok(`active wallet is now ${emphasis(name)}`) + '\n');
}

async function info(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const config = loadConfig();
  const network = resolveNetwork(config, flagValue(args, 'network'));
  // Precedence: a positional, then --wallet, then the active wallet.
  //
  // --wallet was ignored here, so `wallet info --wallet bob` reported the active
  // wallet's address with ok:true — the same defect review already found in
  // `balance` and `utxos`, missed in this one. A flag that silently selects the
  // wrong account is worse than one that does not exist, and here it means
  // reading somebody else's address and building a datum around it.
  const name = args.positionals[1] ?? flagValue(args, 'wallet') ?? config.activeWallet;
  if (!name) {
    throw configError('no wallet selected', 'pass a name, or set one with: ada wallet use <name>');
  }

  const stored = loadWallet(name);
  const provider = makeProvider(network);
  const mesh = await openWallet(stored, network, provider);
  const { payment, stake } = await addressesOf(mesh);
  rememberAddresses(stored, network.name, payment, stake);

  // Opt-in and never in JSON by default: a recovery phrase in a captured log is
  // the whole key. An agent has no reason to read one.
  const showMnemonic = hasFlag(args, 'show-mnemonic');

  if (json) {
    writeJson({
      name: stored.name,
      network: network.name,
      paymentAddress: payment,
      stakeAddress: stake,
      derivationPath: `m/1852'/1815'/${stored.accountIndex}'/0/0`,
      accountIndex: stored.accountIndex,
      active: stored.name === config.activeWallet,
      createdAt: stored.createdAt,
      ...(showMnemonic ? { mnemonic: stored.mnemonic } : {}),
    });
    return;
  }

  process.stdout.write(heading(`Wallet ${stored.name}`) + '\n');
  process.stdout.write(fields([
    ['network', network.name],
    ['payment', payment],
    ['stake', stake],
    ['path', `m/1852'/1815'/${stored.accountIndex}'/0/0`],
    ['active', stored.name === config.activeWallet ? 'yes' : 'no'],
    ['created', stored.createdAt],
  ]) + '\n');
  if (showMnemonic) {
    process.stdout.write('\n' + warn('recovery phrase — treat as the key itself') + '\n');
    process.stdout.write(`  ${stored.mnemonic}\n`);
  }
}

async function remove(args: Args): Promise<void> {
  const json = hasFlag(args, 'json');
  const name = assertWalletName(args.positionals[1] ?? requireName());
  loadWallet(name);

  // Deleting the only copy of an unencrypted key is irreversible, so it needs an
  // explicit acknowledgement. --yes exists so an agent is never blocked on a
  // prompt, per the output contract.
  if (!hasFlag(args, 'yes')) {
    throw usageError(
      `removing ${name} deletes its recovery phrase permanently`,
      'pass --yes to confirm',
    );
  }

  removeWallet(name);
  const config = loadConfig();
  if (config.activeWallet === name) {
    const { activeWallet: _dropped, ...rest } = config;
    saveConfig(rest);
  }

  if (json) writeJson({ removed: name, activeWalletCleared: config.activeWallet === name });
  else process.stdout.write(ok(`removed wallet ${name}`) + '\n');
}

/**
 * Guard the entropy-versus-words confusion permanently.
 *
 * A silently short phrase would be a weaker key that still worked, which is worse
 * than a crash — so the count is checked rather than assumed.
 */
function assertWordCount(mnemonic: string): string {
  const words = mnemonic.trim().split(/\s+/).length;
  if (words !== EXPECTED_WORDS) {
    throw configError(
      `generated a ${words}-word phrase, expected ${EXPECTED_WORDS}`,
      'MNEMONIC_ENTROPY_BITS is bits of entropy, not a word count',
    );
  }
  return mnemonic;
}

function requireName(): never {
  throw usageError('this subcommand needs a wallet name', 'example: ada wallet generate alice');
}
