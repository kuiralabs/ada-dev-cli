# Build order

Near-term sequencing and the reasoning for it. **The authoritative feature checklist —
including parity with `midnight-wallet-cli` — is `tasks/IMPLEMENTATION.md`.** This file says
what order to build in; that one says what exists, what is missing, and what has no counterpart.

Ordered so each step produces something usable rather than a layer waiting on the next one. The
first three stages are the loop everything else gets debugged inside.

## 1 · Walking skeleton — DONE

- [x] Scaffold: TypeScript, `ada` binary, Apache-2.0, typecheck + vitest + bundle
- [x] Config store with an active-wallet concept, atomic writes, flag overrides
- [x] Error taxonomy with stable reasons and exit codes
- [x] `localnet up/down/status/logs/bootstrap` wrapping Yaci DevKit
- [x] `tip`, `info`, `config`, `help`
- [x] Offline tests (41) including fails-before/passes-after regressions for the readiness
      wait, the process-group stop, and the flag parser

**Done:** devnet starts in ~9s and reports an advancing tip. See `docs/DEVNET.md` for the
devkit behaviour this uncovered — two distinct APIs, and an indexer that ships separately and
is disabled by default.

`ada-mcp` moved to stage 3, where it is written against the real command surface rather than
ahead of it.

## 2 · Wallets and money — DONE

- [x] `wallet generate/list/use/info/remove` with a named-wallet model and one active wallet
- [x] Key storage at 0600 in a 0700 directory, **unencrypted**, and **mainnet refused outright** as
      the honest consequence. Encryption would need a passphrase, a passphrase needs a prompt, and no
      path an agent needs may block on a prompt
- [x] `balance` — ADA and every native asset, for a wallet or a raw address
- [x] `utxos` — first-class, because balance is a sum over a set
- [x] `airdrop` via the devkit faucet, refusing on any network that has none
- [x] `transfer` — **dry run by default, `--yes` submits.** One code path, so the fee shown is the
      fee charged and `fee estimate` cannot disagree with the real thing
- [x] Exact integer amounts throughout: no floating point touches money

**Done:** verified on a live devnet — 1000 ADA funded, 25 sent, fee 0.169813, alice 974.830187 and
bob 25, reconciling to the lovelace.

Also landed, because each was a single call once the plumbing existed: `params` (fee
coefficients and min-UTxO), `address inspect`, `status` (one-shot health), and `localnet reset` via
the devkit's control API — verified to wipe the chain to genesis while leaving wallet keys intact.

**Blocked, not deferred:** `localnet addresses` has no machine-readable source (the devkit prints
its twenty addresses to a log; `cluster-info.json` has ports but not addresses), and
`address derive` needs the `cardano-address` binary installed.

## 3 · Agent surface — contract landed, server pending

- [x] One JSON document on **stdout** for success and failure alike, envelope applied centrally so
      no command can forget it. Failures on stdout so `--json | jq` works either way
- [x] Stable `code` taxonomy; `message` explicitly prose. Exit codes documented
- [x] `docs/SKILL.md`, shipped in the package `files` — intent routing, error-recovery table keyed
      on `code`, safety rules, platform limits
- [x] Capability discovery: `ada help --json` reports `implemented` per command
- [x] Capture-target hook in the output layer, so the MCP server can collect output without
      writing to stdout and corrupting its own transport
- [x] `ada-mcp` — 18 tools over stdio, commands run in-process through the capture hook so nothing
      writes to the transport the client is reading. The skill is offered as a readable resource
- [x] Two-step confirmation, **enforced rather than advised**: `ada_transfer`,
      `ada_wallet_remove` and `ada_localnet_reset` return a single-use token that expires in five
      minutes. A `--yes` flag would not work here — an agent would just pass it — but a token it
      cannot mint forces the conversation
- [x] Honest annotations: `readOnlyHint` only where there is genuinely no state change, and tests
      assert no consent tool is ever marked read-only
- [x] Verified over the wire with a real MCP client: airdrop, preview, pending token, wrong token
      rejected, confirm, replay rejected, balances reconciled to the lovelace
- [ ] Verify no path an agent needs can block on a prompt

**Done when:** a debugging loop runs as a conversation, with no commands copied by hand.

## 4 · Hardening the basics

- [ ] Preprod alongside the devnet, selectable by config or flag
- [ ] Stable error taxonomy, documented
- [ ] Tests that reproduce failures rather than asserting the happy path
- [ ] `help` and `manual`

## 5 · Assets

- [ ] `asset mint` under a policy
- [ ] `asset send` — multi-asset bundles in one transaction
- [ ] Metadata following ecosystem convention

## 6 · Swap

- [ ] `swap build`
- [ ] `swap inspect` — the safety-critical one; a received offer is untrusted input
- [ ] `swap sign`, `swap submit`
- [ ] Adversarial cases, each failing safely: partial signature, replay, expiry, mutation after
      signing, counterparty vanishing

## 7 · Publish

- [ ] `docs/PUBLISHING.md`
- [ ] npm release as `ada-wallet-cli`
- [ ] Demo recording

## Deferred, deliberately

- Script/Plutus interaction — nothing on the roadmap needs it yet
- Staking and delegation
- A dApp connector server — the ecosystem already has an established convention that browser
  wallets implement; unclear this tool should compete with it
