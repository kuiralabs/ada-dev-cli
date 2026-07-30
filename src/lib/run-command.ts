// Running a command in-process and capturing its JSON, for the MCP server.
//
// The server cannot shell out to the CLI (a subprocess per tool call is slow and
// loses the error taxonomy) and it cannot let a command write to stdout (that is
// the stdio transport the MCP client is reading). So output is redirected through
// the capture hook in json-output.ts for the duration of the call.

import { parseArgs, type Args } from './argv.ts';
import { setCaptureTarget, setCurrentCommand } from './json-output.ts';
import { toAdaError } from './errors.ts';

export interface CaptureResult {
  /** The JSON document the command produced, parsed. */
  document: Record<string, unknown>;
  /** False when the command reported a failure. */
  ok: boolean;
}

type CommandModule = { default: (args: Args) => Promise<void> };

/**
 * Execute a command as the CLI would, returning its JSON document.
 *
 * `--json` is forced on: a tool call has no human to read prose. A command that
 * throws is converted into the same failure envelope the CLI would print, so an
 * agent sees one shape whether the command reported the problem itself or threw.
 */
export async function captureCommand(
  name: string,
  argv: string[],
  loader: () => Promise<CommandModule>,
): Promise<CaptureResult> {
  const chunks: string[] = [];
  setCaptureTarget((json) => chunks.push(json));
  setCurrentCommand(name);

  try {
    const args = parseArgs([name, ...argv, '--json']);
    const mod = await loader();
    await mod.default(args);
  } catch (err) {
    const adaErr = toAdaError(err);
    // Built here rather than reusing writeJsonError so the shape is identical even
    // if the capture target was never invoked.
    chunks.length = 0;
    chunks.push(JSON.stringify({
      ok: false,
      error: true,
      command: name,
      code: adaErr.code,
      message: adaErr.message,
      ...(adaErr.hint ? { hint: adaErr.hint } : {}),
    }));
  } finally {
    setCaptureTarget(null);
    setCurrentCommand(undefined);
  }

  if (chunks.length === 0) {
    // A command that produced nothing is a bug, but the agent still needs a shape.
    return {
      document: { ok: false, error: true, command: name, code: 'no_output', message: `${name} produced no output` },
      ok: false,
    };
  }

  const document = JSON.parse(chunks[chunks.length - 1]) as Record<string, unknown>;
  return { document, ok: document.ok === true };
}
