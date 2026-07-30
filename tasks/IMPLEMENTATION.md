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
| Shipped | 16 commands · 25 MCP tools · 187 offline tests |
| Verified live | devnet end to end; **preprod reads with no API key and no setup** |
| Building now | nothing — **every stage except publish is closed** |
| Left | **publish only** — deliberately held until the tool has been used in anger |
| Not applicable | `cache clear` — there is no cache to clear |
| Blocked by the devkit | `localnet snapshot/rollback` — interactive-shell only |
| Declined | `serve`, `dev`, `contract`, `test` — reasoning below |
| Blocked, not deferred | `localnet addresses` (no machine-readable source) · `address derive` (needs the `cardano-address` binary) |
| No counterpart in `mn` | `dust register`, `dust status` — Cardano pays fees in ADA, so the category does not exist |

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
| `cache clear` | — | **none** (nothing is cached) |
| `localnet up` | `localnet up` | **done** |
| `localnet stop` | `localnet stop` | **done** |
| `localnet down` | `localnet down` | **done** |
| `localnet status` | `localnet status` — process and API reported separately | **done** |
| `localnet logs` | `localnet logs` | **done** |
| `localnet clean` | `localnet reset` — one control-API call, `--yes` required | **done** |
| `status` | `status` — chain, devnet and wallet in one call | **done** |
| `help` | `help` — marks which commands are implemented | **done** |
| `manual` | `manual` — shares its data with `help` | **done** |
| `dust register` | — | **none** |
| `dust status` | — | **none** |
| `serve` (dApp connector) | — | **declined** |
| `dev` (contract watch loop) | — | **declined** |
| `contract inspect/deploy/call/state` | — | **declined** |
| `test create/run/list/results` | — | **declined** |

### Why two have no counterpart

**`dust register` and `dust status` do not exist on Cardano.** Midnight uses a separate token to
pay fees, which has to be registered for and monitored, and a large share of `mn`'s complexity —
and of any Midnight client's error handling — exists to manage it. Cardano pays fees in ADA out of the
same UTxOs being spent. The whole category disappears.

Worth stating explicitly rather than leaving as a gap: someone comparing the two tools will
notice the missing commands and should know it is an absence of a problem, not an absence of a
feature.

### The four declined, and why

Decided rather than left open, so they stop reappearing as gaps.

**`serve` — no.** `mn` serves a dApp-connector WebSocket. Cardano's equivalent convention is
implemented by browser wallets and is well established; a CLI competing with it would be a second
implementation of someone else's standard for no one's benefit.

**`dev` — no.** `mn`'s watch loop recompiles a contract on save. Cardano has no compile step in the
default path, so there is nothing to watch. Revisit only if script authoring enters scope.

**`contract` — no.** Cardano has no deploy step: a script travels with the transaction that uses it,
or is stored as a reference output. `deploy` has nothing to map onto. Nothing on the roadmap needs
scripts, and native assets and atomic swaps both work without them.

**`test` — no.** `mn` generates E2E suites for Compact dApps. There is no equivalent artefact here to
generate tests *for*, and a generator with no target is a feature looking for a use.

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
| `localnet snapshot` / `rollback` | The devkit can fork the chain, but only from its interactive shell | **blocked** |

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

**4 · Hardening — done.** `params`, `address inspect`, `status` and `localnet reset`
landed as soon as the plumbing made them single calls. **Preprod is verified**: reads work with no
account and no API key via a free community API, so nothing needs configuring before first use.

`manual` completes it, reading the same reference data `help` does so the two cannot drift.

The rest of what was listed here turned out not to be work, and each disposition is recorded so it
is not picked up again as an easy win:

**`cache clear` — not applicable.** `mn` has it because the Midnight SDK caches wallet state. This
tool caches nothing: `~/.ada` holds config, wallet keys, logs and a pid file. Inventing a command
that clears nothing would be worse than its absence.

**`localnet snapshot` / `rollback` — blocked by the devkit.** Fork and snapshot exist only in its
interactive shell; the control API has no endpoints for them, and invoking the shell again kills the
running devnet. Confirmed against its OpenAPI document, not assumed.

**`address derive` — blocked on a tool.** Delegated to the official `cardano-address` binary rather
than reimplemented, and that binary is not installed. The delegation is deliberate: derivation is the
highest-consequence step in the stack and a second implementation could only disagree with the
authoritative one.

**`localnet addresses` — blocked, no source.** The devkit prints its twenty pre-funded addresses to a
log; `cluster-info.json` carries ports and chain parameters but not addresses. Log-scraping was
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

**6 · Swap — done.** `swap build`, `inspect`, `sign`, `submit`. Verified live: alice gave 20 Silk
for 50 ADA from bob, both balances reconciling to the lovelace.

`swap inspect` is the safety-critical piece and stays separate from `swap sign`, because a received
offer is untrusted input and understanding one must be possible repeatedly, from a script, with no
signature anywhere near it.

**A real vulnerability was found here by testing and is now closed.** An offer carries a transaction
*and* a description of it. The first implementation displayed and signed against the description, so
editing one JSON field produced an offer reading "you give 0.000001 ADA" while the transaction took
50. Everything shown or checked is now derived from the transaction itself, with the description
treated as an unverified claim — mismatches are reported as `offer_misrepresented` and refused.

Adversarial cases, each verified to fail safely: replay of a spent swap, the maker signing as taker,
wrong network, expired offer, unsigned by the maker, garbage input, unknown version, and a
misrepresented description.

**7 · Publish — held until the tool has been used in anger.**

Feature-complete is not the same as battle-tested, and this codebase makes the case unusually
clearly. Every defect that mattered was found by *driving* the tool, not by running its tests:
seven MCP tools routing to commands that could not be loaded, a `--wallet` flag that silently
returned the wrong account, a dry run that approved a transaction the chain refused, an offer format
that let a sender lie about the deal, and a `status` command that called a chain healthy while it
had produced no blocks for nine hours. The suite was green throughout all of it.

The remedy is the job the tool was built for. It exists to make another implementation debuggable —
so publishing waits until it has actually done that, at which point the next tier of defects will
have surfaced the same way this one did.

**A defensible bar:** publish once it has carried a real money path end to end for something other
than itself. Reading a balance exercises very little; building, signing and submitting a transaction
while comparing against an independent implementation exercises nearly everything.

npm as `ada-wallet-cli`, `docs/PUBLISHING.md`, a demo, and a Builder Tools submission to the Cardano
developer portal all follow that, not the other way round.

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
