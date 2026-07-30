# Command surface — design spec

The README lists what the commands are. This is how they must behave, and the rules exist because
an agent is a first-class user rather than an afterthought.

---

## The output contract

Every command follows this, without exception:

**`--json` produces exactly one JSON document on stdout — for success and for failure alike.** No
banners, no spinners, no colour. Stderr carries progress and chrome only.

Failures go to **stdout**, not stderr. That is deliberate and it is the opposite of the first
implementation: `ada <cmd> --json | jq` has to work whether the command succeeded or not, or an agent
piping stdout gets nothing back on the cases it most needs to understand. It also matches
`midnight-wallet-cli`, so an agent that knows one tool knows the other.

Every document is self-labelling and the envelope is applied centrally, so no command can forget it:

    success   { "ok": true,  "command": "tip", ... }
    failure   { "ok": false, "error": true, "command": "tip", "code": "...", "message": "...",
                "hint": "..." }

**`code` is the contract; `message` is prose.** `insufficient_funds`, `output_below_min_value`,
`offer_expired` are safe to branch on. The message may be reworded at any time and must never be
pattern-matched. `hint`, where present, is the suggested next action. The exit code separates user
error from tool failure from chain rejection.

**The agent-facing contract lives in `docs/SKILL.md`**, which ships with the package. It is the
document an MCP client or coding agent should read, and it is written against the real command
surface — `ada help --json` reports `implemented` per command and is the authority.

**No interactive prompts on any path an agent needs.** Anything that would prompt takes a flag
instead. A confirmation step is allowed only where money moves irreversibly, and `--yes` must
always bypass it.

**Deterministic ordering.** Lists come back in a stable order so diffing two runs is meaningful.

This is why a terminal-UI wallet, however pleasant, is the wrong shape for this job.

## Wallets

A named-wallet model with one active wallet, so most commands take no address argument. Keys are
stored encrypted; the passphrase never appears in a command line, because command lines end up in
shell history and process listings.

`wallet info` shows the **payment address, the stake address, and the derivation path**, because
one Cardano wallet has two addresses that mean different things and confusing them produces
confident nonsense.

## Balance and UTxOs

`balance` reports ADA **and every native asset held**, not just ADA. A wallet holding assets and
no visible ADA figure is the first thing that confuses people coming from account-model chains.

`utxos` exists as a first-class command rather than a debugging afterthought. On this ledger a
balance is a sum over a set, so when a number looks wrong the next question is always *which
outputs produced it* — and the answer should be one command away, not a reconstruction.

## Transfer

The most-used command, and the one nothing off-the-shelf provides.

It must surface, before submitting: the **fee**, the **change output**, and whether any output
falls under the **minimum-value rule**. Those three facts are the cause of most first-week
failures, and on this chain all three are knowable in advance — so hiding them and letting the
chain reject the transaction wastes the ledger's best property.

`fee estimate` is the same computation without submitting.

## Assets

`asset mint` takes a policy and produces a native asset. `asset send` moves a **bundle** — several
distinct assets in a single transaction — because that is what the ledger natively supports and
what any real use of assets needs.

Metadata follows the established ecosystem conventions rather than inventing a local one.

## Swap

The differentiating capability, and the reason this tool is worth building rather than assembling
by hand each time.

A two-party atomic swap on Cardano needs no smart contract: one transaction is built from both
parties' inputs and requires both signatures, so either both sides move or nothing does. The
commands mirror that shape:

**`swap build`** — construct an offer from what you are giving and what you want.

**`swap inspect`** — show exactly what an offer would do to your wallet if you signed it. This is
the safety-critical command. A received offer is untrusted input, and the tool's job is to make
its actual effect impossible to misread before a signature exists.

**`swap sign`** — co-sign.

**`swap submit`** — submit the fully-signed transaction.

Transport is deliberately not included. Moving an offer between two parties is the calling
application's problem; the tool's responsibility ends at a transaction that is safe to hand over.

## Localnet

Wraps Yaci DevKit rather than reimplementing it, so there is one entry point even though someone
else does the work. `up`, `stop`, `down`, `status`, `logs`, `reset`.

`snapshot` and `rollback` expose the multi-node fork capability, because rollback behaviour is
something almost nobody tests until it breaks in production.

`airdrop` is the faucet, named to match the mental model rather than the underlying tool's term.

## Address

`derive` and `inspect` delegate to the ground-truth address tool rather than reimplementing
derivation. That is a deliberate constraint: derivation is the highest-consequence cryptography in
the stack, and this tool's job is to make the authoritative implementation convenient, not to add
a second one that can disagree with it.

## Config

Persistent config for network, active wallet, and endpoints, so the common case is a bare command.
Every config value is overridable by a flag for the same run, because an agent should be able to
act without mutating state a human relied on.
