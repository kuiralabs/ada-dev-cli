# What this is built on

Read this before `ARCHITECTURE.md`. That one explains how our code is arranged; this one explains
**what the pieces are, who makes them, and why each is here.**

---

## The problem

To do anything on Cardano you need four separate things:

1. **A blockchain** to talk to.
2. **A way to ask it questions** — like "what does this address own".
3. **A way to hold keys** and turn a recovery phrase into addresses.
4. **A way to build and sign transactions.**

On Cardano those are four different projects from four different groups, each with its own
interface. Getting from nothing to "I sent a transaction and can see why it failed" means learning
all four.

This tool is one command surface over the good parts. It composes them; it does not replace them.

---

## The cast

### Yaci DevKit — the chain on your laptop

**Made by:** BloxBean, an independent group that builds most of the practical Cardano developer
tooling.

**What it is:** a private, disposable Cardano blockchain that runs on your machine. Not a
simulator — it downloads and runs the *real* Cardano node software.

**Why we use it instead of a public test network:** a public testnet gives you ~20 seconds per
block, shared state, and no easy way to get test money. Yaci DevKit gives you **one block per
second**, a chain nobody else touches, **20 wallets pre-loaded with 10,000 fake ADA each**, and a
faucet. A test cycle goes from minutes to seconds.

This is the direct counterpart of the Docker localnet that `midnight-wallet-cli` manages.

### yaci-cli — the conductor

**What it is:** the actual program inside Yaci DevKit. A Java application compiled to a native
Mac/Linux binary, so there is no JVM to install.

**What it does:** it is the stage manager for the local chain. It downloads the real Cardano
binaries, writes the genesis and config files, starts the node, creates and funds the twenty test
wallets, starts the indexer, and exposes a control API.

**"Yaci"** is BloxBean's name for their chain-following tooling. So: *Yaci DevKit* is the product,
*yaci-cli* is the program you actually run. When our tool starts a devnet, it is running yaci-cli.

**One thing worth knowing:** it is built to be used interactively — you normally type into it. Our
tool drives it non-interactively instead, starting it once and then leaving it alone.

### cardano-node, cardano-cli, cardano-submit-api — the real Cardano

**Made by:** Intersect and IOG — the organisations that build Cardano itself.

**What they are:** the genuine blockchain software. `cardano-node` is the node. `cardano-cli` is
the official low-level tool. `cardano-submit-api` accepts transactions over HTTP.

Yaci downloads these (~800 MB, once) rather than reimplementing them. **The chain running locally
is the same software that runs mainnet**, which is what makes local testing meaningful.

Note: `cardano-cli` is **not a wallet.** It has no key management and no derivation — you query the
chain, build a transaction by hand, calculate the fee, sign, and submit, each as a separate step.
It is the authority on whether a transaction is *valid*, and useless for holding money.

### Yaci Store — the translator

**Made by:** BloxBean.

**What it is:** an indexer. It follows the chain and writes it into a database, then serves that
over HTTP.

**Why it is necessary:** a Cardano node knows everything about the chain but is bad at answering
questions about it. It speaks a binary streaming protocol, not HTTP, and it has no concept of
"what does this address own" — that requires scanning history. Yaci Store does that scanning and
answers in JSON.

**The important part:** it deliberately imitates **Blockfrost's** API. So the same code that reads
a local devnet also reads the real network, with only a URL change.

Two things caught us here, and both are in `docs/DEVNET.md`: Yaci Store is a **separate download**,
and it is **off by default**. A devnet without it looks perfectly healthy and answers no questions.

### Blockfrost — the shape everyone copied

**What it is:** a company that runs hosted Cardano APIs.

**Why it appears here even though we do not use it yet:** its API shape became the de-facto
standard, so "Blockfrost-compatible" is a meaningful claim and several projects make it. It is the
likely way this tool will reach preprod and mainnet later — hence the note that `http.ts` cannot
yet send an API key.

### MeshJS — the wallet and transaction brain (stage 2)

**Made by:** the MeshJS team, funded through Cardano's Catalyst programme.

**What it is:** a TypeScript SDK for Cardano. It is the piece that will do the actual money work:
turn a recovery phrase into keys, build transactions, sign them, mint native tokens, and co-sign a
two-party swap.

**Why MeshJS specifically:** two reasons.

Its **headless wallet** works on a server with no browser extension — which is what makes a CLI
wallet possible at all. Most Cardano wallet libraries assume a browser.

And it is an **independent implementation** from the Kuira Cardano SDK we are also building. That
matters more than it sounds: this tool's job includes telling us when *our own SDK* is wrong. An
oracle built from the code under test can only ever confirm that code's own bugs.

### cardano-address — the referee

**Made by:** Intersect.

**What it is:** the official command-line tool for turning a recovery phrase into keys and
addresses.

**How we use it:** as a **referee, not a dependency**. Turning a phrase into an address is the
highest-consequence step in the whole stack — get it wrong and money goes somewhere unrecoverable.
So our tool delegates to this rather than writing a second implementation that could disagree with
the official one.

---

## The two APIs

The local devnet answers on two HTTP surfaces. They do different jobs and this is the single
easiest thing to confuse.

**Port 8080 — "what is on the chain".** Read-only questions: latest block, what an address owns,
protocol parameters. Served by Yaci Store, shaped like Blockfrost. This is the one that also
exists on public networks.

**Port 10000 — "do something to my private chain".** Things that only make sense locally: give
this address money, reset the chain, fork it to test rollbacks, submit a transaction. Served by
yaci-cli. Nothing like it exists on a real network, because you cannot ask mainnet for free money.

Everything else the devnet exposes — the node on 3001, the submit API on 8090 — our tool does not
talk to directly.

---

## What we wrote versus what we integrated

Worth being blunt about the ratio.

**Integrated (other people's work, hundreds of thousands of lines):** the blockchain, the node, the
indexer, the local-network manager, the wallet and transaction SDK, the address tool.

**Written (ours, roughly a thousand lines):**
- one command vocabulary over all of it
- one config so you are not passing URLs and network names to every call
- lifecycle that actually works — start it, know when it is ready, stop it *completely*
- errors that name a cause instead of printing a Java stack trace
- machine-readable output, so an agent can drive it
- the pieces nobody ships: transfers between arbitrary addresses, asset bundles, atomic swaps

The value is the composition and the agent surface, not the chain logic. Any time we are tempted to
write chain logic, the first question is whether one of the pieces above already does it correctly.

---

## The picture

```
                    ada  (our CLI + MCP server)
                              │
        ┌─────────────────────┼──────────────────────┐
        │                     │                      │
   asks questions        controls the           does the money
   about the chain       local chain            (stage 2)
        │                     │                      │
  Yaci Store :8080     yaci-cli :10000            MeshJS
  (Blockfrost-shaped)   (faucet, reset, fork)   (keys, tx, swaps)
        │                     │                      │
        └──────────► cardano-node :3001 ◄────────────┘
                    (the real Cardano software)

  cardano-address  ── referee, checks our derivation is right
```

---

## The same shape as the Midnight tool

If `midnight-wallet-cli` is familiar, the mapping is close:

| | Midnight | Cardano |
|---|---|---|
| Local chain | Docker containers | Yaci DevKit (native binary) |
| Chain queries | Midnight indexer | Yaci Store, Blockfrost-shaped |
| Wallet + transactions | official Midnight TypeScript SDK | MeshJS |
| Fees | a separate token that must be registered and monitored | paid in ADA from the same coins — **this whole problem disappears** |
| Agent access | built-in MCP server | built-in MCP server |

That last row is the biggest practical difference between the two chains, and it is why this tool
will end up simpler than the Midnight one.
