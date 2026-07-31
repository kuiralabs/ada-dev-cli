// MCP tool definitions.
//
// Two rules shape this list.
//
// **Only wallet and chain primitives are exposed.** Yaci DevKit ships its own MCP
// server for devnet operations, so duplicating the chain lifecycle would mean two
// things to keep correct. Ours owns the wallet; theirs owns the chain. The
// `localnet` tools here are the minimum needed to answer "is there a chain" and get
// one — not a second control surface.
//
// **Annotations are honest, and there are two tiers of protection.**
//
//   readOnlyHint      no state change; safe to call unasked
//   destructiveHint   has a side effect; the client should ask
//   + a consent token cannot proceed at all without an explicit confirm
//
// The token tier is reserved for what cannot be undone: spending, minting,
// committing to a swap, deleting a key, wiping a chain. Creating a wallet,
// funding one from a devnet faucet whose money is worthless, and stopping a
// disposable local chain are marked destructive but not token-gated — a token on
// every side effect would train an agent to redeem them without reading.

import { loadConfig } from '../cli-config.ts';

export interface ToolAnnotations {
  /** No state change. Safe to call without asking the user. */
  readOnlyHint?: boolean;
  /** Moves funds, deletes keys, or tears down infrastructure. */
  destructiveHint?: boolean;
  /** Repeated calls with the same arguments give the same result. */
  idempotentHint?: boolean;
  /** Touches the network, the chain, or an external process. */
  openWorldHint?: boolean;
}

export interface ToolDef {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /** CLI command this maps to, and how arguments become argv. */
  command: string;
  toArgv: (input: Record<string, unknown>) => string[];
  /** Present on tools that require consent before executing. */
  describeForConsent?: (input: Record<string, unknown>) => string;
  /**
   * Rewrite the command's document for an agent audience.
   *
   * The CLI's hints are written for someone at a terminal and name flags. Over MCP
   * a flag is meaningless — an agent told to "pass --yes" has no way to act on it —
   * so a tool may replace guidance with the tool call that actually applies.
   */
  transformResult?: (document: Record<string, unknown>) => Record<string, unknown>;
}

const NETWORK = {
  type: 'string',
  enum: ['devnet', 'preprod', 'preview'],
  description: 'Override the configured network for this call. Omit to use the active one.',
};

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * The wallet a call would act on if none is named.
 *
 * Read at description time so consent text says which account, not "the active
 * one" — an agent may have switched it earlier in the session, and a user
 * approving a vague description has not approved the account it turns out to mean.
 */
function activeWalletName(): string {
  try {
    return loadConfig().activeWallet ?? '(none selected)';
  } catch {
    // A description is not worth failing a tool call over.
    return '(unknown)';
  }
}

/** Append `--network` when supplied, so every tool handles it identically. */
const withNetwork = (input: Record<string, unknown>, argv: string[]): string[] => {
  const n = str(input.network);
  return n ? [...argv, '--network', n] : argv;
};


/** Blueprint selection flags, shared by every contract tool. */
const blueprintArgv = (i: Record<string, unknown>): string[] => {
  const out: string[] = [];
  for (const [key, flag] of [['blueprint', '--blueprint'], ['module', '--module'], ['validator', '--validator']] as const) {
    const v = str(i[key]);
    if (v) out.push(flag, v);
  }
  return out;
};

const paramsArgv = (i: Record<string, unknown>): string[] => {
  const v = str(i.params);
  return v ? ['--params', v] : [];
};

export const TOOLS: ToolDef[] = [
  // ── Reading ────────────────────────────────────────────────
  {
    name: 'ada_status',
    description:
      'One-shot health check: is the chain reachable, is the devnet running, which wallet is active. '
      + 'Call this first when something is wrong — it never fails for an unreachable chain, it reports it.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: { network: NETWORK } },
    command: 'status',
    toArgv: (i) => withNetwork(i, []),
  },
  {
    name: 'ada_tip',
    description: 'Current chain tip: height, slot, epoch, block hash.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: { network: NETWORK } },
    command: 'tip',
    toArgv: (i) => withNetwork(i, []),
  },
  {
    name: 'ada_params',
    description:
      'Protocol parameters: fee coefficients, the per-byte cost that sets an output minimum, and size limits. '
      + 'Use this to explain why a fee is what it is, or why an output was rejected as too small.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: { network: NETWORK } },
    command: 'params',
    toArgv: (i) => withNetwork(i, []),
  },
  {
    name: 'ada_wallet_list',
    description: 'List wallets, marking which is active.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { network: NETWORK } },
    command: 'wallet',
    toArgv: (i) => withNetwork(i, ['list']),
  },
  {
    name: 'ada_wallet_info',
    description:
      'A wallet\'s payment address, stake address and derivation path. '
      + 'The two addresses are not interchangeable: payment receives funds, stake identifies for rewards.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Wallet name. Omit for the active wallet.' },
        network: NETWORK,
      },
    },
    command: 'wallet',
    toArgv: (i) => withNetwork(i, str(i.name) ? ['info', str(i.name)!] : ['info']),
  },
  {
    name: 'ada_balance',
    description:
      'ADA and every native asset held, plus the UTxO count. Accepts a wallet name or a raw address.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Wallet name or addr… address. Omit for the active wallet.' },
        network: NETWORK,
      },
    },
    command: 'balance',
    toArgv: (i) => withNetwork(i, str(i.target) ? [str(i.target)!] : []),
  },
  {
    name: 'ada_utxos',
    description:
      'The unspent outputs behind a balance. On Cardano a balance is a sum over a set, '
      + 'so when a number looks wrong this is what explains it.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Wallet name or address. Omit for the active wallet.' },
        network: NETWORK,
      },
    },
    command: 'utxos',
    toArgv: (i) => withNetwork(i, str(i.target) ? [str(i.target)!] : []),
  },
  {
    name: 'ada_address_inspect',
    description: 'Decode an address: base, enterprise or stake, its network, and its credentials.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { address: { type: 'string' } },
      required: ['address'],
    },
    command: 'address',
    toArgv: (i) => ['inspect', String(i.address)],
  },
  {
    name: 'ada_transfer_preview',
    description:
      'Build a transfer WITHOUT sending it, and report the exact fee, change and outputs. '
      + 'Always call this before ada_transfer: the fee is real, not an estimate, and it is the only '
      + 'chance to show the user what a send will cost.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient bech32 address.' },
        ada: { type: 'string', description: 'Amount in ADA, as a decimal string. Example: "10.5".' },
        wallet: { type: 'string', description: 'Sending wallet. Omit for the active one.' },
        network: NETWORK,
      },
      required: ['to', 'ada'],
    },
    command: 'transfer',
    toArgv: (i) => {
      const argv = [String(i.to), String(i.ada)];
      const w = str(i.wallet);
      return withNetwork(i, w ? [...argv, '--wallet', w] : argv);
    },
    transformResult: (doc) => ({
      ...doc,
      hint: doc.ok === true
        ? 'nothing was sent. To send it: show the fee and recipient to the user, get consent, then call ada_transfer followed by ada_confirm'
        : doc.hint,
    }),
  },

  // ── Changing state ────────────────────────────────────────
  {
    name: 'ada_wallet_generate',
    description:
      'Create a wallet and make it active. Keys are stored UNENCRYPTED on disk and mainnet is refused — '
      + 'these are development keys. Tell the user that before creating one.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Letters, digits, dashes or underscores.' },
        network: NETWORK,
      },
      required: ['name'],
    },
    command: 'wallet',
    toArgv: (i) => withNetwork(i, ['generate', String(i.name)]),
  },
  {
    name: 'ada_wallet_use',
    description: 'Set the active wallet, which changes what later calls act on.',
    annotations: { idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    command: 'wallet',
    toArgv: (i) => ['use', String(i.name)],
  },
  {
    name: 'ada_airdrop',
    description:
      'Fund an address from the local devnet faucet. Devnet only — a public network has no faucet. '
      + 'Safe: the money is worthless. Needs one block to confirm before it shows in a balance.',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ada: { type: 'string', description: 'Amount in ADA. Example: "1000".' },
        address: { type: 'string', description: 'Raw address to fund. Omit for the active wallet.' },
      },
      required: ['ada'],
    },
    command: 'airdrop',
    toArgv: (i) => {
      const a = str(i.address);
      return a ? [String(i.ada), '--address', a] : [String(i.ada)];
    },
  },
  {
    name: 'ada_localnet_up',
    description:
      'Start the local devnet. First run downloads about 1.4 GB and takes minutes; after that about '
      + 'nine seconds. Warn the user before a first run. Safe to call when already running.',
    annotations: { idempotentHint: true, openWorldHint: true },
    inputSchema: { type: 'object', properties: {} },
    command: 'localnet',
    toArgv: () => ['up'],
  },
  {
    name: 'ada_localnet_down',
    description: 'Stop the local devnet and every service it started. Chain state is lost.',
    annotations: { destructiveHint: true },
    inputSchema: { type: 'object', properties: {} },
    command: 'localnet',
    toArgv: () => ['down'],
  },

  {
    name: 'ada_asset_policy',
    description:
      'The minting policy id this wallet mints under. Deterministic from the wallet, so the same '
      + 'wallet always mints under the same policy. It is half of every asset identifier.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { wallet: { type: 'string' }, network: NETWORK } },
    command: 'asset',
    toArgv: (i) => withNetwork(i, str(i.wallet) ? ['policy', '--wallet', str(i.wallet)!] : ['policy']),
  },
  {
    name: 'ada_swap_inspect',
    description:
      'What a received swap offer would actually do to your balance. **Read-only and always safe.** '
      + 'The figures are derived from the transaction itself, not from the offer\'s description — an '
      + 'offer whose description was edited is flagged as misrepresented. Always call this before '
      + 'ada_swap_sign, and show the user the real numbers rather than the sender\'s claim.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        offer: { type: 'string', description: 'The offer blob from ada_swap_build.' },
        wallet: { type: 'string' }, network: NETWORK,
      },
      required: ['offer'],
    },
    command: 'swap',
    toArgv: (i) => {
      const argv = ['inspect', String(i.offer)];
      const w = str(i.wallet);
      return withNetwork(i, w ? [...argv, '--wallet', w] : argv);
    },
  },

  // ── Requires consent ──────────────────────────────────────
  {
    name: 'ada_transfer',
    description:
      'Send ADA. Does NOT execute on this call: it returns a pending token and a description. '
      + 'Show the description to the user verbatim, get explicit consent, then call ada_confirm with the token. '
      + 'Call ada_transfer_preview first so the fee is known before you ask.',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient bech32 address.' },
        ada: { type: 'string', description: 'Amount in ADA, as a decimal string.' },
        wallet: { type: 'string', description: 'Sending wallet. Omit for the active one.' },
        network: NETWORK,
      },
      required: ['to', 'ada'],
    },
    command: 'transfer',
    toArgv: (i) => {
      const argv = [String(i.to), String(i.ada), '--yes'];
      const w = str(i.wallet);
      return withNetwork(i, w ? [...argv, '--wallet', w] : argv);
    },
    // The wallet is named rather than described as "the active wallet". An agent
    // may have changed the active wallet earlier in the session, and consent given
    // against a vague description is not consent for the account it turns out to
    // mean. The name is resolved before the description is written.
    describeForConsent: (i) =>
      `Send ${String(i.ada)} ADA to ${String(i.to)} from wallet `
      + `${str(i.wallet) ?? activeWalletName()}`
      + (str(i.network) ? ` on ${str(i.network)}` : ''),
  },
  {
    name: 'ada_wallet_remove',
    description:
      'Delete a wallet and its recovery phrase permanently. Returns a pending token; '
      + 'get consent, then call ada_confirm.',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
    command: 'wallet',
    toArgv: (i) => ['remove', String(i.name), '--yes'],
    describeForConsent: (i) =>
      `Permanently delete wallet ${String(i.name)} and its recovery phrase. This cannot be undone.`,
  },
  {
    name: 'ada_asset_mint',
    description:
      'Mint a native asset under this wallet\'s policy. Returns a pending token; get consent, then '
      + 'call ada_confirm. Minting creates permanent supply and costs a fee.',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Asset name, 1-32 bytes.' },
        qty: { type: 'string', description: 'Whole number above zero.' },
        wallet: { type: 'string' }, network: NETWORK,
      },
      required: ['name', 'qty'],
    },
    command: 'asset',
    toArgv: (i) => {
      const argv = ['mint', '--name', String(i.name), '--qty', String(i.qty), '--yes'];
      const w = str(i.wallet);
      return withNetwork(i, w ? [...argv, '--wallet', w] : argv);
    },
    describeForConsent: (i) =>
      `Mint ${String(i.qty)} of a new asset named "${String(i.name)}" `
      + `under wallet ${str(i.wallet) ?? activeWalletName()}`,
  },
  {
    name: 'ada_asset_send',
    description:
      'Send native assets as a bundle — several distinct assets in one transaction. Returns a '
      + 'pending token; get consent, then call ada_confirm.',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient bech32 address.' },
        assets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Entries of the form "<unit>:<quantity>", where unit is policy id + hex name.',
        },
        wallet: { type: 'string' }, network: NETWORK,
      },
      required: ['to', 'assets'],
    },
    command: 'asset',
    toArgv: (i) => {
      const assets = Array.isArray(i.assets) ? i.assets.map(String) : [];
      const argv = ['send', String(i.to), ...assets, '--yes'];
      const w = str(i.wallet);
      return withNetwork(i, w ? [...argv, '--wallet', w] : argv);
    },
    describeForConsent: (i) =>
      `Send ${(Array.isArray(i.assets) ? i.assets : []).join(', ')} to ${String(i.to)} `
      + `from wallet ${str(i.wallet) ?? activeWalletName()}`,
  },
  {
    name: 'ada_swap_build',
    description:
      'Build a two-party atomic swap offer and partially sign it. **This commits you**: if the '
      + 'counterparty signs, the swap executes. Returns a pending token; get consent, then call '
      + 'ada_confirm. The result contains an offer blob to send to the counterparty.',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        counterparty: { type: 'string', description: 'Their bech32 address.' },
        give: { type: 'string', description: 'What you give: "10ADA" or "<unit>:<qty>", comma-separated.' },
        want: { type: 'string', description: 'What you want back, same format.' },
        wallet: { type: 'string' }, network: NETWORK,
      },
      required: ['counterparty', 'give', 'want'],
    },
    command: 'swap',
    toArgv: (i) => {
      const argv = ['build', '--with', String(i.counterparty), '--give', String(i.give),
        '--want', String(i.want), '--yes'];
      const w = str(i.wallet);
      return withNetwork(i, w ? [...argv, '--wallet', w] : argv);
    },
    describeForConsent: (i) =>
      `Offer ${String(i.give)} in exchange for ${String(i.want)} with ${String(i.counterparty)}. `
      + 'If they accept, this executes.',
  },
  {
    name: 'ada_swap_sign',
    description:
      'Sign a received swap offer, giving up your side. Refuses an offer that is expired, on the '
      + 'wrong network, unsigned by the maker, or whose description does not match its transaction. '
      + 'Returns a pending token; **call ada_swap_inspect first and show the user the real figures**, '
      + 'then get consent and call ada_confirm.',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        offer: { type: 'string' }, wallet: { type: 'string' }, network: NETWORK,
      },
      required: ['offer'],
    },
    command: 'swap',
    toArgv: (i) => {
      const argv = ['sign', String(i.offer), '--yes'];
      const w = str(i.wallet);
      return withNetwork(i, w ? [...argv, '--wallet', w] : argv);
    },
    describeForConsent: () =>
      'Sign this swap offer, giving up your side of it. Confirm the figures from ada_swap_inspect first.',
  },
  {
    name: 'ada_swap_submit',
    description:
      'Submit a fully-signed swap. Irreversible once it confirms. Returns a pending token; get '
      + 'consent, then call ada_confirm.',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: { offer: { type: 'string' }, wallet: { type: 'string' }, network: NETWORK },
      required: ['offer'],
    },
    command: 'swap',
    toArgv: (i) => {
      const argv = ['submit', String(i.offer)];
      const w = str(i.wallet);
      return withNetwork(i, w ? [...argv, '--wallet', w] : argv);
    },
    describeForConsent: () => 'Submit this swap to the chain. Once it confirms it cannot be undone.',
  },
  {
    name: 'ada_localnet_reset',
    description:
      'Wipe the devnet chain back to genesis. Wallet keys survive; every balance does not. '
      + 'Returns a pending token; get consent, then call ada_confirm.',
    annotations: { destructiveHint: true },
    inputSchema: { type: 'object', properties: {} },
    command: 'localnet',
    toArgv: () => ['reset', '--yes'],
    describeForConsent: () =>
      'Reset the local devnet to genesis. Wallet keys are kept, but every balance and transaction is lost.',
  },
  // ── Contracts ────────────────────────────────────────────────────
  {
    name: 'ada_contract_inspect',
    description:
      'Read an Aiken CIP-57 blueprint: which validators it declares, their handlers, datum and '
      + 'redeemer names, script hash, and any compile-time parameters that must be applied. '
      + 'Reads plutus.json; makes no chain call.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        blueprint: { type: 'string', description: 'Path to plutus.json, or a directory holding one.' },
        module: { type: 'string', description: 'Module name, when several validators exist.' },
        validator: { type: 'string', description: 'Validator name within that module.' },
      },
    },
    command: 'contract',
    toArgv: (i) => ['inspect', ...blueprintArgv(i)],
  },
  {
    name: 'ada_contract_address',
    description:
      'The script address a validator addresses to, derived from a hash of its compiled code. '
      + 'No chain call, no fee, no transaction — a Cardano validator has no deploy step and its '
      + 'address exists as soon as it compiles. Returns the same value as policyId, since for a '
      + 'minting validator the script hash IS the policy id. Fails with parameters_required when '
      + 'the validator has unapplied parameters, because those change the address.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        blueprint: { type: 'string' },
        module: { type: 'string' },
        validator: { type: 'string' },
        params: { type: 'string', description: 'JSON array of compile-time parameters, in declared order.' },
        network: NETWORK,
      },
    },
    command: 'contract',
    toArgv: (i) => withNetwork(i, ['address', ...blueprintArgv(i), ...paramsArgv(i)]),
  },
  {
    name: 'ada_contract_lock',
    description:
      'Lock ADA at a script address with a datum attached — this is how state comes into existence '
      + 'on Cardano, as an output carrying data rather than a write to a contract. Does NOT execute '
      + 'on this call: it returns a pending token and a description. Show the description verbatim, '
      + 'get explicit consent, then call ada_confirm. Funds become spendable only by satisfying the '
      + 'validator.',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ada: { type: 'string', description: 'Amount to lock, as a decimal string.' },
        datumSigner: { type: 'boolean', description: 'Datum holding this wallet\'s own public key hash. The common case.' },
        datum: { type: 'string', description: 'Datum as Plutus data JSON, for anything else.' },
        datumHash: { type: 'boolean', description: 'Store only the datum hash rather than inline. The datum is then NOT recoverable from the chain and must be kept to spend the output.' },
        blueprint: { type: 'string' },
        module: { type: 'string' },
        validator: { type: 'string' },
        params: { type: 'string' },
        wallet: { type: 'string' },
        network: NETWORK,
      },
      required: ['ada'],
    },
    command: 'contract',
    toArgv: (i) => {
      const argv = ['lock', '--amount', String(i.ada), ...blueprintArgv(i), ...paramsArgv(i), '--yes'];
      if (i.datumSigner) argv.push('--datum-signer');
      if (i.datumHash) argv.push('--datum-hash');
      const d = str(i.datum);
      if (d) argv.push('--datum', d);
      const w = str(i.wallet);
      return withNetwork(i, w ? [...argv, '--wallet', w] : argv);
    },
    describeForConsent: (i) =>
      `Lock ${String(i.ada)} ADA at a script address from wallet "${str(i.wallet) ?? 'the active wallet'}". `
      + 'It becomes spendable only by a transaction the validator approves. If the datum is wrong, '
      + 'or nobody can satisfy the validator, the funds are unrecoverable.',
  },
  {
    name: 'ada_contract_unlock',
    description:
      'Spend a UTxO sitting at a script address, supplying a redeemer. THIS IS THE CALL: a Cardano '
      + 'validator runs only as part of validating the transaction that consumes its output, and it '
      + 'either approves or the whole transaction is rejected. Does NOT execute on this call: it '
      + 'returns a pending token. Show the description verbatim, get consent, then call ada_confirm.',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        redeemerMessage: { type: 'string', description: 'Redeemer of a single text field. The common case.' },
        redeemer: { type: 'string', description: 'Redeemer as Plutus data JSON, for anything else.' },
        txIn: { type: 'string', description: 'Which script UTxO to spend, as <hash>#<index>. Needed when several exist.' },
        datum: { type: 'string', description: 'The original datum, required only when the output stored it as a hash.' },
        readOnly: { type: 'string', description: 'UTxOs to read without spending (CIP-31), as <hash>#<index>, comma-separated.' },
        signer: { type: 'string', description: 'Other public-key hashes the validator requires, comma-separated. Declares the requirement; does not produce the signature.' },
        validFrom: { type: 'string', description: 'Earliest slot, or "now" for the chain tip.' },
        validUntil: { type: 'string', description: 'Latest slot.' },
        validFor: { type: 'string', description: 'Window length from the chain tip, e.g. "30m". A node can only place slots in time a bounded distance ahead.' },
        blueprint: { type: 'string' },
        module: { type: 'string' },
        validator: { type: 'string' },
        params: { type: 'string' },
        wallet: { type: 'string' },
        network: NETWORK,
      },
    },
    command: 'contract',
    toArgv: (i) => {
      const argv = ['unlock', ...blueprintArgv(i), ...paramsArgv(i), '--yes'];
      const m = str(i.redeemerMessage);
      if (m !== undefined) argv.push('--redeemer-message', m);
      const r = str(i.redeemer);
      if (r) argv.push('--redeemer', r);
      const t = str(i.txIn);
      if (t) argv.push('--tx-in', t);
      const d = str(i.datum);
      if (d) argv.push('--datum', d);
      for (const [k, f] of [['readOnly', '--read-only'], ['signer', '--signer'],
                            ['validFrom', '--valid-from'], ['validUntil', '--valid-until'],
                            ['validFor', '--valid-for']] as const) {
        const v = str(i[k]);
        if (v) argv.push(f, v);
      }
      const w = str(i.wallet);
      return withNetwork(i, w ? [...argv, '--wallet', w] : argv);
    },
    describeForConsent: (i) =>
      `Spend a script UTxO into wallet "${str(i.wallet) ?? 'the active wallet'}" using redeemer `
      + `${str(i.redeemerMessage) ?? str(i.redeemer) ?? '(unspecified)'}. The validator runs during `
      + 'validation; if it rejects, the transaction fails and the collateral pledged is forfeited.',
  },
  {
    name: 'ada_contract_simulate',
    description:
      'Run a validator and report the execution units it needs, WITHOUT submitting. Cardano '
      + 'requires this budget declared up front: too low and the script aborts mid-run and the '
      + 'pledged collateral is forfeited, too high and the fee is wasted. Read-only — it moves no '
      + 'money and costs nothing. Call this before ada_contract_unlock when the validator is '
      + 'unfamiliar or the transaction is large.',
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        redeemerMessage: { type: 'string' },
        redeemer: { type: 'string' },
        txIn: { type: 'string' },
        datum: { type: 'string' },
        readOnly: { type: 'string', description: 'UTxOs to read without spending (CIP-31), as <hash>#<index>, comma-separated.' },
        signer: { type: 'string', description: 'Other public-key hashes the validator requires, comma-separated. Declares the requirement; does not produce the signature.' },
        validFrom: { type: 'string', description: 'Earliest slot, or "now" for the chain tip.' },
        validUntil: { type: 'string', description: 'Latest slot.' },
        validFor: { type: 'string', description: 'Window length from the chain tip, e.g. "30m". A node can only place slots in time a bounded distance ahead.' },
        blueprint: { type: 'string' },
        module: { type: 'string' },
        validator: { type: 'string' },
        params: { type: 'string' },
        wallet: { type: 'string' },
        network: NETWORK,
      },
    },
    command: 'contract',
    toArgv: (i) => {
      const argv = ['simulate', ...blueprintArgv(i), ...paramsArgv(i)];
      const m = str(i.redeemerMessage);
      if (m !== undefined) argv.push('--redeemer-message', m);
      for (const [k, f] of [['redeemer', '--redeemer'], ['txIn', '--tx-in'], ['datum', '--datum']] as const) {
        const v = str(i[k]);
        if (v) argv.push(f, v);
      }
      for (const [k, f] of [['readOnly', '--read-only'], ['signer', '--signer'],
                            ['validFrom', '--valid-from'], ['validUntil', '--valid-until'],
                            ['validFor', '--valid-for']] as const) {
        const v = str(i[k]);
        if (v) argv.push(f, v);
      }
      const w = str(i.wallet);
      return withNetwork(i, w ? [...argv, '--wallet', w] : argv);
    },
  },
  {
    name: 'ada_contract_publish',
    description:
      'Write a CIP-33 reference script: the validator\'s bytes parked in a UTxO so later '
      + 'transactions point at them instead of each carrying a copy. This is the closest thing '
      + 'Cardano has to a deploy step, and it is an optimisation rather than a requirement. Does '
      + 'NOT execute on this call: returns a pending token. Show the description verbatim, get '
      + 'consent, then call ada_confirm.',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        toSelf: { type: 'boolean', description: 'Park it where the ADA can be recovered. Default parks it at the script address, where nobody can spend it.' },
        blueprint: { type: 'string' },
        module: { type: 'string' },
        validator: { type: 'string' },
        params: { type: 'string' },
        wallet: { type: 'string' },
        network: NETWORK,
      },
    },
    command: 'contract',
    toArgv: (i) => {
      const argv = ['publish', ...blueprintArgv(i), ...paramsArgv(i), '--yes'];
      if (i.toSelf) argv.push('--to-self');
      const w = str(i.wallet);
      return withNetwork(i, w ? [...argv, '--wallet', w] : argv);
    },
    describeForConsent: (i) =>
      `Publish a reference script from wallet "${str(i.wallet) ?? 'the active wallet'}". `
      + (i.toSelf
        ? 'It is parked where you can spend it again, so the ADA is recoverable.'
        : 'It is parked at the script address, where nobody can spend it — the ADA it holds is locked permanently, which is what makes the reference dependable for others.'),
  },
  {
    name: 'ada_contract_mint',
    description:
      'Mint or burn under a Plutus policy, where the script hash IS the policy id. A negative '
      + 'quantity burns. Use ada_asset_mint instead for a simple native-script token with no '
      + 'contract behind it. Does NOT execute on this call: returns a pending token. Show the '
      + 'description verbatim, get consent, then call ada_confirm.',
    annotations: { destructiveHint: true, openWorldHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Asset name, as readable text.' },
        qty: { type: 'string', description: 'Quantity as a decimal string. Negative burns.' },
        redeemer: { type: 'string', description: 'Redeemer as Plutus data JSON.' },
        redeemerMessage: { type: 'string' },
        spend: { type: 'string', description: 'A UTxO the policy requires be consumed, as <hash>#<index>. How a one-shot policy guarantees it mints only once.' },
        readOnly: { type: 'string', description: 'UTxOs to read without spending (CIP-31), as <hash>#<index>, comma-separated.' },
        signer: { type: 'string', description: 'Other public-key hashes the validator requires, comma-separated. Declares the requirement; does not produce the signature.' },
        validFrom: { type: 'string', description: 'Earliest slot, or "now" for the chain tip.' },
        validUntil: { type: 'string', description: 'Latest slot.' },
        validFor: { type: 'string', description: 'Window length from the chain tip, e.g. "30m". A node can only place slots in time a bounded distance ahead.' },
        blueprint: { type: 'string' },
        module: { type: 'string' },
        validator: { type: 'string' },
        params: { type: 'string' },
        wallet: { type: 'string' },
        network: NETWORK,
      },
      required: ['name'],
    },
    command: 'contract',
    toArgv: (i) => {
      const argv = ['mint', '--name', String(i.name), ...blueprintArgv(i), ...paramsArgv(i), '--yes'];
      const q = str(i.qty);
      if (q) argv.push('--qty', q);
      const m = str(i.redeemerMessage);
      if (m !== undefined) argv.push('--redeemer-message', m);
      for (const [k, f] of [['redeemer', '--redeemer'], ['spend', '--spend']] as const) {
        const v = str(i[k]);
        if (v) argv.push(f, v);
      }
      for (const [k, f] of [['readOnly', '--read-only'], ['signer', '--signer'],
                            ['validFrom', '--valid-from'], ['validUntil', '--valid-until'],
                            ['validFor', '--valid-for']] as const) {
        const v = str(i[k]);
        if (v) argv.push(f, v);
      }
      const w = str(i.wallet);
      return withNetwork(i, w ? [...argv, '--wallet', w] : argv);
    },
    describeForConsent: (i) => {
      const q = str(i.qty) ?? '1';
      const burning = q.startsWith('-');
      return `${burning ? 'Burn' : 'Mint'} ${q.replace('-', '')} × "${String(i.name)}" under a Plutus policy `
        + `from wallet "${str(i.wallet) ?? 'the active wallet'}". `
        + (burning ? 'Burning destroys supply permanently.' : 'Minting creates permanent supply and costs a fee.');
    },
  },
];

/** Tools that must not execute before the user has agreed. */
export const CONSENT_TOOLS = new Set(
  TOOLS.filter((t) => t.describeForConsent !== undefined).map((t) => t.name),
);

export const byName = (name: string): ToolDef | undefined => TOOLS.find((t) => t.name === name);
