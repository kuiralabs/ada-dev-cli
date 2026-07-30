# Implementation tracker

**This is the feature checklist.** Every work session updates it: a row moves to done when its
tests pass and it has been exercised against a real devnet. `tasks/todo.md` holds the near-term
build order; this holds the full surface and where each piece stands.

The reference point is `midnight-wallet-cli` (`mn`), which covers the same job on Midnight. Parity
with it is the bar for "this tool is as useful as the one that already works" — with the
differences called out rather than smoothed over, because some Midnight concepts have no Cardano
counterpart and some Cardano capabilities have no Midnight one.

Legend: **done** · **next** (current stage) · **planned** (stage noted) · **none** (no
counterpart, reason given) · **open** (needs a decision)

---

## Where this stands

| | Count |
|---|---|
| Done | 5 commands, 53 offline tests, devnet lifecycle proven end to end, agent output contract |
| Next | wallets, balance, utxos, airdrop, transfer |
| Planned | MCP server, assets, swap, publish |
| No counterpart | 2 (`dust register`, `dust status`) |
| Open | 3 (`serve`, `dev`, `contract`) |

---

## Command parity with `mn`

| `mn` command | `ada` counterpart | Status |
|---|---|---|
| `wallet generate` | `wallet generate` | **next** |
| `wallet list` | `wallet list` | **next** |
| `wallet use` | `wallet use` | **next** |
| `wallet info` | `wallet info` — payment **and** stake address, derivation path | **next** |
| `wallet remove` | `wallet remove` | **next** |
| `info` | `info` | **done** |
| `balance` | `balance` — ADA **and** every native asset held | **next** |
| `transfer` | `transfer` — surfaces fee, change and min-value before submitting | **next** |
| `airdrop` | `airdrop` — devkit faucet (`topup`) | **next** |
| `address --seed` | `address derive` — delegates to `cardano-address`, never reimplemented | planned · stage 4 |
| `genesis-address` | `localnet addresses` — the 20 pre-funded devnet addresses | planned · stage 2 |
| `inspect-cost` | `params` — protocol parameters: fee coefficients, min-UTxO, max sizes | planned · stage 2 |
| `config get/set/unset` | `config get/set/unset/list` | **done** |
| `cache clear` | `cache clear` | planned · stage 4 |
| `localnet up` | `localnet up` | **done** |
| `localnet stop` | `localnet stop` | **done** |
| `localnet down` | `localnet down` | **done** |
| `localnet status` | `localnet status` — process and API reported separately | **done** |
| `localnet logs` | `localnet logs` | **done** |
| `localnet clean` | `localnet reset` | planned · stage 4 |
| `status` | `status` | planned · stage 4 |
| `help` | `help` — marks which commands are implemented | **done** |
| `manual` | `manual` | planned · stage 4 |
| `dust register` | — | **none** |
| `dust status` | — | **none** |
| `serve` (dApp connector) | — | **open** |
| `dev` (contract watch loop) | — | **open** |
| `contract inspect/deploy/call/state` | — | **open** |
| `test create/run/list/results` | `test` | planned · stage 4 |

### Why two have no counterpart

**`dust register` and `dust status` do not exist on Cardano.** Midnight uses a separate token to
pay fees, which has to be registered for and monitored, and a large share of `mn`'s complexity —
and of the Kuira SDK's error taxonomy — exists to manage it. Cardano pays fees in ADA out of the
same UTxOs being spent. The whole category disappears.

Worth stating explicitly rather than leaving as a gap: someone comparing the two tools will
notice the missing commands and should know it is an absence of a problem, not an absence of a
feature.

### The three open questions

**`serve`** — `mn` serves a dApp-connector WebSocket. Cardano's equivalent convention is
implemented by browser wallets, and it is not clear a CLI should compete with it. Decide before
stage 4; the answer may be "no".

**`dev`** — `mn`'s watch loop recompiles a contract on save. Cardano has no compile step in the
default path, so there may be nothing to watch. Revisit if scripts ever enter scope.

**`contract`** — Cardano has no deploy step: scripts travel with the transaction that uses them,
or are stored as reference outputs. `deploy` does not map. Deferred with the rest of the script
work, which nothing on the roadmap needs yet.

---

## Cardano capabilities with no `mn` counterpart

These are additions, not parity gaps. They exist because the ledger is different.

| `ada` command | Why it has no Midnight equivalent | Status |
|---|---|---|
| `utxos` | Balance is a sum over a UTxO set. When a number looks wrong, the next question is always which outputs produced it | **next** |
| `fee estimate` | Fees are a linear function of size and knowable before submitting — a dry run is possible here and is not on Midnight | **next** |
| `asset mint` | Native assets are ledger-level; no contract is needed to create a token | planned · stage 5 |
| `asset send` | Many distinct assets move in one output as a bundle | planned · stage 5 |
| `swap build` | Two-party atomic swap needs no smart contract — a ledger primitive | planned · stage 6 |
| `swap inspect` | A received offer is untrusted input; understanding it must be separable from signing it | planned · stage 6 |
| `swap sign` / `swap submit` | Co-signing one transaction built from both parties' inputs | planned · stage 6 |
| `address inspect` | Addresses carry a payment credential and a stake credential worth decoding | planned · stage 4 |
| `localnet snapshot` / `rollback` | The devkit can fork the chain, so rollback behaviour is testable | planned · stage 4 |

---

## MCP tool parity

`mn` exposes 23 tools. Its CLI-only commands (`contract`, `dev`, `test`, `serve`) are deliberately
**not** exposed — the MCP surface is the wallet and chain primitives. Same principle here.

| `mn` tool | `ada` tool | Status |
|---|---|---|
| `midnight_wallet_generate` | `ada_wallet_generate` | planned · stage 3 |
| `midnight_wallet_list` | `ada_wallet_list` | planned · stage 3 |
| `midnight_wallet_use` | `ada_wallet_use` | planned · stage 3 |
| `midnight_wallet_info` | `ada_wallet_info` | planned · stage 3 |
| `midnight_wallet_remove` | `ada_wallet_remove` | planned · stage 3 |
| `midnight_info` | `ada_info` | planned · stage 3 |
| `midnight_balance` | `ada_balance` | planned · stage 3 |
| `midnight_address` | `ada_address_derive` | planned · stage 3 |
| `midnight_genesis_address` | `ada_localnet_addresses` | planned · stage 3 |
| `midnight_inspect_cost` | `ada_params` | planned · stage 3 |
| `midnight_airdrop` | `ada_airdrop` | planned · stage 3 |
| `midnight_transfer` | `ada_transfer` | planned · stage 3 |
| `midnight_config_get/set/unset` | `ada_config_get/set/unset` | planned · stage 3 |
| `midnight_cache_clear` | `ada_cache_clear` | planned · stage 3 |
| `midnight_localnet_up/stop/down/status/clean` | `ada_localnet_up/stop/down/status/reset` | planned · stage 3 |
| `midnight_dust_register/status` | — | **none** (see above) |
| — | `ada_tip` | addition |
| — | `ada_utxos` | addition |
| — | `ada_fee_estimate` | addition |
| — | `ada_swap_*` | stage 6 |

One structural difference worth noting: Yaci DevKit ships **its own MCP server** for chain
operations. Where it already covers something well, ours should not duplicate it — theirs owns
the chain, ours owns the wallet. Revisit the `localnet_*` rows against that boundary at stage 3
rather than mirroring `mn` reflexively.

---

## Stages

Detail and ordering rationale in `tasks/todo.md`. Summary of what each stage closes:

**1 · Walking skeleton — done.** Scaffold, config, error taxonomy, devnet lifecycle, `tip`,
`info`, `help`. Devnet starts in ~9s with an advancing tip; 41 offline tests including
fails-before/passes-after regressions for the readiness wait, the process-group stop and the flag
parser.

**2 · Wallets and money — next.** Wallets, `balance`, `utxos`, `airdrop`, `transfer`,
`fee estimate`, `params`, `localnet addresses`. **Closing this is what unblocks the SDK work**,
because it is the fund-read-transfer loop everything gets debugged inside.

**3 · Agent surface — partly landed early.** The `--json` envelope, the stable `code` taxonomy and
`docs/SKILL.md` are done, because the contract could not be retrofitted once commands multiplied.
Remaining: `ada-mcp` itself, and the two-step confirmation flow for anything that moves money.

**4 · Hardening.** Preprod alongside devnet, error taxonomy documented, `address derive/inspect`,
`status`, `manual`, `cache clear`, `localnet reset/snapshot/rollback`, `test`.

**5 · Assets.** Mint under a policy, multi-asset bundles, metadata convention.

**6 · Swap.** The differentiator, with adversarial cases that must each fail safely.

**7 · Publish.** npm as `ada-wallet-cli`, `docs/PUBLISHING.md`, demo.

---

## Standing rules

- **`--json` output is a contract.** Clean stdout, stable error reasons on stderr, deterministic
  ordering. Breaking it is a breaking change even when the human output looks fine.
- **No interactive prompt on any path an agent needs.** Flags instead; `--yes` always bypasses.
- **Secrets never on argv.**
- **Derivation is delegated, never reimplemented** — it is the highest-consequence code in the
  stack and a second implementation can only disagree with the authoritative one.
- **A regression test reproduces the failure** — fails before the fix, passes after. Not a
  happy-path assertion.
- **Compose, don't rewrite.** Before adding chain logic, check whether Yaci DevKit, MeshJS or
  `cardano-address` already does it correctly.
