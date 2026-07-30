// ada-wallet-cli — MCP server.
//
// Exposes the wallet and chain commands as MCP tools over stdio.
// Launch: ada-mcp  (or: node dist/mcp-server.js)
//
// Two things make this correct rather than merely working.
//
// Commands run **in-process**, not as subprocesses: a subprocess per tool call
// would be slow and would throw away the typed error taxonomy. Their output is
// redirected through the capture hook, because writing to stdout would corrupt the
// very stream the MCP client is reading.
//
// Tools that move money **cannot execute on the call that requests them.** They
// return a token the agent did not mint and cannot forge, which forces a
// conversation with the user before anything is spent. `--yes` alone would not:
// an agent would simply pass it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { captureCommand } from './lib/run-command.ts';
import type { Args } from './lib/argv.ts';
import { createConfirmationStore } from './lib/mcp/confirmation.ts';
import { TOOLS, byName, type ToolDef } from './lib/mcp/tools.ts';
import { PKG_VERSION, PKG_NAME } from './lib/pkg.ts';

const SKILL_URI = 'ada://skill';
const SKILL_PATH = fileURLToPath(new URL('../docs/SKILL.md', import.meta.url));

type CommandModule = { default: (args: Args) => Promise<void> };

const COMMAND_LOADERS: Record<string, () => Promise<CommandModule>> = {
  localnet: () => import('./commands/localnet.ts'),
  wallet: () => import('./commands/wallet.ts'),
  balance: () => import('./commands/balance.ts'),
  utxos: () => import('./commands/utxos.ts'),
  airdrop: () => import('./commands/airdrop.ts'),
  transfer: () => import('./commands/transfer.ts'),
  tip: () => import('./commands/tip.ts'),
  params: () => import('./commands/params.ts'),
  address: () => import('./commands/address.ts'),
  status: () => import('./commands/status.ts'),
};

const confirmations = createConfirmationStore();

const CONFIRM_TOOL = {
  name: 'ada_confirm',
  description:
    'Execute a pending operation after the user has agreed to it. Pass the token returned by '
    + 'ada_transfer, ada_wallet_remove or ada_localnet_reset. A token is single-use and expires in '
    + 'five minutes. Never call this without explicit consent for the operation it names.',
  annotations: { destructiveHint: true, openWorldHint: true },
  inputSchema: {
    type: 'object' as const,
    properties: { token: { type: 'string', description: 'The token from the pending operation.' } },
    required: ['token'],
  },
};

const server = new Server(
  { name: PKG_NAME, version: PKG_VERSION },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    ...TOOLS.map(({ name, description, inputSchema, annotations }) => ({
      name, description, inputSchema, annotations,
    })),
    CONFIRM_TOOL,
  ],
}));

// The skill ships with the package and is offered as a resource so a client can
// load the conventions rather than rediscovering them from tool descriptions.
server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{
    uri: SKILL_URI,
    name: 'ada-wallet-cli agent skill',
    description: 'How to drive this tool: intent routing, the two-step send flow, error recovery, safety rules.',
    mimeType: 'text/markdown',
  }],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri !== SKILL_URI) {
    throw new Error(`unknown resource: ${request.params.uri}`);
  }
  return {
    contents: [{ uri: SKILL_URI, mimeType: 'text/markdown', text: readFileSync(SKILL_PATH, 'utf-8') }],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  const input = (request.params.arguments ?? {}) as Record<string, unknown>;

  if (name === CONFIRM_TOOL.name) return handleConfirm(input);

  const tool = byName(name);
  if (!tool) return failure('unknown_tool', `no such tool: ${name}`, 'call tools/list for the current set');

  // A money-moving tool stops here on its first call, every time.
  if (tool.describeForConsent) {
    const pending = confirmations.create({
      tool: tool.name,
      args: input,
      description: tool.describeForConsent(input),
    });
    return result({
      ok: true,
      pending: true,
      token: pending.token,
      description: pending.description,
      expiresAt: new Date(pending.expiresAt).toISOString(),
      next: 'show the description to the user verbatim, obtain explicit consent, then call ada_confirm with this token',
    });
  }

  return execute(tool, input);
});

async function handleConfirm(input: Record<string, unknown>) {
  const token = typeof input.token === 'string' ? input.token : '';
  if (!token) return failure('invalid_args', 'ada_confirm needs a token');

  const pending = confirmations.redeem(token);
  if (!pending) {
    // Deliberately does not say whether the token was wrong or merely expired: the
    // action is the same, and re-requesting is always safe.
    return failure(
      'token_not_valid',
      'that token is unknown or has expired',
      'request the operation again to get a fresh token — tokens are single-use and last five minutes',
    );
  }

  const tool = byName(pending.tool);
  if (!tool) return failure('unknown_tool', `the pending operation names a tool that no longer exists: ${pending.tool}`);

  const outcome = await execute(tool, pending.args);
  return outcome;
}

async function execute(tool: ToolDef, input: Record<string, unknown>) {
  const loader = COMMAND_LOADERS[tool.command];
  if (!loader) return failure('internal_error', `no handler for command ${tool.command}`);

  const { document } = await captureCommand(tool.command, tool.toArgv(input), loader);
  return result(tool.transformResult ? tool.transformResult(document) : document);
}

/** MCP tool results carry text content; the text is the JSON document the CLI
 *  would have printed, so an agent sees one shape everywhere. */
function result(document: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(document, null, 2) }],
    isError: document.ok === false,
  };
}

function failure(code: string, message: string, hint?: string) {
  return result({ ok: false, error: true, code, message, ...(hint ? { hint } : {}) });
}

const transport = new StdioServerTransport();
await server.connect(transport);
