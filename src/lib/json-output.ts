// The --json contract.
//
// One JSON document on **stdout**, for success and for failure alike. Stderr is
// left for progress and chrome, matching the Unix convention (stdout = data,
// stderr = chrome) and — the reason that matters here — meaning
// `ada <cmd> --json | jq` works whether the command succeeded or not. An agent
// piping stdout always gets something parseable back.
//
// This deliberately matches midnight-wallet-cli, so an agent that has learned one
// of the two tools already understands the other. An earlier version of this file
// sent errors to stderr and left stdout empty, which made failures unparseable
// through a pipe and left the tool with two different failure shapes depending on
// which code path produced them.
//
// Every document carries both discriminators:
//   success  { "ok": true,  "command": "tip", ... }
//   failure  { "ok": false, "error": true, "code": "...", "message": "...", ... }
//
// `ok` is the field to branch on. `error: true` is present on failures for parity
// with the Midnight tool. `code` is the machine-stable contract — `message` is
// prose and may be reworded at any time.

/** Set by the MCP server so command output can be captured without hijacking
 *  process.stdout, which would collide with the stdio transport. */
let captureTarget: ((json: string) => void) | null = null;

export function setCaptureTarget(fn: ((json: string) => void) | null): void {
  captureTarget = fn;
}

/** The command being executed, stamped into every document so an agent can
 *  correlate a result with what it asked for. */
let currentCommand: string | undefined;

export function setCurrentCommand(name: string | undefined): void {
  currentCommand = name;
}

function emit(document: Record<string, unknown>, compact = false): void {
  // Indented for a single result, because a person reads it. Compact for a
  // stream, because a *line* is the unit there — a pretty-printed event spread
  // over twenty lines is not newline-delimited JSON however it is described,
  // and a consumer reading line by line gets nothing but parse errors.
  const json = (compact ? JSON.stringify(document) : JSON.stringify(document, null, 2)) + '\n';
  if (captureTarget) captureTarget(json);
  else process.stdout.write(json);
}

/**
 * A successful result. `ok` and `command` are added here rather than at each call
 * site, so no command can forget them or disagree about their spelling.
 */
export function writeJson(data: Record<string, unknown>): void {
  const { ok: _ok, command: _command, ...rest } = data;
  emit({ ok: true, ...(currentCommand ? { command: currentCommand } : {}), ...rest });
}

/**
 * One event of a stream, on one line.
 *
 * For the commands that run until interrupted and report as they go. Same
 * document shape as {@link writeJson}; the difference is that a reader consumes
 * these a line at a time, so a line has to be a whole document.
 */
export function writeJsonEvent(data: Record<string, unknown>): void {
  const { ok: _ok, command: _command, ...rest } = data;
  emit({ ok: data.ok ?? true, ...(currentCommand ? { command: currentCommand } : {}), ...rest }, true);
}

/**
 * A failure. Goes to stdout, for the reason in the header comment.
 *
 * `code` is stable and safe to branch on. `hint` carries the suggested next
 * action when there is one, which is usually the most useful field for an agent
 * deciding what to try next.
 */
export function writeJsonError(
  code: string,
  message: string,
  hint?: string,
  extra?: Record<string, unknown>,
  detail?: string,
): void {
  emit({
    ok: false,
    error: true,
    ...(currentCommand ? { command: currentCommand } : {}),
    code,
    message,
    ...(hint ? { hint } : {}),
    ...(detail ? { detail } : {}),
    ...(extra ?? {}),
  });
}
