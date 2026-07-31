# Implementation tracker

**The one place status lives.** Updated in the same session as the work — a tracker that lags is
worse than none, because it gets trusted.

Legend: `[x]` done and exercised against a real chain · `[ ]` not built · `[—]` deliberately not
building it, reason given · `[!]` blocked by something outside this repo.

**Now:** 17 commands · 29 MCP tools · 270 offline tests · stages 1–6 closed · stage 7 spine done
(`inspect`, `address`, `lock`, `unlock`, verified on devnet) · publish held.

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

## 7 — Contracts (Aiken)

Aiken is Cardano's contract language; its compiler emits a CIP-57 `plutus.json` blueprint, which
MeshJS already reads. Nothing here needs a new dependency.

**The verbs are not `mn`'s, deliberately.** On Midnight a contract is a stateful object: deploy
creates it, calling a circuit mutates it, its state is read from it. On Cardano a validator is a pure
predicate over `(datum, redeemer, context)`. It holds nothing. So there is no deploy — a script's
address is derived from its hash and exists the moment it compiles; state lives in datums on UTxOs at
that address, not in the script; and a call is a *spend* of one of those UTxOs. Copying the four
Midnight verbs would name operations this chain does not have.

- [x] **`contract build` / `contract check`** — delegated to `aiken`, losing nothing. It emits a JSON report only to a pipe and diagnostics only to a terminal, so both are taken: the report is captured, and a failure with no report re-runs with our stderr standing in as aiken's stdout — the full diagnostic renders and lands outside the JSON channel. The second run costs 0.16s and only happens when something is already broken. `ADA_AIKEN_BIN` pins a version, since the compiler decides the script hash
- [x] **`contract inspect`** — validators, purposes, datum and redeemer schemas, hash, and any unapplied parameters. The blueprint is to this what `contract-info.json` is to Compact
- [x] **`contract address`** — derived from the blueprint hash, network-discriminated. Cross-checked byte-for-byte against `aiken blueprint address`. Refuses to answer for a validator with unapplied parameters and say which are missing: applying parameters changes the code, so it changes the hash, so it changes the address
- [x] **`contract lock`** — pay to a script address with a datum
- [x] **`contract unlock`** — spend a script UTxO with a redeemer. This is the call
- [x] **`contract utxos`** — what sits at the script address, each with its datum encoding. This is the state, and it is a listing rather than an object because a validator holds nothing
- [ ] **`contract publish`** — a CIP-33 reference script: the only operation that genuinely publishes code once, and the honest reading of "deploy"
- [ ] **`contract simulate`** — execution units without submitting, so a budget failure is found before a fee is paid
- [x] **Inline datums are the default, hash mode supported and proven** — no chain publishes the preimage of a hash-stored datum and the devnet indexer serves no lookup, so `unlock` demands the original up front rather than failing at spend time. Both branches verified on devnet: a `--datum-hash` lock, an unlock refused without `--datum`, and the same unlock succeeding with it
- [x] **Collateral selected explicitly** — a pure-ADA UTxO, at 150% of fee. After any mint a wallet's outputs may all carry assets, and every script transaction then fails for a reason that looks nothing like its cause. The error must say how to make one
- [x] **The script must be double-CBOR-wrapped before hashing** — proven on devnet: the blueprint's `compiledCode` hashes to a *different* address than `aiken blueprint address` reports. `applyParamsToScript` performs the wrapping, which is why the reference example calls it even with an empty parameter list. Omit it and the tool reports a wrong address confidently, and funds sent there are stranded until someone works out why
- [x] **Seed cost models from the chain, on every network** — MeshJS's `fetchCostModels` is a *stub that throws* on both **Yaci and Koios**, so it silently falls back to **mainnet** cost models. Koios is our default for every public network, so this is not a devnet quirk. Both chains serve the real values — Koios at `epoch_params.cost_models`, Yaci at `epochs/latest/parameters` — so we fetch and pass them. This affects fee and budget arithmetic, not only evaluation
- [x] **Evaluate offline as the single path** — Yaci's `utils/txs/evaluate` is implemented but delegates to **Ogmios**, which the native devkit distribution does not install (it ships only in the Docker images), so it answers 500 here. Koios evaluation works, also over Ogmios. Rather than branch on provider capability *or* require developers to run a second daemon, use `OfflineEvaluatorScalus` everywhere: one code path, no round trip, nothing extra to install. Proven on devnet
- [ ] **Ogmios consumed if present, never required** — `ADA_OGMIOS_URL`, or auto-detected on the devkit's own default `localhost:1337`. Same shape as Blockfrost: opt-in through the environment, absence never an error, zero-config path unaffected. We do not install or supervise it — running a second daemon is the devkit's job, as `cardano-node` already is
- [ ] **`--verify-budget`** — when Ogmios or a capable provider is reachable, evaluate the same transaction both ways and report both. Our offline evaluator is an independent reimplementation of the Plutus VM, so a disagreement with the node is exactly the oracle signal this stack was chosen for, and one of the two is wrong
- [ ] **Mempool visibility** — the gap Ogmios would close that offline evaluation cannot: between submit and confirmation we currently cannot distinguish "accepted, waiting for a block" from "silently rejected". Worth having wherever it is reachable
- [ ] **Report both gaps upstream** — `fetchCostModels` is trivially implementable for Koios and Yaci from endpoints already serving the data, which is a well-scoped MeshJS contribution. Yaci's evaluate endpoint failing on well-formed input is a bug report for bloxbean. Neither blocks us; both cost the next person the same day they cost us
- [x] **Execution budget is its own error class** — exceeding the memory or step limit is neither insufficient funds nor an invalid transaction, and it is the failure a contract author hits most
- [ ] **Oversized script names the remedy** — inlining a large validator breaches the transaction size limit, which is exactly what reference scripts exist to solve
- [x] **Plutus version read from the blueprint**, never assumed
- [ ] **Datums and redeemers validated against the declared schema** — CIP-57 gives every argument a `dataType`, so a malformed value is rejected before a transaction is built, naming the expected shape. `mn` has to guess at this boundary; we do not
- [x] **Blueprint discovery tolerates real layouts** — `plutus.json` sits at the project root only *by convention*, and `mn` carries a list of candidate directories precisely because projects that differ silently miss the scan. Plus `--module` and `--validator`, the axis `aiken` itself uses
- [ ] **Reference inputs, validity intervals, required signers** — reading a UTxO without spending it, deadline bounds, and signature checks. All present in MeshJS, and a validator surface without them cannot express the common patterns
- [x] **Money paths inherit the existing rules** — `lock` and `unlock` are dry-run by default, `--yes` to submit, and both are gated behind the two-step MCP confirmation with the wallet named in the consent text
- [x] **Feasibility proven on devnet** — ahead of any command being written, both reference contracts were driven end to end: hello-world locked 5 ADA under an inline datum and unlocked it with the `"Hello, World!"` redeemer; the one-shot policy minted an NFT, burned it, and then **refused a second mint** because its seed UTxO was spent. That last one is the model working as designed, confirmed rather than assumed
- [ ] **Verified live through our own commands** — the same two cycles driven by `ada contract`, on devnet and then preprod
- [ ] **Cross-checked against `cardano-cli`** — `aiken blueprint convert --to cardano-cli` emits the envelope it consumes, giving a second independent opinion on a script
- [—] **Withdrawal and certificate validators** — the blueprint's `withdraw` and `publish` purposes. MeshJS supports both; out of scope for v1, recorded so the absence is a decision

- [ ] **`contract mint`** — Plutus minting policies, decided rather than left open. `asset mint` stays the native-script path. The flag surfaces barely overlap — three shared against seven disjoint — and a command whose valid combinations form two non-overlapping sets is two commands wearing one name, which over MCP becomes a union schema an agent will call wrongly. The seam already exists downstream: `balance`, `asset send` and `swap` operate on `policyId + assetName` regardless of how a token was minted. How a token comes into existence is a policy question; what happens to it afterwards is an asset question

## 8 — Publish — held

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
- [ ] **`dev`** — *decline reversed by the Aiken spike.* Declined when nothing here compiled; Aiken has `.ak` sources and a real build step, so a watch-compile loop finally has something to watch. `mn`'s version also provisions funded dev wallets and binds a keypress to deploy — every part of that has a counterpart once stage 7 lands
- [—] **`test`** — `mn test` is *end-to-end dApp* testing: suite discovery, prep steps, browser mode, assertions, teardown. `aiken check` runs a validator's own unit and property tests. Delegating to Aiken in stage 7 covers the second and none of the first, which stays out of scope
- [—] **`dust register` / `dust status`** — Midnight pays fees in a separate token that must be registered for and monitored. Cardano pays in ADA from the same UTxOs, so the category disappears. Worth stating so the absence reads as one fewer problem, not one fewer feature

**Already covered under another name**, listed because a name-by-name comparison otherwise reports
them missing:

- [x] **`generate`** — deprecated upstream in favour of `wallet generate`, which is what we built
- [x] **`inspect-cost`** — split in two here: `params` carries the standing limits, including the execution-unit budget and its prices, and `contract simulate` will report what one transaction actually spends against them
- [!] **`genesis-address`** — this is `localnet addresses`, blocked above for the same reason: the devkit prints its pre-funded addresses to a log and exposes them nowhere machine-readable

## Standing rules

- [x] **`--json` is a contract** — clean stdout, stable `code` on failures, deterministic ordering. Breaking it is a breaking change even when the human output looks fine
- [x] **No interactive prompt on any path an agent needs** — flags instead; `--yes` always bypasses
- [x] **Secrets never on argv** — command lines land in shell history and process listings
- [x] **Derivation is delegated, never reimplemented**
- [x] **A regression test reproduces the failure** — fails before the fix, passes after; not a happy-path assertion
- [x] **Compose, don't rewrite** — before adding chain logic, check whether Yaci DevKit, MeshJS or `cardano-address` already does it
