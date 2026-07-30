# Implementation tracker

**This is the single tracker for this tool.** Every work session updates it, in the same session as
the work — a tracker that lags is worse than none, because it gets trusted. A row moves to done when
its tests pass and it has been exercised against a real chain.

**Nothing else tracks status.** Strategy and reasoning that should not be public live in the private
planning repo, and deliberately carry no status of their own.

The reference point is `midnight-wallet-cli` (`mn`), which covers the same job on Midnight. Parity
with it is the bar for "this tool is as useful as the one that already works" — with the
differences called out rather than smoothed over, because some Midnight concepts have no Cardano
counterpart and some Cardano capabilities have no Midnight one.

Legend: **done** · **next** (current stage) · **planned** (stage noted) · **none** (no
counterpart, reason given) · **open** (needs a decision)

---

## Where this stands

| | State |
|---|---|
| Shipped | 14 commands · 18 MCP tools · 140 offline tests |
| Verified live | devnet end to end; **preprod reads with no API key and no setup** |
| Building now | **swap** — the differentiator |
| Left after that | `manual`, `cache clear`, `localnet snapshot/rollback`, `test`, publish |
| Blocked, not deferred | `localnet addresses` (no machine-readable source) · `address derive` (needs the `cardano-address` binary) |
| No counterpart in `mn` | `dust register`, `dust status` — Cardano pays fees in ADA, so the category does not exist |
| Needs a decision | `serve`, `dev`, `contract` |

---

## Command parity with `mn`

| `mn` command | `ada` counterpart | Status |
|---|---|---|
| `wallet generate` | `wallet generate` | **done** |
| `wallet list` | `wallet list` | **done** |
| `wallet use` | `wallet use` | **done** |
| `wallet info` | `wallet info` — payment **and** stake address, derivation path | **done** |
| `wallet remove` | `wallet remove` — requires `--yes` | **done** |
| `info` | `info` | **done** |
| `balance` | `balance` — ADA **and** every native asset held | **done** |
| `transfer` | `transfer` — dry run by default; `--yes` submits | **done** |
| `airdrop` | `airdrop` — devkit faucet; devnet only | **done** |
| `address --seed` | `address derive` — **blocked**: delegates to the `cardano-address` binary, which is not installed |
| `genesis-address` | `localnet addresses` — **blocked**: the devkit exposes the 20 addresses only through its interactive shell, and `cluster-info.json` does not carry them |
| `inspect-cost` | `params` — fee coefficients, min-UTxO, limits | **done** |
| `config get/set/unset` | `config get/set/unset/list` | **done** |
| `cache clear` | `cache clear` | planned · stage 4 |
| `localnet up` | `localnet up` | **done** |
| `localnet stop` | `localnet stop` | **done** |
| `localnet down` | `localnet down` | **done** |
| `localnet status` | `localnet status` — process and API reported separately | **done** |
| `localnet logs` | `localnet logs` | **done** |
| `localnet clean` | `localnet reset` — one control-API call, `--yes` required | **done** |
| `status` | `status` — chain, devnet and wallet in one call | **done** |
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
and of any Midnight client's error handling — exists to manage it. Cardano pays fees in ADA out of the
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
| `utxos` | Balance is a sum over a UTxO set. When a number looks wrong, the next question is always which outputs produced it | **done** |
| `fee estimate` | Fees are knowable before submitting — a dry run is possible here and is not on Midnight | **done** — it is `transfer` without `--yes`, so it cannot disagree with the real path |
| `asset policy` | The minting policy is deterministic from the wallet, so it is worth knowing without minting | **done** |
| `asset mint` | Native assets are ledger-level; no contract is needed to create a token | **done** |
| `asset send` | Many distinct assets move in one output as a bundle | **done** |
| `swap build` | Two-party atomic swap needs no smart contract — a ledger primitive | planned · stage 6 |
| `swap inspect` | A received offer is untrusted input; understanding it must be separable from signing it | planned · stage 6 |
| `swap sign` / `swap submit` | Co-signing one transaction built from both parties' inputs | planned · stage 6 |
| `address inspect` | Addresses carry a payment credential and a stake credential worth decoding | **done** |
| `localnet snapshot` / `rollback` | The devkit can fork the chain, so rollback behaviour is testable | planned · stage 4 |

---

## MCP tool parity

`mn` exposes 23 tools. Its CLI-only commands (`contract`, `dev`, `test`, `serve`) are deliberately
**not** exposed — the MCP surface is the wallet and chain primitives. Same principle here.

| `mn` tool | `ada` tool | Status |
|---|---|---|
| `midnight_wallet_generate` | `ada_wallet_generate` | **done** |
| `midnight_wallet_list` | `ada_wallet_list` | **done** |
| `midnight_wallet_use` | `ada_wallet_use` | **done** |
| `midnight_wallet_info` | `ada_wallet_info` | **done** |
| `midnight_wallet_remove` | `ada_wallet_remove` | planned · stage 3 |
| `midnight_info` | `ada_info` | **done** |
| `midnight_balance` | `ada_balance` | **done** |
| `midnight_address` | `ada_address_derive` | planned · stage 3 |
| `midnight_genesis_address` | `ada_localnet_addresses` | planned · stage 3 |
| `midnight_inspect_cost` | `ada_params` | planned · stage 3 |
| `midnight_airdrop` | `ada_airdrop` | **done** |
| `midnight_transfer` | `ada_transfer` | **done** |
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

Ordered so each produces something usable rather than a layer waiting on the next. The first three
are the loop everything else is debugged inside.

**1 · Walking skeleton — done.** Scaffold, config, error taxonomy, devnet lifecycle, `tip`,
`info`, `help`. Devnet starts in ~9s with an advancing tip; 41 offline tests including
fails-before/passes-after regressions for the readiness wait, the process-group stop and the flag
parser.

**2 · Wallets and money — done.** Wallets, `balance`, `utxos`, `airdrop`, `transfer` with a
dry-run-by-default shape that makes `fee estimate` the same code path. Verified on a live devnet:
funded 1000 ADA, sent 25, fee 0.169813, both balances reconciled to the lovelace. **This is the
loop the SDK work gets debugged inside.**

Still open in this area: `params` and `localnet addresses`, neither of which blocks anything.

**3 · Agent surface — done.** The `--json` envelope, the stable `code` taxonomy, `docs/SKILL.md`,
`ada-mcp` with 18 annotated tools, and enforced two-step confirmation for anything that moves money
or deletes a key. Driven end to end with a real MCP client.

**4 · Hardening — mostly taken early.** `params`, `address inspect`, `status` and `localnet reset`
landed as soon as the plumbing made them single calls. **Preprod is verified**: reads work with no
account and no API key via a free community API, so nothing needs configuring before first use.

Left here: `manual`, `cache clear`, `localnet snapshot/rollback`, `test`.

Two items are **blocked rather than deferred**, and the reason is worth keeping so neither is picked
up as easy work: `address derive` needs the `cardano-address` binary installed, and
`localnet addresses` has no machine-readable source — the devkit prints its twenty addresses to a log
and its `cluster-info.json` carries ports and chain parameters but not addresses. Log-scraping was
rejected as too fragile for something a user would rely on.

**5 · Assets — done.** `asset policy`, `asset mint`, `asset send`. Minting uses a native-script
policy controlled by one key — no Plutus, no redeemers, and the policy is deterministic from the
wallet, so mints are repeatable. Metadata follows CIP-25 so a minted asset displays in wallets and
explorers rather than being invisible to them.

`asset send` moves a **bundle** — several distinct assets in one transaction — because that is what
the ledger natively does. Verified live: minted 100 Silk and 40 Jade, sent 25 Silk + 10 Jade to
another wallet in a single transaction, and an over-send is refused naming the asset and the amount
held.

It also surfaces the ADA that must travel with a token output, which otherwise looks like ADA
going missing.

**6 · Swap.** The differentiator, and the reason this tool is worth building rather than assembling
by hand each time. A two-party atomic swap needs no smart contract on Cardano — one transaction from
both parties' inputs, both signatures, so either both sides move or nothing does.

`swap inspect` is the safety-critical piece and stays separate from `swap sign`: a received offer is
untrusted input, and understanding one must be possible repeatedly, from a script, with no signature
anywhere near it. Every adversarial case must fail safely — partial signature, replay, expiry,
mutation after signing, and a counterparty walking away.

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
