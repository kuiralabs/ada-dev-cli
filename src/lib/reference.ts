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
  /**
   * Emits one JSON document per event rather than one per invocation.
   *
   * The output contract is "exactly one document per call", which a watch loop
   * cannot honour and should not pretend to: an agent following a build wants
   * the rebuilds as they happen. Declared here rather than explained in prose,
   * so the contract has a stated exception a test can check instead of an
   * undocumented one it silently permits.
   */
  streaming?: boolean;
  flags?: FlagDoc[];
  examples?: string[];
}

/**
 * Accepted by every command, without exception.
 *
 * Kept to the three that genuinely are. `--network`, `--wallet` and `--yes` were
 * listed here and are not: `ada hash x --network preprod` and `ada airdrop 1000
 * --yes` were both rejected while this table called the flags global. A flag
 * documented as universal has to be universal, or the documentation is the bug.
 */
export const GLOBAL_FLAGS: FlagDoc[] = [
  { flag: '--json', description: 'machine-readable output on stdout; one document, success or failure' },
  { flag: '--version, -v', description: 'print the version' },
  { flag: '--help, -h', description: 'usage for a command' },
];

/**
 * Flags shared by several commands but not by all.
 *
 * `help <command>` shows only the ones that command actually takes, which it can
 * decide from the same specification that validates them — so the two cannot
 * disagree about whether a flag exists.
 */
export const SHARED_FLAGS: FlagDoc[] = [
  { flag: '--network <name>', description: 'devnet, preprod or preview — overrides the configured default for this run' },
  { flag: '--wallet <name>', description: 'act on a named wallet instead of the active one' },
  { flag: '--yes', description: 'build *and submit*; without it the command stops at a dry run' },
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
    name: 'dev',
    streaming: true,
    usage: 'ada dev [--path <dir>]',
    summary: 'Watch Aiken sources and rebuild, warning when the address moves',
    implemented: true,
    detail:
      'Watches validators/ and lib/ for .ak changes and runs `aiken check` on each save, '
      + 'reporting the tests and the script hash.\n\n'
      + '**The reason it exists is the address.** A validator has no identity apart from its '
      + 'compiled code — the address is a hash of it — so every source edit moves the address. '
      + 'Anything locked at the old one cannot be spent by the new build, and nothing says so: '
      + '`contract address` reports the new address perfectly happily and the funds at the old one '
      + 'simply stop being mentioned. This loop says the address changed, and how much is sitting '
      + 'at the address you just left behind.\n\n'
      + 'A validator taking compile-time parameters has no single address until they are applied, '
      + 'so pass --params to have the address tracked; without them the hash is still reported. '
      + 'With several validators in one blueprint, --module and --validator choose which to follow.\n\n'
      + 'Rebuilds are debounced and serialised: an editor writes a file several times per save, and '
      + 'a compile started while the previous one is running races on plutus.json.\n\n'
      + 'With --json this is a stream rather than a single result: one document per rebuild, one '
      + 'document per line, and nothing else on stdout. The usual contract is one document per '
      + 'invocation, which a loop cannot honour — so the exception is declared on the command and '
      + 'checked, rather than left for a reader to discover.',
    flags: [
      { flag: '--path <dir>', description: 'the project to watch; defaults to the current directory' },
      { flag: '--params <json>', description: 'compile-time parameters, so the address can be tracked' },
      { flag: '--module <name>', description: 'module to follow when several validators exist' },
      { flag: '--validator <name>', description: 'validator to follow within that module' },
      { flag: '--blueprint <path>', description: 'path to plutus.json, if not beside the sources' },
    ],
    examples: [
      'ada dev',
      'ada dev --path ./bounty_board',
      'ada dev --params \'["<hash>",1785481194000,2000000]\'',
    ],
  },
  {
    name: 'tip', usage: 'ada tip', summary: 'Current chain tip', implemented: true,
    examples: ['ada tip', 'ada tip --network preprod --json'],
  },
  {
    name: 'tx',
    usage: 'ada tx status <hash>',
    summary: 'Where a transaction has got to: on-chain, queued, or gone',
    implemented: true,
    detail:
      'Submitting returns a hash and nothing else, and from there the only way to find out what '
      + 'happened was to poll a balance and infer. Inference cannot tell the two failures apart: a '
      + 'transaction still queued and one that was dropped are both simply absent from the chain.\n\n'
      + 'Three states, and they call for different actions — `on-chain` (done), `in-mempool` '
      + '(accepted, do nothing), and `not-found` (never submitted or dropped, so the retry is '
      + 'yours). Telling the middle one from the last needs a node: an indexer cannot see a '
      + 'mempool. Where Ogmios is reachable this asks it; where it is not, the answer says so '
      + 'rather than guessing, because "queued" and "gone" look identical from outside.\n\n'
      + '`--wait` polls until the transaction confirms or three minutes pass. Without a mempool to '
      + 'consult it degrades to the poll you would have written anyway.',
    flags: [
      { flag: '--wait', description: 'keep checking until it confirms, or three minutes pass' },
    ],
    examples: [
      'ada tx status 4a9412c72e5eaac1...',
      'ada tx status <hash> --wait',
      'ada tx status <hash> --network preprod --json',
    ],
  },
  {
    name: 'slot',
    usage: 'ada slot [now|+<duration>|<slot>|<posix-ms>]',
    summary: 'Convert between slots and time, in both directions',
    implemented: true,
    detail:
      'A transaction declares its validity in **slots**; a validator reads that same window in '
      + '**POSIX milliseconds**. Passing one where the other is meant compares a number near 1,500 '
      + 'against one near 1,785,478,000,000 — it never matches, and the failure arrives as '
      + '`ValidationTagMismatch`, which reads as a broken script rather than wrong units.\n\n'
      + 'So every answer gives both numbers. Use the slot for --valid-until and --valid-from; use '
      + 'the milliseconds for a deadline inside a validator or a datum.\n\n'
      + 'A duration is measured from the **chain tip**, not the local clock, because a machine a '
      + 'few seconds out produces a window the chain disagrees with. The conversion itself is '
      + 'derived from the chain — a devnet from its own genesis, a public network from the known '
      + 'parameters — and checked against the tip before it is used. Where the forecast horizon is '
      + 'knowable, a point beyond it is flagged: a node cannot place such a slot in time, so a '
      + 'deadline there can never be met.',
    flags: [
      { flag: '--network <name>', description: 'which chain to ask' },
    ],
    examples: [
      'ada slot',
      'ada slot +30m',
      'ada slot 12345',
      'ada slot 1785478477000',
    ],
  },
  {
    name: 'hash',
    usage: 'ada hash <value>',
    summary: 'blake2b digests, for commitments that go inside a datum',
    implemented: true,
    detail:
      'A commit-reveal contract — a sealed bid, a hidden move, a bounty answer — puts a hash '
      + 'on-chain and the preimage nowhere until someone spends. Writing one therefore needs '
      + 'blake2b-256 before any transaction exists, and that is the one primitive the surrounding '
      + 'toolchain does not offer: not in the Cardano libraries, and not in Node, which stops at '
      + 'blake2b-512.\n\n'
      + 'A validator hashes **bytes**. Text is hashed as its UTF-8 encoding; pass --hex when the '
      + 'input already is those bytes, since hashing the characters of a hex string instead of what '
      + 'they denote silently gives a different digest.',
    flags: [
      { flag: '--algo <name>', description: 'blake2b-256 (default) or blake2b-224' },
      { flag: '--hex', description: 'the input is already hex-encoded bytes' },
    ],
    examples: [
      'ada hash "a river"',
      'ada hash 61207269766572 --hex',
      'ada hash "a river" --algo blake2b-224',
    ],
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
    usage: 'ada contract <build|check|inspect|address|utxos|lock|unlock|simulate|publish|mint>',
    summary: 'Aiken validators — build, inspect, lock, unlock, simulate, publish, mint',
    implemented: true,
    detail:
      'A Cardano validator is a pure predicate over (datum, redeemer, transaction). It holds no '
      + 'state and there is no deploy step: its address is a hash of its compiled code, so it exists '
      + 'the moment the contract compiles. `address` therefore makes no chain call and costs nothing.\n\n'
      + '`build` and `check` delegate to the `aiken` compiler, which owns compilation and a '
      + 'validator\'s own tests. Aiken emits a JSON report only to a pipe and its diagnostics only '
      + 'to a terminal, so both are collected: the report is captured, and a failure with no report '
      + 'triggers a second run whose output is directed at stderr, where the diagnostic reaches you '
      + 'without ever entering the JSON on stdout.\n\n'
      + '`utxos` lists what sits at a script address with each datum\'s encoding — this is the '
      + 'closest thing to contract state, since a validator itself holds nothing.\n\n'
      + 'The reading subcommands take the CIP-57 `plutus.json` that `aiken build` produces, found next to '
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
      + 'one. --datum-hash opts into that encoding anyway, since the reference Aiken example uses '
      + 'it and a UTxO made by another tool may carry one; unlocking such an output then requires '
      + 'the original datum via --datum. Collateral is chosen automatically from a pure-ADA output; '
      + 'if every output in the wallet carries a native asset the error says how to make one.\n\n'
      + '`simulate` runs the validator and reports the execution units it needs against the chain\'s '
      + 'limits, without submitting. The ledger requires that budget declared up front: too low and '
      + 'the script aborts mid-run and the collateral is forfeited, too high and you overpay.\n\n'
      + '`publish` writes a CIP-33 reference script — the validator\'s bytes parked in a UTxO so '
      + 'later transactions point at them instead of each carrying a copy. It is the only operation '
      + 'here that genuinely publishes code once, and the honest reading of "deploy". By default the '
      + 'output sits at the script address where nobody can spend it, which is what makes the '
      + 'reference dependable; --to-self keeps the ADA recoverable.\n\n'
      + '`mint` mints or burns under a Plutus policy, where the script hash is the policy id. A '
      + 'negative --qty burns. --spend names a UTxO the policy requires be consumed, which is how a '
      + 'one-shot policy guarantees it can only ever mint once. `asset mint` remains the '
      + 'native-script path for when you just want a token and have no contract.\n\n'
      + 'Three flags exist for what real validators check. `--read-only` adds CIP-31 reference '
      + 'inputs, read without being spent, which is how an oracle pattern reads a price without '
      + 'consuming it. `--signer` names other parties whose signature the validator requires — it '
      + 'declares the requirement rather than producing the signature, so the transaction cannot '
      + 'settle until that key has signed. `--valid-from`/`--valid-until`/`--valid-for` set the '
      + 'window a deadline validator reads; durations are measured from the **chain tip**, not the '
      + 'local clock, because a machine a few seconds off produces a window the chain disagrees '
      + 'with. Note that a node can only place slots in time a bounded distance ahead, which is '
      + 'much shorter on a devnet than on a public network.\n\n'
      + 'Two flags ask something else the same question. `--cross-check` has `cardano-cli` compute '
      + 'the script hash independently, and refuses to report an address the two disagree about — a '
      + 'confidently wrong address strands funds where nobody can reach them. `--verify-budget` asks '
      + 'a node, through Ogmios, for the execution units we computed locally; ours come from a Plutus '
      + 'VM in JavaScript, the node\'s from the implementation that will judge the transaction. '
      + 'Neither is required and neither can fail an operation: Ogmios is used where reachable, found '
      + 'via `ADA_OGMIOS_URL` or the devkit\'s default port on a local chain, and its absence is '
      + 'reported rather than assumed.\n\n'
      + '`unlock --mint` builds a spend and a mint in **one** transaction, under this validator\'s '
      + 'own policy. Some validators require exactly that — releasing funds only if a token is '
      + 'issued alongside makes the release and the token inseparable, so neither half is valid '
      + 'alone and building them separately cannot express it. The mint handler takes its own '
      + 'redeemer, which is usually a different type from the spend\'s.\n\n'
      + '`unlock --continue` carries state forward instead of draining the script. It returns value '
      + 'to the same address with a new datum given by --continue-datum, which is what makes a '
      + 'validator a state machine rather than a one-shot escrow — an auction raising a bid, a '
      + 'vesting schedule releasing a tranche, an order partially filled. The address is not asked '
      + 'for and cannot be: a continuing output returns to the validator being spent, and a typo '
      + 'would send the contract\'s state somewhere it can never be spent from again. `--pay` '
      + 'covers the other half of that shape, an output to somebody who is not the spender — the '
      + 'bidder being displaced, the party being refunded. Change cannot express it, because change '
      + 'all returns to one address.\n\n'
      + 'Execution budgets are declared with headroom over what the local evaluator computes. The '
      + 'two Plutus implementations do not cost every step alike and the local one under-counts, so '
      + 'a budget set to its exact figure can be refused by a node that then aborts the script part '
      + 'way through — reported as though the validator were at fault. The margin costs a fraction '
      + 'of a lovelace and removes the class of failure; `simulate` reports the figure that will be '
      + 'declared.',
    flags: [
      { flag: '--blueprint <path>', description: 'path to plutus.json, or a directory holding one' },
      { flag: '--module <name>', description: 'module to select when several validators exist' },
      { flag: '--validator <name>', description: 'validator to select within that module' },
      { flag: '--params <json>', description: 'JSON array of compile-time parameters, in declared order' },
      { flag: '--path <dir>', description: 'the project directory to work in — every subcommand; defaults to the current one' },
      { flag: '--continue <ada>', description: 'value returned to the script, carrying its state forward (unlock)' },
      { flag: '--continue-datum <json>', description: 'the new state on that continuing output (unlock)' },
      { flag: '--pay <addr>:<ada>', description: 'pay a third party in the same transaction — a refund, a payout (unlock); comma-separate several' },
      { flag: '--amount <ada>', description: 'how much to lock' },
      { flag: '--datum-signer', description: 'datum holding your own public key hash (lock)' },
      { flag: '--datum <json>', description: 'datum as Plutus data JSON (lock); the original datum (unlock, hash-stored only)' },
      { flag: '--datum-hash', description: 'store only the datum hash rather than inline (lock)' },
      { flag: '--redeemer-message <text>', description: 'redeemer of one text field (unlock)' },
      { flag: '--redeemer <json>', description: 'redeemer as Plutus data JSON (unlock)' },
      { flag: '--tx-in <hash>#<ix>', description: 'which script UTxO to spend when several exist' },
      { flag: '--name <text>', description: 'asset name (mint)' },
      { flag: '--qty <n>', description: 'quantity; negative burns (mint)' },
      { flag: '--spend <hash>#<ix>', description: 'UTxO the policy requires be consumed (mint)' },
      { flag: '--to-self', description: 'park a reference script where it can be recovered (publish)' },
      { flag: '--read-only <ref>', description: 'UTxOs to read without spending (CIP-31), comma-separated' },
      { flag: '--signer <hash>', description: 'other public-key hashes the validator requires, comma-separated' },
      { flag: '--valid-from <slot|now>', description: 'earliest slot the transaction may be accepted' },
      { flag: '--valid-until <slot>', description: 'latest slot the transaction may be accepted' },
      { flag: '--valid-for <duration>', description: 'window length from the chain tip, e.g. 30m' },
      { flag: '--cross-check', description: 'ask cardano-cli for the same script hash (address)' },
      { flag: '--verify-budget', description: 'ask a node for the same execution units (simulate)' },
      { flag: '--mint <name>:<qty>', description: 'mint in the same transaction as the spend (unlock)' },
      { flag: '--mint-redeemer <json>', description: 'the mint handler\'s own redeemer' },
    ],
    examples: [
      'ada contract build',
      'ada contract check',
      'ada contract inspect',
      'ada contract utxos',
      'ada contract inspect --module oneshot --validator gift_card --json',
      'ada contract address',
      'ada contract address --module oneshot --validator gift_card --params \'["deadbeef"]\'',
      'ada contract lock --amount 5 --datum-signer --yes',
      'ada contract unlock --redeemer-message "Hello, World!" --yes',
      'ada contract simulate --redeemer-message "Hello, World!"',
      'ada contract publish --yes',
      'ada contract mint --name GiftCard --qty 1 --redeemer \'{"alternative":0,"fields":[]}\' --yes',
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
      { flag: '--offer <blob>', description: 'the offer, when not passed as a positional argument' },
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
    usage: 'ada address <inspect|derive> <addr|wallet>',
    summary: 'Decode an address, or derive one at a chosen path',
    implemented: true,
    detail:
      'Classifies an address as base, enterprise or stake and shows its credentials.\n\n'
      + '`derive` produces the address at a chosen CIP-1852 path, which is how you reach an '
      + 'account or index other than the wallet\'s default. It does not implement derivation: it '
      + 'shells out to IntersectMBO\'s `cardano-address`, because this is the highest-consequence '
      + 'cryptography here — an address derived wrongly does not fail, it succeeds at the wrong '
      + 'place, and funds sent there are gone. A second implementation could only ever disagree '
      + 'with the authoritative one, so the tool makes that one convenient instead.\n\n'
      + 'The staking key always comes from role 2 at index 0, which is what CIP-1852 specifies: a '
      + 'base address pairs one payment key with the account\'s single staking key, so the role-2 '
      + 'path does not vary with the payment index.',
    flags: [
      { flag: '--account <n>', description: "CIP-1852 account index; defaults to the wallet's own" },
      { flag: '--index <n>', description: 'address index within the account (default 0)' },
      { flag: '--role <n>', description: '0 for external addresses, 1 for change (default 0)' },
    ],
    examples: [
      'ada address inspect addr_test1...',
      'ada address derive alice --index 3',
      'ada address derive alice --account 1 --role 1 --json',
    ],
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
