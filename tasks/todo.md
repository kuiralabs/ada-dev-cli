# Build order

Ordered so each step produces something usable rather than a layer waiting on the next one. The
first four steps are the loop everything else gets debugged inside.

## 1 · Walking skeleton

- [ ] Scaffold: TypeScript, npm workspaces, `ada` + `ada-mcp` binaries, Apache-2.0
- [ ] Config store with an active-wallet concept
- [ ] `localnet up/down/status` wrapping Yaci DevKit
- [ ] `tip` and `info` — proves the chain connection end to end

**Done when:** a local chain starts and reports its tip.

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
