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
- [x] Offline tests (22) including a fails-before/passes-after readiness regression

**Done:** devnet starts in ~9s and reports an advancing tip. See `docs/DEVNET.md` for the
devkit behaviour this uncovered — two distinct APIs, and an indexer that ships separately and
is disabled by default.

`ada-mcp` moved to stage 3, where it is written against the real command surface rather than
ahead of it.

## 2 · Wallets and money

- [ ] `wallet generate/list/use/info/remove`, encrypted key storage, passphrase never on argv
- [ ] `balance` — ADA **and** native assets
- [ ] `utxos`
- [ ] `airdrop` via the devnet faucet
- [ ] `transfer`, surfacing fee, change, and the minimum-value check before submitting
- [ ] `fee estimate`

**Done when:** fund an address, read its balance, send a transfer, all on the local devnet. This is
the exit bar that unblocks the SDK work.

## 3 · Agent surface

- [ ] `--json` on every command, stdout clean, stderr for stable error reasons
- [ ] `ada-mcp` exposing the wallet operations
- [ ] `docs/SKILL.md` — ships with the tool so any agent picks up the command surface. Written
      against the real binary, not ahead of it
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
