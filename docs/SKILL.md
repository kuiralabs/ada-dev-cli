# ada-wallet-cli — Agent Skill

You have access to the `ada` CLI for Cardano. This document teaches you how to drive it. Read it
once at the start of a session; use it as reference throughout.

**Scope note:** wallets, balances, funding and ADA transfers work. Native assets and atomic swaps
are designed but not built. **Never invent a command.** Ask the tool what it has:

```
ada help --json
```

Every entry carries `implemented: true|false`. Trust that over this document if they ever disagree.

---

## The output contract

**Always pass `--json`.** Then every invocation returns exactly one JSON document on **stdout**, on
success and on failure alike. `ada tip --json | jq` works either way.

Success:
```json
{ "ok": true, "command": "tip", "height": 158, "slot": 758, "epoch": 1, "hash": "..." }
```

Failure:
```json
{ "ok": false, "error": true, "command": "tip",
  "code": "devnet_not_running",
  "message": "cannot reach the devnet at http://localhost:8080/api/v1/blocks/latest",
  "hint": "start it with: ada localnet up" }
```

Rules that will not change:

- **Branch on `ok`.** `error: true` is also present on failures if you prefer that shape.
- **`code` is the contract.** Branch on it. **`message` is prose and may be reworded** — never
  pattern-match it.
- **`hint`, when present, is the suggested next action.** It is usually exactly what to do.
- **`command` echoes what you asked for**, so a result can be correlated.
- **Stderr carries progress and chrome only.** Ignore it unless diagnosing.
- **Exit codes**: `0` ok · `2` bad arguments · `3` config · `4` devnet not running · `5` network ·
  `6` chain rejected · `7` a required tool is missing · `70` internal.

Never pass a boolean flag a value. `--json` and `--help` take none; `ada localnet --json status` and
`ada localnet status --json` are equivalent.

## Concepts to get right

- **Cardano has no balance field.** A balance is a sum over a set of unspent outputs (UTxOs). When a
  number looks wrong, the question is *which outputs produced it* — not "is the balance stale".
- **Fees are predictable**, a linear function of transaction size, and knowable *before* submitting.
  There is no gas auction and no estimation guesswork.
- **An output can be rejected for being too small.** There is a minimum value per output. A sensible
  transaction can fail because a change output fell under the floor.
- **There is no proving step.** Unlike Midnight, transactions build in milliseconds. If something is
  slow it is the network or the block time, never the client.
- **One wallet, two addresses.** A payment address and a stake address, from the same account on
  different roles. They are not interchangeable.
- **Networks**: `devnet` is the local chain and the default — one block per second, funded test
  addresses, disposable. `preprod` and `preview` are public testnets and need an endpoint configured
  first. `mainnet` is real money.

## Intent routing

| User says | Run |
|---|---|
| "start a local chain" / "start the devnet" | `ada localnet up --json` |
| "stop the devnet" | `ada localnet down --json` |
| "is the devnet running?" | `ada localnet status --json` |
| "where are the devnet logs?" | `ada localnet logs --json` |
| "download the devnet components" | `ada localnet bootstrap --json` |
| "what block are we on?" / "is the chain producing?" | `ada tip --json` |
| "what network am I on?" / "is it reachable?" | `ada info --json` |
| "switch to preprod" | `ada config set network preprod --json` |
| "show my settings" | `ada config list --json` |
| "what can this tool do?" | `ada help --json` |
| "create a wallet called alice" | `ada wallet generate alice --json` |
| "list wallets" | `ada wallet list --json` |
| "switch to bob" | `ada wallet use bob --json` |
| "what's my address?" | `ada wallet info --json` |
| "delete wallet alice" | `ada wallet remove alice --yes --json` — ask consent first |
| "what's my balance?" | `ada balance --json` |
| "balance of addr_test1..." | `ada balance addr_test1... --json` |
| "show my UTxOs" / "why is my balance that?" | `ada utxos --json` |
| "fund my wallet" (devnet only) | `ada airdrop 1000 --json` |
| "what would it cost to send 10 ADA?" | `ada transfer <addr> 10 --json` — **no `--yes`, so nothing is sent** |
| "send 10 ADA to X" | dry run first, show the fee, get consent, then add `--yes` |

Anything about native assets or swaps: **not built yet.** Say so plainly rather than improvising.

## Sending ADA — the two-step flow

`ada transfer` **does not send anything without `--yes`.** Use that.

1. Run `ada transfer <address> <ada> --json`. The transaction is fully built against live
   protocol parameters and you get back `submitted: false` plus the real `feeAda`, `changeAda`,
   `totalLovelace` and every output.
2. Show the user the amount, the recipient and the fee **verbatim**. Do not paraphrase or round them.
3. Wait for explicit consent.
4. If yes, run the same command with `--yes`. You get `submitted: true` and a `txHash`.
5. A transfer needs one block to confirm before it shows in a balance. Wait a few seconds, then
   `ada balance --json`.

Never pass `--yes` on the first call. The dry run costs nothing and it is the only chance to see the
fee before it is paid.

## Canonical flow — first session

1. `ada localnet up --json` — starts the chain. **First run downloads about 1.4 GB** and can take
   several minutes; after that it is about nine seconds. Warn the user before the first run.
2. `ada tip --json` — confirm blocks are being produced. Run it twice a few seconds apart; `height`
   should increase.
3. `ada wallet generate alice --json` — creates a wallet and makes it active.
4. `ada airdrop 1000 --json` — fund it from the faucet. Devnet only.
5. Wait a few seconds for a block, then `ada balance --json` — confirm the funds arrived.

At step 5 the user can transact.

## Error recovery

Match on `code`, and prefer `hint` when it is present.

| `code` | What happened | Do this |
|---|---|---|
| `devnet_not_running` | Nothing is serving the local chain | `ada localnet up --json` |
| `devnet_exited` | The devkit started and died before serving | Read `logTail` in the response — it names the cause. Check `diagnosis` too |
| `devnet_not_ready` | Started but no API yet | Usually still starting. Wait and retry `ada localnet status --json` |
| `ports_in_use` | A previous devnet left services running | `ada localnet down --json`, then up again |
| `orphaned_services` | Controller gone, services alive | Same — `down` then `up`. `portsHeld` lists the ports |
| `stop_incomplete` | Stop did not free every port | `portsHeld` lists them. Report to the user; something outside the tool holds them |
| `component_download_failed` | A devkit component did not download | Retry `ada localnet bootstrap --json`. Check disk space |
| `config_error` | A network has no endpoint configured | The `hint` contains the exact `ada config set` command |
| `invalid_args` | Wrong arguments | Re-read `ada help <command> --json` |
| `tool_missing` | `yaci-devkit` is not installed | The `hint` has the install command |
| `network_error` | An HTTP call failed | Retry once. If it persists, report it |
| `unknown_command` | No such command | `ada help --json` for the real list |
| `no_utxos` | The wallet holds nothing to spend | `ada airdrop 1000 --json` on devnet |
| `insufficient_funds` | Cannot cover the amount plus the fee | The message states available versus needed. Fund it or send less |
| `output_below_min_value` | An output is under the ledger's minimum | Send more. Every output must hold a minimum proportional to its size |
| `build_failed` | The transaction could not be constructed | Read the message; it carries the builder's reason |
| `submit_failed` | The chain rejected it after signing | Chain state moved between build and submit. Retry once |
| `mainnet_refused` | A wallet operation was attempted on mainnet | Not supported. Keys are stored unencrypted; use a test network |
| `wallet_open_failed` | The stored phrase could not be loaded | The wallet file may be corrupt |

**On a devnet failure, read `logTail` before guessing.** It is included in the response precisely so
you do not have to open a file, and it has named the cause every time so far.

## Safety rules

**Read commands are safe to run without asking.** `tip`, `info`, `localnet status`, `localnet logs`,
`config list`, `config get`, `help`. Run them freely to answer questions.

**Read commands include** `wallet list`, `wallet info`, `balance`, `utxos`, and a `transfer`
**without** `--yes` — that one builds a transaction but changes nothing.

**Ask first for anything that changes state.**

- `localnet up` — downloads up to 1.4 GB on first run and starts long-lived processes. Say so.
- `localnet down` — terminates the chain. Any state on it is lost. That is usually fine because a
  devnet is disposable, but say what you are doing.
- `localnet bootstrap` — a large download.
- `config set` / `config unset` — changes persistent settings the user relies on. Prefer
  `--network <name>` on a single command over changing the stored default.
- `wallet generate` — creates a key and **makes it the active wallet**, changing what later
  commands act on.
- `wallet remove --yes` — deletes the only copy of a recovery phrase. Irreversible.
- `transfer --yes` — moves money. Follow the two-step flow above.
- `airdrop` — safe on devnet, where the money is worthless.

**Transfers require explicit consent for the amount and the recipient, restated verbatim and never
paraphrased.** The dry run exists so you can show real numbers rather than estimates.

**Wallet keys are stored unencrypted** at `~/.ada/wallets`. Never print a recovery phrase unless the
user explicitly asks; `wallet info` omits it unless `--show-mnemonic` is passed. Mainnet is refused
outright for this reason.

**Never invent a command or a flag.** If `ada help --json` does not list it, it is not there.

## Platform limits worth knowing

The devnet runs as a native binary on **macOS arm64 and Linux x64 only**. On any other platform
`localnet up` fails at launch — that is a platform limitation, not a bug to work around.

Block time is configurable with `--block-time <seconds>` but the accepted range is **1 to 20
seconds**. Sub-second values are rejected.
