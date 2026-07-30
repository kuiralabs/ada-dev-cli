# ada-wallet-cli

A standalone CLI wallet for Cardano, with a built-in MCP server so agents are first-class users.

**Read `docs/COMMANDS.md` before adding or changing a command.** It holds the output contract, and
the contract is the product — a command that prints a spinner into stdout has broken the tool for
its second audience.

## The core constraint

This tool exists to debug and validate *other* implementations, including the Kuira Cardano SDK.
That only works if it is an **independent implementation**. It is built on MeshJS, and it must
never be reimplemented on top of the SDK it is used to check — an oracle built from the code under
test can only confirm that code's own bugs.

If a change would make this tool share an implementation with something it validates, that change
is wrong regardless of how much duplication it removes.

## Compose, don't rewrite

Yaci DevKit owns the local chain. MeshJS owns wallet and transaction construction.
`cardano-address` owns derivation. This tool owns the *surface*: one command vocabulary, one
config, one agent interface, and the pieces nobody ships — transfers between arbitrary addresses,
asset bundles, and atomic swaps.

Before writing anything that looks like chain logic, check whether one of those three already does
it correctly.

## Rules

- **`--json` output is a contract.** Clean stdout, stable error reasons on stderr, deterministic
  ordering. Breaking it is a breaking change even if the human output looks fine.
- **No interactive prompts on any path an agent needs.** Flags instead. `--yes` always bypasses a
  confirmation.
- **Secrets never on argv.** Command lines land in shell history and process listings.
- **Derivation is not reimplemented here.** Delegate to the ground-truth tool. It is the
  highest-consequence cryptography in the stack and a second implementation can only disagree.
- **Tests reproduce failures.** A regression test must fail before the fix and pass after it, not
  assert the happy path.
- **Public repo, consumer voice.** No internal narrative, no issue numbers, no debugging history in
  user-facing docs. Internal reasoning belongs in the private planning repo.

## Cardano specifics worth not relearning

There is no balance field — balance is a sum over a UTxO set you fetched. Change is the sender's
responsibility and the ledger will happily let you burn the remainder. An output can be rejected
for being below a minimum value. Fees are a linear function of size and therefore knowable before
submitting, which is a gift: surface them rather than letting the chain reject the transaction.
One wallet has a payment address and a stake address, and they are not interchangeable.

There is no proving step. If something feels slow it is the network or the block time, never the
client.
