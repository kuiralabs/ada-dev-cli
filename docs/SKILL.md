# ada-dev-cli — Agent Skill

You have access to Cardano through this tool, either as the `ada` CLI or as the `ada-mcp` MCP
server. Read this once at the start of a session; use it as reference throughout.

**Over MCP**, prefer the tools: `ada_status`, `ada_balance`, `ada_transfer_preview`,
`ada_transfer` + `ada_confirm`, and so on. Tool descriptions carry the same rules as this document
and the annotations tell you what is safe to call unasked. The two-step send flow below is
**enforced** there — `ada_transfer` cannot send on its own, whatever arguments you pass.

**Over the CLI**, every command takes `--json`. The rules are identical.

**Scope note:** everything below works — wallets, balances, funding, ADA transfers, native assets,
two-party atomic swaps, the devnet lifecycle and chain inspection. **Never invent a command.** Ask the tool what it has:

```
ada help --json
```

If `ada` is not found, it has not been linked yet — the project is not on npm. From a clone:
`npm install && npm run build && npm link`.

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
  addresses, disposable. `preprod` and `preview` are public testnets and **work with no setup and no
  API key**; pass `--network preprod` to any read command. `mainnet` is real money, and wallet
  operations on it are refused.

## Intent routing

| User says | Run |
|---|---|
| "start a local chain" / "start the devnet" | `ada localnet up --json` |
| "stop the devnet" | `ada localnet down --json` |
| "is the devnet running?" | `ada localnet status --json` |
| "where are the devnet logs?" | `ada localnet logs --json` |
| "download the devnet components" | `ada localnet bootstrap --json` |
| "reset the chain" / "wipe the devnet" | `ada localnet reset --yes --json` — ask consent first, all balances are lost |
| "what block are we on?" / "is the chain producing?" | `ada tip --json` |
| "what network am I on?" / "is it reachable?" | `ada info --json` |
| "is everything working?" / "health check" | `ada status --json` — chain, devnet and wallet in one call |
| "what are the fees?" / "what's the min-UTxO?" | `ada params --json` |
| "decode this address" / "is this a stake address?" | `ada address inspect <addr> --json` |
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
| "balance of wallet bob" | `ada balance bob --json` or `ada balance --wallet bob --json` |
| "show my UTxOs" / "why is my balance that?" | `ada utxos --json` |
| "fund my wallet" (devnet only) | `ada airdrop 1000 --json` |
| "what would it cost to send 10 ADA?" | `ada transfer <addr> 10 --json` — **no `--yes`, so nothing is sent** |
| "send 10 ADA to X" | dry run first, show the fee, get consent, then add `--yes` |

| "mint 100 tokens called Silk" | `ada asset mint --name Silk --qty 100 --json` — needs `--yes` to submit |
| "what's my policy id?" | `ada asset policy --json` |
| "send 25 Silk to X" | `ada asset send <addr> <unit>:25 --json` — dry run first, then `--yes` |
| "swap 20 Silk for 50 ADA with X" | `ada swap build --with <addr> --give <unit>:20 --want 50ADA` |
| "check this offer" | `ada swap inspect <offer> --json` — **always before signing** |
| "accept the swap" | `ada swap sign <offer> --yes`, then `ada swap submit <offer>` |

`ada status --json` is the right first call when something is wrong: it reports chain reachability,
the devnet process, the active wallet and a single `healthy` boolean, and it never throws for an
unreachable chain — an unreachable chain is the answer, not an error.

## Sending ADA — the two-step flow

**Over MCP this is enforced, not advisory.** `ada_transfer` never sends. It returns
`{pending: true, token, description, expiresAt}`. Show the `description` to the user **verbatim**,
get explicit consent, then call `ada_confirm({token})`. The token is **single-use** and expires in
five minutes; a replay fails with `token_not_valid`. You cannot mint one, so you cannot skip the
conversation.

`ada_wallet_remove` and `ada_localnet_reset` work the same way.

Call `ada_transfer_preview` first: it builds the transaction against live protocol parameters and
reports the **real** fee, so you are showing the user a number rather than an estimate.

**Over the CLI**, `ada transfer` does not send anything without `--yes`.

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

## Swaps — what to check before signing

A Cardano atomic swap is one transaction built from both parties' inputs and requiring both
signatures, so **either both sides move or nothing does**. No smart contract is involved.

The maker runs `swap build` — which **partially signs and therefore commits them** — and sends the
offer blob. The taker then:

1. **`ada swap inspect <offer> --json`.** Always. It reports what the transaction does to your
   balance, **derived from the transaction itself, not from the offer's description**. Read
   `youGive`, `youReceive` and `safeToSign`.
2. **Check `warnings`.** Anything marked `MISREPRESENTED` means the description and the transaction
   disagree — the offer is lying about the deal. Refuse it and tell the user plainly.
3. Show the user the figures from `inspect`, **never the ones the sender wrote**.
4. On consent, `swap sign --yes`, then `swap submit`.

`sign` independently refuses an offer that is expired, on the wrong network, unsigned by the maker,
addressed to a different wallet, or misrepresented. Those refusals are a backstop, not a substitute
for inspecting.

Over MCP the same flow is enforced: `ada_swap_inspect` is read-only and free to call, while
`ada_swap_build`, `ada_swap_sign` and `ada_swap_submit` each return a token you must confirm.

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
| `config_error` | Configuration or capability mismatch — e.g. asking a public network for a faucet | Read the `hint`; it names the actual problem |
| `invalid_args` | Wrong arguments | Re-read `ada help <command> --json` |
| `tool_missing` | `yaci-devkit` is not installed | The `hint` has the install command |
| `network_error` | An HTTP call failed | Retry once. If it persists, report it |
| `unknown_command` | No such command | `ada help --json` for the real list |
| `no_utxos` | The wallet holds nothing to spend | `ada airdrop 1000 --json` on devnet |
| `insufficient_funds` | Cannot cover the amount plus the fee | The message states available versus needed. Fund it or send less |
| `output_below_min_value` | An output is under the ledger's minimum | The message names the exact floor. Send at least that. An output carrying assets needs more than a plain one |
| `build_failed` | The transaction could not be constructed | Read the message; it carries the builder's reason |
| `submit_failed` | The chain rejected it after signing | Chain state moved between build and submit. Retry once |
| `mainnet_refused` | A wallet operation was attempted on mainnet | Not supported. Keys are stored unencrypted; use a test network |
| `wallet_open_failed` | The stored phrase could not be loaded | The wallet file may be corrupt |
| `reset_failed` | The devnet refused a reset | Check `ada localnet status --json`; the control API may be down |
| `offer_misrepresented` | The offer's description does not match its transaction | **Refuse it.** Report exactly what the transaction does versus what was claimed |
| `offer_expired` | The offer is past its 15-minute window | Ask the maker for a fresh one |
| `maker_not_signed` | The maker has not signed | Do not sign first — they could take your side without giving theirs |
| `not_the_taker` | The offer is addressed to a different wallet | Select that wallet, or refuse |
| `network_mismatch` | Offer built for another network | Switch with `--network`, or refuse |
| `offer_unreadable` | The transaction could not be decoded | Do not sign something you cannot read |
| `incomplete_signatures` | Submitted before both parties signed | The taker signs first |
| `insufficient_asset` | Not enough of a native asset | The message names the asset and the amount held |

**On a devnet failure, read `logTail` before guessing.** It is included in the response precisely so
you do not have to open a file, and it has named the cause every time so far.

## Safety rules

**Read commands are safe to run without asking.** `tip`, `info`, `localnet status`, `localnet logs`,
`config list`, `config get`, `help`. Run them freely to answer questions.

**Read commands include** `wallet list`, `wallet info`, `balance`, `utxos`, `swap inspect`, and a
`transfer` **without** `--yes` — that one builds a transaction but changes nothing.

**Over MCP there are two tiers of protection.** A tool marked `destructiveHint` has a side effect
and you should ask before calling it. A tool that returns a **pending token** cannot proceed at all
until the user confirms — reserved for what cannot be undone: spending, minting, committing to a
swap, deleting a key, wiping a chain. Creating a wallet, taking devnet faucet money and stopping the
local chain are the first tier, not the second, because a token on every side effect would train you
to redeem them without reading.

**A consent description always names the wallet.** If you created or switched a wallet earlier in
the session, the account a transfer spends from may not be the one the user has in mind — so read
the description back verbatim rather than summarising it.

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
- `localnet reset --yes` — wipes the chain to genesis. Wallet **keys survive**, every **balance does
  not**. Say that before doing it.

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
