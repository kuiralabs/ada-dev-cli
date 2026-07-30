# The local devnet

`ada localnet` runs a real Cardano chain on your machine — a block a second, twenty pre-funded
addresses, and an HTTP API to query it. First run downloads the components; after that a devnet
starts in under ten seconds.

```
ada localnet up          # start (downloads components on first run)
ada tip                  # confirm the chain is producing blocks
ada localnet status      # process state, API reachability, log path
ada localnet down        # stop
ada localnet bootstrap   # download components without starting anything
```

The chain is driven by [Yaci DevKit](https://devkit.yaci.xyz), which this tool wraps rather than
reimplements. Everything below is behaviour worth knowing when something looks wrong.

---

## What actually runs

Five processes, on fixed ports:

| Service | Port | What it is |
|---|---|---|
| `cardano-node` | 3001 | the chain itself |
| Yaci Store | 8080 | the **Blockfrost-compatible API** — what `tip`, balances and UTxO queries use |
| devkit admin | 10000 | devnet control: faucet, reset, protocol parameters |
| `cardano-submit-api` | 8090 | transaction submission |
| Prometheus | 12798 | metrics |

Readiness means **the API on 8080 answers**, not that a process exists. A running node that is
not yet serving is not a usable devnet, and treating the two as the same thing produces a tool
that reports success before anything works.

## Two APIs, and they are not the same shape

This surprises people, so it is worth stating plainly.

**Port 8080 is Blockfrost-compatible** — same paths, same field names. Anything written against
Blockfrost works against it, which is also why MeshJS can point at a local devnet with only a URL
change.

**Port 10000 is the devkit's own admin API** — different paths, but Blockfrost-shaped *responses*.
It is the only place some things exist: the faucet, chain reset, fork creation, and the live
protocol parameters. It publishes an OpenAPI document at `/v3/api-docs`, which is the
authoritative list rather than anything written here.

The tool keeps both prefixes as declared constants and composes every path from one of them, so
a query can never accidentally be sent to the wrong surface.

## First run downloads about 820 MB

Two components, fetched once into `~/.yaci-cli`:

- `cardano-node`, `cardano-cli` and `cardano-submit-api` — roughly 800 MB
- the Yaci Store indexer — roughly 22 MB

`ada localnet up` fetches whatever is missing before starting. `ada localnet bootstrap` does only
the download, which is useful on a slow connection or in a CI image build.

**The indexer is a separate component and is disabled in the devkit's default configuration.**
Without it a devnet still starts — node, submit API and admin API all come up — but nothing
serves port 8080, so every query command has nothing to talk to. `ada localnet up` enables it
explicitly. If you drive the devkit by hand and find your queries failing against a devnet that
appears healthy, this is why.

## Diagnosing a failed start

The log holds the cause of every startup failure seen so far:

```
ada localnet logs        # prints the path
```

`ada localnet up` quotes the last lines on failure rather than only pointing at the file, and
recognises the two failures that actually happen:

**`Address already in use`** — a previous devkit process is still holding a port. `up` clears a
stale process before starting, so this should be self-healing; if it persists, `ada localnet
down` then `up`.

**`binary is not found`** — a component is missing or a download was interrupted. Run `ada
localnet bootstrap`. Component checks are size-aware, so an interrupted download is treated as
absent rather than as present-but-broken.

A crash and a slow start are reported differently. "The devkit exited without serving the API"
means read the log now; "did not answer within Ns" means it is probably still starting.

## Pre-funded addresses

The devnet creates twenty addresses with 10,000 test ADA each, printed to the log on startup
with their derivation paths (`m/1852'/1815'/N'/0/0`), stake addresses and keys. They exist so you
never have to bootstrap funds by hand.

These are test keys on a throwaway chain. They are printed in plaintext deliberately and are
worthless outside it.

## Resetting

The devnet is disposable. `ada localnet down` then `up` gives a fresh chain from genesis —
usually faster and more reliable than reasoning about accumulated state. Nothing on a devnet is
worth preserving.

## Ports are fixed for now

The service ports above are the devkit defaults and are not yet configurable through this tool.
Running two devnets side by side, or working around a port that something else already owns, is
not supported today.
