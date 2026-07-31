# The local devnet

`ada localnet` runs a real Cardano chain on your machine — a block a second, twenty pre-funded
addresses, and an HTTP API to query it. It is a native process, not a container. First run downloads the components; after that a devnet
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

Four processes, on fixed ports:

| Service | Port | What it is |
|---|---|---|
| `yaci-cli` | 10000 | the devnet's control API: faucet, reset, protocol parameters |
| `cardano-node` | 3001 | the chain itself |
| `cardano-submit-api` | 8090 | transaction submission |
| Yaci Store | 8080 | the **Blockfrost-compatible API** — what `tip`, balances and UTxO queries use |

The devnet's own description also advertises Ogmios (1337), Kupo (1442) and a metrics port
(12798). None of them are served in this configuration — they are separate components, disabled
by default, the same way the indexer is. Do not plan against a port just because the devnet
mentions it.

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

## First run downloads about 1.4 GB

Two components, fetched once into `~/.yaci-cli`:

- `cardano-node`, `cardano-cli` and `cardano-submit-api` — about 970 MB
- the Yaci Store indexer — about 430 MB

Both land in `~/.yaci-cli`, which also holds chain data, so budget more than the download size.

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

## Platform support is narrower than it looks

The devkit's npm distribution resolves exactly two platform packages: **macOS arm64** and **Linux
x64**. There is no Intel-Mac build, no Linux arm64 build, and no Windows build on this path — an
unsupported platform fails at launch with "unsupported platform" rather than degrading.

Yaci DevKit also ships as Docker images, which cover more platforms. This tool does not use that
route today; if Intel-Mac or Linux-arm64 support is needed, that is where to look.

## Block time, and what the devkit can be told to do

`ada localnet up --block-time <seconds>` passes through to the devkit. On the version pinned here
the accepted range is **1 to 20 seconds** — **sub-second block times are not available**, whatever
the marketing elsewhere suggests. A newer devkit line adds them; this one does not.

The devkit itself accepts more than this tool exposes, and two are worth knowing about because
they make otherwise-awkward tests deterministic:

- **`--era`** — `babbage` or `conway`, defaulting to `conway`. Nothing later is selectable.
- **`--genesis-profile`** — `zero_fee`, `zero_min_utxo_value`, or both. A chain with no fees or no
  minimum-value rule is the clean way to test paths that those rules otherwise dominate.
- Node port, submit-API port, epoch length, and fresh genesis keys are all settable too.

None of these are surfaced by `ada` yet. When a test needs one, the flag exists.

## Ogmios: optional, and version-locked to the node

Ogmios is a bridge to the running node, and it answers one question nothing else
here can: **what does the node itself think this script costs?** Our own answer
comes from a Plutus VM reimplemented in JavaScript; the node's comes from the
implementation that will actually judge the transaction. `ada contract simulate
--verify-budget` compares the two, and a disagreement is worth knowing about.

Nothing requires it. The devkit generates a launcher at
`~/.yaci-cli/local-clusters/default/ogmios.sh` but **does not download the
binary**, so out of the box the launcher points at a file that is not there.

**The version is not a detail.** Ogmios speaks exactly one node-to-client
protocol version, and each release names the single `cardano-node` version it
pairs with. The newest release is normally ahead of whatever the devkit ships.
Get that wrong and the failure is quiet in the worst way: Ogmios starts, reads
the genesis, reports the right network magic, and then logs
`HealthFailedToConnect` forever while `/health` says `disconnected`.

So check what the devkit is running first:

```sh
~/.yaci-cli/cardano-node/bin/cardano-node --version
```

Then find the Ogmios release whose notes name that version — the release body
states it as ``cardano-node == <version>`` — and unpack it where the generated
launcher already expects it:

```sh
# node 10.1.4 pairs with Ogmios v6.11.0; confirm the pairing for your node
mkdir -p ~/.yaci-cli/components/ogmios/bin
unzip -j ogmios-v6.11.0-aarch64-macos.zip 'bin/ogmios' \
  -d ~/.yaci-cli/components/ogmios/bin
chmod +x ~/.yaci-cli/components/ogmios/bin/ogmios
xattr -d com.apple.quarantine ~/.yaci-cli/components/ogmios/bin/ogmios   # macOS
```

Start it from the cluster directory, because the launcher uses paths relative to
it:

```sh
cd ~/.yaci-cli/local-clusters/default && ./ogmios.sh
```

It is connected when `/health` says so — not merely when the process is up:

```sh
curl -s localhost:1337/health | grep -o '"connectionStatus":"[a-z]*"'
```

`ada status` reports it either way, and every command works without it. If you
see `connectionStatus: disconnected` with the node plainly running, the version
pairing is the first thing to check, and a dead node socket is the second: a
socket **file** existing is not the same as something listening on it.

## Ports are fixed for now

The service ports above are the devkit defaults. The devkit can be told to use others; **this tool
does not expose that yet**, so running two devnets side by side, or working around a port something
else already owns, is not supported today.
