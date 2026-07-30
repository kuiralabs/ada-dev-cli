// The command reference, and its agreement with the rest of the tool.
//
// These catch a class of bug nothing else does: a command that exists but is not
// dispatchable, documented but unreachable, or reachable but undocumented. Each
// has happened in this codebase already — `swap` and `asset` shipped without MCP
// tools, and `help --json` reported an empty planned list while six commands were
// designed.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COMMANDS, GLOBAL_FLAGS, findCommand } from '../lib/reference.ts';
import { TOOLS } from '../lib/mcp/tools.ts';

const source = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf-8');

/** Command names the entry point can actually dispatch. */
const dispatchable = (): Set<string> => {
  const entry = source('../ada.ts');
  const block = entry.slice(entry.indexOf('COMMAND_LOADERS'), entry.indexOf('const args = parseArgs'));
  return new Set([...block.matchAll(/^\s*(\w+):\s*\(\)\s*=>\s*import/gm)].map((m) => m[1]));
};

describe('every documented command is reachable', () => {
  it('dispatches every command the reference calls implemented', () => {
    // Documented-but-unwired is invisible until a user types it.
    const reachable = dispatchable();
    for (const c of COMMANDS.filter((x) => x.implemented)) {
      expect(reachable.has(c.name), `${c.name} is documented but not dispatchable`).toBe(true);
    }
  });

  it('documents every command the entry point dispatches', () => {
    // Wired-but-undocumented is invisible until someone reads the source.
    for (const name of dispatchable()) {
      expect(findCommand(name), `${name} is dispatchable but undocumented`).toBeDefined();
    }
  });

  it('never claims a command is implemented without a usage line naming it', () => {
    for (const c of COMMANDS.filter((x) => x.implemented)) {
      expect(c.usage, c.name).toMatch(new RegExp(`\\bada ${c.name}\\b`));
      expect(c.summary.length, `${c.name} needs a real summary`).toBeGreaterThan(8);
    }
  });
});

describe('every MCP tool maps to a real command', () => {
  it('routes each tool to a dispatchable command', () => {
    const reachable = dispatchable();
    for (const tool of TOOLS) {
      expect(reachable.has(tool.command), `${tool.name} -> ${tool.command}`).toBe(true);
    }
  });

  it('exposes the money-path commands as tools, since an agent surface that omits them is half a tool', () => {
    const covered = new Set(TOOLS.map((t) => t.command));
    for (const command of ['transfer', 'asset', 'swap', 'balance', 'utxos', 'airdrop', 'wallet']) {
      expect(covered.has(command), `${command} has no MCP tool`).toBe(true);
    }
  });
});

describe('the reference is internally consistent', () => {
  it('has no duplicate command names', () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has no duplicate global flags', () => {
    const flags = GLOBAL_FLAGS.map((f) => f.flag);
    expect(new Set(flags).size).toBe(flags.length);
  });

  it('gives every documented flag a description', () => {
    for (const c of COMMANDS) {
      for (const f of c.flags ?? []) {
        expect(f.flag, c.name).toMatch(/^--/);
        expect(f.description.length, `${c.name} ${f.flag}`).toBeGreaterThan(4);
      }
    }
  });

  it('writes examples that actually invoke the command they document', () => {
    for (const c of COMMANDS) {
      for (const e of c.examples ?? []) {
        expect(e, `${c.name}: ${e}`).toMatch(new RegExp(`^ada ${c.name}\\b`));
      }
    }
  });

  it('documents --yes on every command whose examples use it', () => {
    // A flag shown in an example but absent from the global list would be a
    // documentation dead end.
    const globalFlagNames = new Set(GLOBAL_FLAGS.map((f) => f.flag.split(',')[0].split(' ')[0]));
    for (const c of COMMANDS) {
      for (const e of c.examples ?? []) {
        for (const flag of e.match(/--[a-z-]+/g) ?? []) {
          const known = globalFlagNames.has(flag)
            || (c.flags ?? []).some((f) => f.flag.startsWith(flag));
          expect(known, `${c.name} example uses ${flag}, which is documented nowhere`).toBe(true);
        }
      }
    }
  });
});
