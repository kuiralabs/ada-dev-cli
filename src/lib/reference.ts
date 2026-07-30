// The command reference, as data.
//
// One source for `help`, `help <command>` and `manual`, so the three cannot drift
// apart — which they would, because they are the documentation people read after
// the README stops matching.

export interface FlagDoc {
  flag: string;
  description: string;
}

export interface CommandDoc {
  name: string;
  usage: string;
  summary: string;
  implemented: boolean;
  /** Longer explanation for `manual`. Omitted where the summary says it all. */
  detail?: string;
  flags?: FlagDoc[];
  examples?: string[];
}

export const GLOBAL_FLAGS: FlagDoc[] = [
  { flag: '--json', description: 'machine-readable output on stdout; one document, success or failure' },
  { flag: '--network <name>', description: 'devnet, preprod or preview — overrides the configured default for this run' },
  { flag: '--wallet <name>', description: 'act on a named wallet instead of the active one' },
  { flag: '--yes', description: 'confirm an action that moves money, mints, or deletes a key' },
  { flag: '--version, -v', description: 'print the version' },
  { flag: '--help, -h', description: 'usage for a command' },
];

export const COMMANDS: CommandDoc[] = [
  {
    name: 'localnet',
    usage: 'ada localnet <up|down|stop|status|logs|bootstrap|reset>',
    summary: 'Manage the local devnet',
    implemented: true,
    detail:
      'Runs a real Cardano chain locally — a block a second, twenty pre-funded addresses. First run '
      + 'downloads about 1.4 GB; after that it starts in about nine seconds. `status` reports the '
      + 'process and the API separately, and flags a chain that answers but is not producing blocks.',
    flags: [{ flag: '--block-time <seconds>', description: 'between 1 and 20; sub-second is not supported' }],
    examples: ['ada localnet up', 'ada localnet status --json', 'ada localnet reset --yes'],
  },
  {
    name: 'status',
    usage: 'ada status',
    summary: 'One-shot health check: chain, devnet, wallet',
    implemented: true,
    detail:
      'The right first call when something is wrong. Never fails for an unreachable chain — it '
      + 'reports it. Detects a chain that answers queries while producing no blocks, which otherwise '
      + 'looks healthy while transactions sit unconfirmed.',
    examples: ['ada status', 'ada status --network preprod --json'],
  },
  {
    name: 'tip', usage: 'ada tip', summary: 'Current chain tip', implemented: true,
    examples: ['ada tip', 'ada tip --network preprod --json'],
  },
  {
    name: 'params',
    usage: 'ada params',
    summary: 'Protocol parameters — fee coefficients, min-UTxO, limits',
    implemented: true,
    detail:
      'Explains why a fee is what it is (fee = minFeeA x txSizeBytes + minFeeB) and why an output '
      + 'may be rejected as too small.',
  },
  {
    name: 'info', usage: 'ada info', summary: 'Active network, endpoints and config location', implemented: true,
  },
  {
    name: 'wallet',
    usage: 'ada wallet <generate|list|use|info|remove> [name]',
    summary: 'Manage wallets',
    implemented: true,
    detail:
      'A named-wallet model with one active wallet. Keys live in ~/.ada/wallets at mode 0600, '
      + 'UNENCRYPTED — these are development keys, and mainnet is refused outright for that reason. '
      + '`info` shows the payment address, the stake address and the derivation path; the two '
      + 'addresses are not interchangeable.',
    flags: [
      { flag: '--show-mnemonic', description: 'print the recovery phrase (wallet info only)' },
      { flag: '--force', description: 'replace an existing wallet of the same name (generate only)' },
    ],
    examples: ['ada wallet generate alice', 'ada wallet use bob', 'ada wallet remove alice --yes'],
  },
  {
    name: 'balance',
    usage: 'ada balance [wallet|address]',
    summary: 'ADA and native assets held',
    implemented: true,
    detail:
      'Reports ADA and every native asset, plus the UTxO count. On this ledger a balance is a sum '
      + 'over a set of unspent outputs — when a number looks wrong, `utxos` is what explains it.',
    examples: ['ada balance', 'ada balance bob', 'ada balance addr_test1... --json'],
  },
  {
    name: 'utxos',
    usage: 'ada utxos [wallet|address]',
    summary: 'Unspent outputs behind a balance',
    implemented: true,
  },
  {
    name: 'airdrop',
    usage: 'ada airdrop <ada> [--address <addr>]',
    summary: 'Fund from the devnet faucet',
    implemented: true,
    detail: 'Devnet only — a public network has no faucet. Needs one block to confirm.',
    flags: [{ flag: '--address <addr>', description: 'fund a raw address instead of the active wallet' }],
  },
  {
    name: 'transfer',
    usage: 'ada transfer <to> <ada> [--yes]',
    summary: 'Send ADA — dry run without --yes',
    implemented: true,
    detail:
      'Without --yes the transaction is fully built and its real fee, change and outputs are '
      + 'reported, but nothing is submitted. With --yes the same build is signed and sent. One code '
      + 'path, so the fee shown is the fee charged — and a fee estimate is this command minus a flag.',
    flags: [{ flag: '--lovelace', description: 'interpret the amount as lovelace rather than ADA' }],
    examples: ['ada transfer addr_test1... 10', 'ada transfer addr_test1... 10 --yes'],
  },
  {
    name: 'asset',
    usage: 'ada asset <policy|mint|send>',
    summary: 'Native assets: policy, mint, send bundles',
    implemented: true,
    detail:
      'Minting uses a native-script policy controlled by one key — no Plutus — and the policy is '
      + 'deterministic from the wallet, so mints are repeatable. Metadata follows CIP-25 so an asset '
      + 'displays in wallets and explorers. `send` moves a bundle: several distinct assets in one '
      + 'transaction, which is what the ledger natively supports.',
    flags: [
      { flag: '--name <name>', description: 'asset name, 1 to 32 bytes (mint)' },
      { flag: '--qty <n>', description: 'whole number above zero (mint)' },
      { flag: '--description <text>', description: 'CIP-25 metadata description (mint)' },
    ],
    examples: [
      'ada asset policy',
      'ada asset mint --name Silk --qty 100 --yes',
      'ada asset send addr_test1... <unit>:25 <otherUnit>:10 --yes',
    ],
  },
  {
    name: 'contract',
    usage: 'ada contract <inspect|address|lock|unlock>',
    summary: 'Aiken validators — inspect, address, lock funds, unlock them',
    implemented: true,
    detail:
      'A Cardano validator is a pure predicate over (datum, redeemer, transaction). It holds no '
      + 'state and there is no deploy step: its address is a hash of its compiled code, so it exists '
      + 'the moment the contract compiles. `address` therefore makes no chain call and costs nothing.\n\n'
      + 'Both subcommands read the CIP-57 `plutus.json` that `aiken build` produces, found next to '
      + 'the current directory or in a conventional subdirectory, or named with --blueprint. A '
      + 'blueprint lists an entry per handler, so one validator appears several times sharing a '
      + 'hash; --module and --validator narrow it, the same axis `aiken` itself uses.\n\n'
      + 'A validator with unapplied parameters has no single address — applying them changes the '
      + 'compiled code, so the hash, so the address. `address` refuses to answer in that case and '
      + 'names the parameters still missing rather than reporting one of many possible answers.\n\n'
      + '`lock` pays to the script address with a datum attached — this is how state comes into '
      + 'existence here, as an output carrying data rather than a write to a contract. `unlock` '
      + 'spends such an output with a redeemer, and **that is the call**: a validator runs only as '
      + 'part of validating the transaction consuming its output. Both are dry runs until --yes.\n\n'
      + 'Datums are inline (CIP-32) by default. A hash-stored datum cannot be recovered from the '
      + 'chain, so the spender must already hold it, and the devnet indexer serves no lookup for '
      + 'one. Collateral is chosen automatically from a pure-ADA output; if every output in the '
      + 'wallet carries a native asset the error says how to make one.',
    flags: [
      { flag: '--blueprint <path>', description: 'path to plutus.json, or a directory holding one' },
      { flag: '--module <name>', description: 'module to select when several validators exist' },
      { flag: '--validator <name>', description: 'validator to select within that module' },
      { flag: '--params <json>', description: 'JSON array of compile-time parameters, in declared order' },
      { flag: '--amount <ada>', description: 'how much to lock' },
      { flag: '--datum-signer', description: 'datum holding your own public key hash (lock)' },
      { flag: '--datum <json>', description: 'datum as Plutus data JSON (lock)' },
      { flag: '--redeemer-message <text>', description: 'redeemer of one text field (unlock)' },
      { flag: '--redeemer <json>', description: 'redeemer as Plutus data JSON (unlock)' },
      { flag: '--tx-in <hash>#<ix>', description: 'which script UTxO to spend when several exist' },
    ],
    examples: [
      'ada contract inspect',
      'ada contract inspect --module oneshot --validator gift_card --json',
      'ada contract address',
      'ada contract address --module oneshot --validator gift_card --params \'["deadbeef"]\'',
      'ada contract lock --amount 5 --datum-signer --yes',
      'ada contract unlock --redeemer-message "Hello, World!" --yes',
    ],
  },
  {
    name: 'swap',
    usage: 'ada swap <build|inspect|sign|submit>',
    summary: 'Two-party atomic swap — no contract needed',
    implemented: true,
    detail:
      'One transaction built from both parties\' inputs and requiring both signatures, so either '
      + 'both sides move or nothing does. The maker builds and partially signs, which commits them. '
      + 'The taker inspects, then signs, then either party submits.\n\n'
      + '`inspect` is the safety-critical step and stays separate from `sign`: a received offer is '
      + 'untrusted input, and everything reported is derived from the transaction itself rather than '
      + 'from the offer\'s description. An offer whose description disagrees with its transaction is '
      + 'reported as misrepresented and refused.',
    flags: [
      { flag: '--with <addr>', description: 'the counterparty (build)' },
      { flag: '--give <spec>', description: 'what you give: "10ADA" or "<unit>:<qty>", comma-separated' },
      { flag: '--want <spec>', description: 'what you want back, same format' },
    ],
    examples: [
      'ada swap build --with addr_test1... --give <unit>:20 --want 50ADA --yes',
      'ada swap inspect <offer> --json',
      'ada swap sign <offer> --yes',
      'ada swap submit <offer>',
    ],
  },
  {
    name: 'address',
    usage: 'ada address inspect <addr>',
    summary: 'Decode an address into its parts',
    implemented: true,
    detail:
      'Classifies an address as base, enterprise or stake and shows its credentials. Derivation is '
      + 'deliberately absent: it is delegated to the official cardano-address tool rather than gaining '
      + 'a second implementation that could disagree with the authoritative one.',
  },
  {
    name: 'config',
    usage: 'ada config <list|get|set|unset> [key] [value]',
    summary: 'Persistent configuration',
    implemented: true,
    detail:
      'Settable: network, activeWallet, endpoints.<network>.apiUrl, endpoints.<network>.adminUrl. '
      + 'Public networks need no configuration — a free community API is the default. An unparseable '
      + 'config file is preserved as config.json.invalid rather than overwritten.',
    examples: ['ada config list --json', 'ada config set network preprod'],
  },
  { name: 'help', usage: 'ada help [command]', summary: 'Usage for all or one command', implemented: true },
  { name: 'manual', usage: 'ada manual', summary: 'Full reference — every command, every flag', implemented: true },
];

export const findCommand = (name: string): CommandDoc | undefined =>
  COMMANDS.find((c) => c.name === name);
