# Implementation tracker

**The one place status lives.** Updated in the same session as the work — a tracker that lags is
worse than none, because it gets trusted.

Legend: `[x]` done and exercised against a real chain · `[ ]` not built · `[—]` deliberately not
building it, reason given · `[!]` blocked by something outside this repo.

**Now:** 16 commands · 25 MCP tools · 187 offline tests · stages 1–6 closed · publish held.

---

## 1 — Walking skeleton

- [x] **Scaffold** — TypeScript, `ada` binary, typecheck, vitest, bundle
- [x] **Config store** — active-wallet concept, atomic writes, flag overrides, corrupt file preserved rather than clobbered
- [x] **Error taxonomy** — a stable `code` per failure, exit codes separating user error from tool failure from chain rejection
- [x] **`localnet up/down/status/logs/bootstrap/reset`** — wraps Yaci DevKit; ready in ~9s after a one-time 1.4 GB download
- [x] **`tip`, `info`, `help`** — proves config, endpoint resolution and the chain connection all agree

## 2 — Wallets and money

- [x] **`wallet generate/list/use/info/remove`** — named wallets, one active; keys at 0600 in a 0700 directory
- [x] **Unencrypted keys, mainnet refused** — encryption needs a passphrase, a passphrase needs a prompt, and no path an agent needs may block on one. Refusing mainnet is the honest consequence rather than a warning
- [x] **`balance`** — ADA *and* every native asset, for a wallet or a raw address
- [x] **`utxos`** — first-class, because a balance is a sum over a set and "which outputs produced it" is always the next question
- [x] **`airdrop`** — devkit faucet; refuses on any network that has none
- [x] **`transfer`** — dry run by default, `--yes` submits. One code path, so the fee shown is the fee charged
- [x] **Exact amounts** — bigint lovelace end to end; no floating point touches money
- [x] **Verified live** — funded 1000 ADA, sent 25, fee 0.169813, both balances reconciled to the lovelace

## 3 — Agent surface

- [x] **One JSON document on stdout** — success *and* failure, so `--json | jq` works either way
- [x] **Envelope applied centrally** — no command can forget or misspell it, and one reporting failure through the success path cannot emit a labelled lie
- [x] **`ada-mcp`** — 25 tools over stdio; commands run in-process so nothing writes to the transport the client is reading
- [x] **Two-step confirmation, enforced** — money-moving tools return a single-use five-minute token. A `--yes` flag protects a human because a human types it deliberately; an agent would simply pass it
- [x] **Consent text names the wallet** — an agent may have switched the active wallet earlier in the session, and consent against a vague description is not consent for the account it turns out to mean
- [x] **Honest annotations** — `readOnlyHint` only where there is genuinely no state change; tests assert no consent tool is ever marked read-only
- [x] **`docs/SKILL.md`** — ships with the package; intent routing, error recovery keyed on `code`, safety rules

## 4 — Hardening

- [x] **`params`** — fee coefficients and the per-byte cost that sets an output minimum
- [x] **`address inspect`** — base, enterprise or stake, and its credentials
- [x] **`status`** — chain, devnet and wallet in one call; detects a chain that answers while producing no blocks
- [x] **`localnet reset`** — one control-API call; keys survive, balances do not
- [x] **`manual`** — full reference, sharing its data with `help` so the two cannot drift
- [x] **Preprod verified** — reads work with no account and no API key, via a free community API
- [—] **`cache clear`** — nothing is cached. `~/.ada` holds config, keys, logs and a pid file
- [!] **`localnet snapshot/rollback`** — fork and snapshot exist only in the devkit's interactive shell, and invoking it again kills the running devnet
- [!] **`localnet addresses`** — the devkit prints its twenty pre-funded addresses to a log; `cluster-info.json` carries ports but not addresses. Log-scraping was rejected as too fragile
- [!] **`address derive`** — delegated to the official `cardano-address` binary, which is not installed. Derivation is the highest-consequence step in the stack and a second implementation could only disagree with the authoritative one

## 5 — Native assets

- [x] **`asset policy`** — deterministic from the wallet, so mints are repeatable
- [x] **`asset mint`** — native-script policy, one key, no Plutus; CIP-25 metadata so the asset displays in wallets and explorers
- [x] **`asset send`** — a *bundle*: several distinct assets in one transaction, which is what the ledger natively does
- [x] **Attached ADA surfaced** — every output must carry some, and unexplained it looks like ADA going missing
- [x] **Verified live** — minted 100 Silk and 40 Jade, sent 25 Silk + 10 Jade in one transaction

## 6 — Atomic swap

- [x] **`swap build`** — one transaction from both parties' inputs; partially signs, so it commits the maker and needs `--yes`
- [x] **`swap inspect`** — separate from `sign` on purpose: a received offer is untrusted input, and understanding one must be possible repeatedly with no signature anywhere near it
- [x] **Claims verified against the transaction** — a real vulnerability, found by testing. The first version signed against the offer's *description*, so editing one JSON field produced an offer reading "you give 0.000001 ADA" while the transaction took 50
- [x] **`swap sign` / `swap submit`** — refuses expired, wrong-network, maker-unsigned, wrong-taker and misrepresented offers
- [x] **Verified live** — 20 Silk for 50 ADA, both balances reconciled to the lovelace
- [x] **Adversarial cases each failing safely** — replay, maker-signs-as-taker, wrong network, expired, unsigned, garbage, unknown version, misrepresented

## 7 — Publish — held

- [ ] **npm, `docs/PUBLISHING.md`, demo, Builder Tools submission**

**Why held.** Feature-complete is not battle-tested, and this codebase makes the case unusually
clearly: every defect that mattered was found by *driving* the tool, not by running its tests —
seven MCP tools routing to commands that could not be loaded, a `--wallet` flag returning the wrong
account, a dry run approving a transaction the chain refused, an offer format that let a sender lie
about the deal, and a `status` command calling a chain healthy through nine hours of producing
nothing. The suite was green throughout all of it.

**The bar:** publish once it has carried a real money path end to end **for something other than
itself**, cross-checked against an independent implementation.

## Declined — decided, so they stop reappearing as gaps

- [—] **`serve`** — Cardano's dApp-connector convention is a browser-wallet standard; a CLI competing with it helps nobody
- [—] **`dev`** — no compile step in the default path, so there is nothing to watch
- [—] **`contract`** — no deploy step exists; a script travels with the transaction that uses it, or sits as a reference output
- [—] **`test`** — `mn` generates suites for Compact dApps; there is no equivalent artefact here to generate tests *for*
- [—] **`dust register` / `dust status`** — Midnight pays fees in a separate token that must be registered for and monitored. Cardano pays in ADA from the same UTxOs, so the category disappears. Worth stating so the absence reads as one fewer problem, not one fewer feature

## Standing rules

- [x] **`--json` is a contract** — clean stdout, stable `code` on failures, deterministic ordering. Breaking it is a breaking change even when the human output looks fine
- [x] **No interactive prompt on any path an agent needs** — flags instead; `--yes` always bypasses
- [x] **Secrets never on argv** — command lines land in shell history and process listings
- [x] **Derivation is delegated, never reimplemented**
- [x] **A regression test reproduces the failure** — fails before the fix, passes after; not a happy-path assertion
- [x] **Compose, don't rewrite** — before adding chain logic, check whether Yaci DevKit, MeshJS or `cardano-address` already does it
