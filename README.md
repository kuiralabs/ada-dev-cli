# ada-wallet-cli

A standalone CLI wallet for Cardano. Manage wallets, check balances, transfer ADA and native
assets, run a local devnet, and settle two-party atomic swaps — all from the terminal.

Built for two audiences: **developers** starting a Cardano project who want a funded wallet on a
local chain in under five minutes, and **AI agents** (Claude Code, Cursor, any MCP client) using
the same primitives through a built-in MCP server.

> **Status: pre-implementation.** The command surface below is designed and the stack is chosen;
> the code is not written yet. Nothing is published to npm. See `docs/COMMANDS.md` for the full
> surface and `tasks/todo.md` for build order.

## Why this exists

Cardano has excellent tooling, but it is spread across four projects with four interfaces: a
devnet manager, a node CLI that is not a wallet, a separate address tool, and a wallet daemon.
Getting from nothing to "I sent a transaction and can see why it failed" means learning all of
them.

This is one umbrella over the good parts. It does not reimplement them — it composes them, and
adds the pieces nobody ships: transfers between arbitrary addresses, native-asset bundles,
atomic swaps, and a single agent-callable surface over the lot.

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
| `ada address derive` | Derive an address from a mnemonic and path |
| `ada address inspect` | Decode an address and show its parts |
| `ada tip` | Current chain tip |
| `ada fee estimate` | Fee, change, and minimum-value check before committing |
| `ada localnet up/stop/down/status/logs/reset` | Manage a local devnet via Docker |
| `ada localnet snapshot/rollback` | Rollback testing against a forked chain |
| `ada config get/set/unset` | Persistent config — network, active wallet, endpoints |
| `ada help [command]` | Usage for all or one command |
| `ada manual` | Full reference — every command, every flag |

Installing will provide two binaries: `ada` and `ada-mcp`.

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

`ada-mcp` exposes the wallet operations as tools, so an agent can fund a wallet, send a transfer,
and read back the result without a human copying commands between a terminal and a chat window.

Yaci DevKit ships its own MCP server for chain operations — devnet lifecycle, faucet, rollback.
The two are complementary and do not overlap: theirs owns the chain, this one owns the wallet.

## License

Apache-2.0
