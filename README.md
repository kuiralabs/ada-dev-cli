# ada-dev-cli

A Cardano development CLI. Run a local devnet, fund a wallet, check balances, transfer ADA and
native assets, and settle two-party atomic swaps — all from the terminal.

It is a developer instrument, not a consumer wallet: it works on devnet, preview and preprod, and
**refuses mainnet outright**.

Built for two audiences: **developers** starting a Cardano project who want a funded wallet on a
local chain in under five minutes, and **AI agents** (Claude Code, Cursor, any MCP client) using
the same primitives through a built-in MCP server.

> **Status: working, not yet released.** Wallets, balances, funding, transfers, native assets,
> atomic swaps, the devnet lifecycle, chain inspection and Aiken contracts all work, verified against
> a local devnet and against preprod. **Not on npm yet** — see Install below. `ada help --json`
> reports which commands are implemented; `tasks/IMPLEMENTATION.md` is the full checklist.

## Install

Not on npm yet, so link it from a clone:

```sh
git clone https://github.com/kuiralabs/ada-dev-cli
cd ada-dev-cli
npm install
npm run build     # the global binary runs the bundle, not the sources
npm link          # puts `ada` on your PATH
```

Then `ada status` should answer. To remove it: `npm unlink -g ada-dev-cli`.

**Working on the code?** `npx tsx src/ada.ts <command>` runs the sources directly, so you skip the
rebuild. The linked `ada` keeps running the last `npm run build` until you run it again — worth
knowing before you wonder why a change had no effect.

## Why this exists

Doing anything on Cardano takes four separate things: a chain to talk to, a way to ask it
questions, somewhere to keep keys, and a way to build transactions. Each is a different project
with its own interface, and each is good at its job — but getting from nothing to *"I sent a
transaction and I can see why it failed"* means learning all four first.

This is one interface over them. It composes rather than reimplements, and fills the gaps nobody
covers: transfers between arbitrary addresses, native-asset bundles, atomic swaps, and a single
agent-callable surface across the lot.

**`docs/STACK.md` is the map** — what each project in the stack is, what it is for, and which of
the two APIs a local chain serves answers which kind of question. Worth ten minutes before writing
any Cardano code, whether or not you use this tool.

## Planned commands

| Command | Description |
|---------|-------------|
| `ada wallet generate <name>` | Create a named wallet and set it as active |
| `ada wallet list` | List wallets with the active marker |
| `ada wallet use <name>` | Set the active wallet |
| `ada wallet info [name]` | Show payment address, stake address, derivation path |
| `ada wallet remove <name>` | Remove a wallet |
| `ada info` | Active wallet, network, service URLs |
| `ada balance [address]` | ADA plus every native asset held |
| `ada utxos [address]` | The unspent outputs behind that balance |
| `ada transfer <to> <amount>` | Send ADA |
| `ada airdrop <amount>` | Fund a wallet or raw address from the devnet faucet |
| `ada asset mint` | Mint a native asset under a policy |
| `ada asset send <to> <asset> <qty>` | Send a native-asset bundle |
| `ada swap build` | Build a two-party atomic swap offer |
| `ada swap inspect` | Show exactly what an offer would do before signing |
| `ada swap sign` | Co-sign a received offer |
| `ada swap submit` | Submit the fully-signed swap |
| `ada address derive` | Derive an address through `cardano-address`, cross-checked against the wallet |
| `ada address inspect` | Decode an address and show its parts |
| `ada tip` | Current chain tip |
| `ada slot [+30m]` | Convert between slots and POSIX time, both directions |
| `ada hash <value>` | blake2b digests, for commitments inside a datum |
| `ada params` | Protocol parameters — fee coefficients, min-UTxO, execution limits |
| `ada status` | Chain, devnet and wallet in one call |
| `ada localnet up/stop/down/status/logs` | Manage a local devnet |
| `ada localnet snapshot/rollback` | Mark a point in the chain's history, and return to it |
| `ada localnet addresses` | The devnet's pre-funded genesis accounts |
| `ada config get/set/unset` | Persistent config — network, active wallet, endpoints |
| `ada localnet bootstrap` | Download devkit components without starting anything |
| `ada localnet reset` | Wipe the chain and start fresh |
| `ada help [command]` | Usage for all or one command |
| `ada manual` | Full reference — every command, every flag |

### Contracts

Aiken validators, from compiling one to spending what it guards.

| Command | Description |
|---------|-------------|
| `ada contract build` / `check` | Compile, and run the validator's own tests — delegated to `aiken` |
| `ada contract inspect` | What the blueprint declares: validators, handlers, datum and redeemer shapes |
| `ada contract address` | The script address, derived from the code. No chain call, no fee |
| `ada contract lock` | Pay to a script address with a datum |
| `ada contract unlock` | Spend a script UTxO with a redeemer — this is the call |
| `ada contract utxos` | What sits at the script address, with each datum's encoding |
| `ada contract simulate` | Execution units and fee, without submitting |
| `ada contract publish` | A CIP-33 reference script — the honest reading of "deploy" |
| `ada contract mint` | Mint or burn under a Plutus policy; a negative quantity burns |

Run `ada help --json` for the current list — it marks which commands are implemented.

**Public testnets need no setup.** `--network preprod` or `--network preview` works on any read
command with no account and no API key, via the free community API. Set `ADA_BLOCKFROST_KEY` if you
prefer Blockfrost or want higher rate limits.

Installing provides two binaries: `ada` and `ada-mcp`.

## How it works

- `docs/STACK.md` — **start here.** What every piece in the stack is, who makes it, and why it is
  there. Yaci DevKit, Yaci Store, MeshJS, cardano-node, and the two APIs the local chain serves.
- `docs/ARCHITECTURE.md` — how our own code is arranged, and a command traced end to end.
- `docs/DEVNET.md` — running the local chain, and diagnosing it when it will not start.

## Built on

Deliberately composed rather than written from scratch:

- **[MeshJS](https://meshjs.dev)** — wallet, transaction building, native assets, multi-signature
  co-signing. The headless server-side wallet is what makes a CLI possible without a browser
  extension.
- **[Yaci DevKit](https://devkit.yaci.xyz)** — the local devnet: one-second blocks, a faucet, a
  bundled Blockfrost-compatible indexer, and multi-node mode for rollback testing.
- **[cardano-address](https://github.com/IntersectMBO/cardano-addresses)** — derivation and
  address ground truth.

## MCP server

`ada-mcp` will expose the wallet operations as tools, so an agent can fund a wallet, send a
transfer, and read back the result without a human copying commands between a terminal and a chat
window. Not built yet — stage 3.

Yaci DevKit ships its own MCP server for chain operations — devnet lifecycle, faucet, rollback.
The two are complementary and do not overlap: theirs owns the chain, this one owns the wallet.

## License

Apache-2.0
