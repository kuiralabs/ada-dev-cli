# How it fits together

Written for someone who has to change this code. It explains the shape, then walks a real command
from keystroke to output.

---

## The one-minute version

`ada` is a **short-lived program that talks to a long-lived chain over HTTP.**

That one sentence explains most of the design. The CLI runs for a few hundred milliseconds and
exits. The devnet keeps running for hours. So the CLI is not a server, does not hold state, and
does not manage the chain — it starts it once, stops it once, and in between only asks it
questions over HTTP.

Everything else follows from keeping those two lifetimes separate.

## Four layers, one rule each

```
src/ada.ts        the front door    — parse, dispatch, format errors, exit
src/commands/*    one per command   — decide WHAT to say
src/lib/*         the machinery     — decide WHAT IS TRUE
src/ui/*          presentation      — decide HOW IT LOOKS
```

**`lib` never prints and never exits.** It returns values or throws. This is what makes it
testable without spawning a CLI.

**`commands` never computes chain logic.** It calls `lib`, then chooses between machine output and
human output. Every command is the same five lines of shape: resolve config, call lib, branch on
`--json`.

**`ui` is only ever reached in human mode.** In `--json` mode nothing in `ui` is called at all,
which is how the promise of "clean stdout" is kept structurally rather than by remembering.

**`ada.ts` is the only file that calls `process.exit`.** One place decides exit codes.

If you find yourself printing from `lib` or fetching from `commands`, the layering has slipped.

## What actually happens: `ada localnet up`

The most involved command, so the best one to trace.

**1 · `ada.ts` parses the arguments.** `parseArgs` splits `['localnet','up']` into
`command: 'localnet'`, `positionals: ['up']`. Global flags are handled here — `--version` prints
and exits, `--help` anywhere reroutes to the help command.

**2 · The command is loaded on demand.** A lookup table maps `'localnet'` to
`import('./commands/localnet.ts')`. Dynamic, so `ada --version` does not pay to parse the devnet
code.

**3 · `localnet.ts` resolves where the devnet lives.** It asks `cli-config.ts` for the devnet
network, which returns `http://localhost:8080` (the query API) and `http://localhost:10000` (the
control API). Config on disk can override these; a flag can override config.

**4 · Is it already running?** One HTTP probe. If the API answers, print "already running" and
stop. `up` is safe to run twice — important, because running the devkit twice would kill the first
instance.

**5 • Is something stale in the way?** Two checks, both learned the hard way:
- A devkit process that is alive but not serving. It holds the control port, so the next start
  would die on a bind conflict. Stop it, and *verify* it stopped.
- Services running with no controller. Same conflict, arrived at from the other side. Refuse to
  start and say which ports are occupied.

**6 · Are the components downloaded?** The devkit needs `cardano-node` (~800 MB) and the indexer
(~22 MB), fetched once into `~/.yaci-cli`. Checks are size-aware, so an interrupted download
counts as absent rather than as present-but-broken.

**7 · Start it, detached.** `startDevnet` spawns the devkit with output redirected to
`~/.ada/logs/devnet.log`, then lets go of it. Two details matter:
- **`detached: true`** — the devnet must outlive this CLI process. It also makes the child a
  *process-group leader*, which is what later allows the whole family to be stopped.
- **`-Dyaci.store.enabled=true`** — the indexer is off in the devkit's default config, and a
  system property is the only override that reaches it (its launcher spawns with an empty
  environment, so environment variables are silently dropped).

We record that child's pid in `~/.ada/devnet.pid`. That is *our* handle, and it matters — see
below.

**8 · Wait for the API, watching for death.** Poll `http://localhost:8080/api/v1/blocks/latest`
every second. Between polls, check the process is still alive. Readiness means **the API answers**,
not that a process exists — a node that is running but not serving is not a usable devnet.

**9 · Report.** On success, one line. On failure, the last lines of the log are quoted inline,
because the log named the cause every single time. A crash and a slow start are reported
differently: "exited without serving the API" means read the log now, "did not answer within Ns"
means it may still be starting.

Typical result: **ready in about nine seconds.**

## What happens: `ada tip`

Short, and the shape every query command shares.

1. `ada.ts` dispatches to `commands/tip.ts`.
2. `cli-config.ts` resolves the network to a base URL.
3. `http.ts` fetches `ENDPOINTS.latestBlock` from that URL.
4. `--json` prints one JSON object; otherwise `ui/format.ts` prints an aligned block.

No processes, no devkit, no state. Just a URL and a shape.

## Why HTTP instead of the devkit's own CLI

This is the single decision that shapes the whole tool, and it came from a landmine.

The devkit's launcher writes a pid file and, **on every start, kills the process tree recorded in
it.** So asking the devkit a question by invoking it again would kill the devnet you were asking
about.

So: **invoke the devkit exactly once, to start the chain. Ask everything else over HTTP.** Faster
too — no JVM starts per query.

## The process group, and why `down` works now

The devnet is a family, not a process:

```
our spawned launcher      <- the group leader; the pid we record
└── yaci-cli              <- what the devkit's own pid file names
    ├── cardano-node          port 3001
    ├── cardano-submit-api    port 8090
    └── yaci-store            port 8080   (the query API)
```

The original stop killed *direct children only*. The three services are **grandchildren**, so they
survived — while `down` printed success. Then `status` read "running" because the API still
answered, and the next `up` died on a bind conflict.

Two things fix it:

**Signal the group, not the process.** Because the launcher was spawned detached, it leads its own
group, and one signal to the negative pid reaches every descendant.

**This is why we keep our own pid file.** The devkit's pid file names `yaci-cli` — one level
*below* the leader. Signalling that pid can never reach the group. Our record names the leader.

**Then verify.** After signalling, poll the four ports until they are free, escalate to a harder
signal, and if they are still held, **say so**. A `down` that lies is worse than one that admits
failure, because the next `up` inherits the mess with no explanation.

## Two APIs, and they are not the same

The devnet serves two HTTP surfaces, and confusing them is easy:

| | Port | Paths | Holds |
|---|---|---|---|
| Query API (indexer) | 8080 | `/api/v1/...` | blocks, addresses, UTxOs — Blockfrost-compatible |
| Control API (devkit) | 10000 | `/local-cluster/api/...` | faucet, reset, protocol parameters, forks |

Both return Blockfrost-shaped *data*; only the paths differ. The query API is what a public
network also speaks, which is why pointing at preprod later is mostly a URL change.

`constants.ts` declares both prefixes and every path is composed from one of them. **No file
builds a URL from a literal** — that rule exists so a query can never be sent to the wrong
surface, and a test asserts it.

## How an error travels

One path, no exceptions:

1. Something in `lib` throws an `AdaError` carrying a **machine-stable reason**, an **exit code**,
   and optionally a **hint**.
2. `ada.ts` catches it.
3. In `--json` mode it becomes `{ok: false, reason, message, hint}` on **stderr** — stdout stays
   empty, so a caller parsing stdout never mistakes a failure for a result.
4. In human mode it becomes a red line plus a dimmed hint.
5. `process.exit(code)` — `2` bad arguments, `3` config, `4` devnet not running, `5` network,
   `7` missing tool.

The *reason* is the contract; the *message* is prose and may be reworded freely.

## Where state lives

Nothing lives in the program. Everything is on disk, so any invocation can pick up where the last
left off:

```
~/.ada/config.json    network, active wallet, endpoint overrides
~/.ada/devnet.pid     the group leader we started
~/.ada/logs/          devnet.log — the devkit's stdout and stderr
~/.yaci-cli/          the devkit's own home: binaries, components, chain data
```

Config writes are **write-then-rename**, so an interrupted write cannot leave a truncated file.
An unparseable config is **moved aside, never overwritten** — it may hold settings worth
recovering.

## The file map

| File | Owns |
|---|---|
| `ada.ts` | dispatch, global flags, error formatting, exit codes |
| `lib/argv.ts` | argument parsing, and the set of flags that take no value |
| `lib/constants.ts` | **every URL path and timeout in the tool** |
| `lib/cli-config.ts` | reading/writing config, resolving a network to URLs |
| `lib/http.ts` | **the only place a network request is made** |
| `lib/yaci.ts` | **the only place a process is spawned or signalled** |
| `lib/errors.ts` / `exit-codes.ts` | the error taxonomy |
| `lib/json-output.ts` | the `--json` contract |
| `ui/format.ts`, `ui/colors.ts` | human output only |
| `commands/*.ts` | one per command; no chain logic |

Those three bolded rows are the ones to respect. One place for URLs, one for network calls, one for
processes — which is why the process-group bug was a two-line fix in one file rather than a hunt.

## What is not here yet

Wallets, balances, transfers, assets and swaps — stage 2 onward in `tasks/IMPLEMENTATION.md`. And
the MCP server, deliberately written *after* the commands rather than beside them, so it wraps a
surface that already works.

One known gap: `http.ts` cannot send headers, so a public network needing an API key is not yet
reachable. It arrives with preprod support.
