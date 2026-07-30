// The MCP capture path.
//
// Every MCP tool goes through this. If it breaks, all 25 break at once, and the
// failure mode is silent — a tool returning nothing looks like a command that
// produced nothing. It had no tests at all.
//
// Two properties matter. Nothing may reach stdout, because that is the transport
// the MCP client is reading. And a command that throws must produce the same
// failure envelope as one that reports failure itself, so an agent sees one shape.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { captureCommand } from '../lib/run-command.ts';
import { writeJson, writeJsonError } from '../lib/json-output.ts';
import { usageError, AdaError } from '../lib/errors.ts';
import { EXIT_CHAIN_REJECTED } from '../lib/exit-codes.ts';
import type { Args } from '../lib/argv.ts';

const moduleOf = (fn: (args: Args) => Promise<void>) => async () => ({ default: fn });

afterEach(() => vi.restoreAllMocks());

describe('capturing a command', () => {
  it('returns the document the command wrote', async () => {
    const { document, ok } = await captureCommand('tip', [], moduleOf(async () => {
      writeJson({ height: 42 });
    }));
    expect(ok).toBe(true);
    expect(document.height).toBe(42);
    expect(document.ok).toBe(true);
  });

  it('stamps the command name so a result can be correlated', async () => {
    const { document } = await captureCommand('balance', [], moduleOf(async () => {
      writeJson({ ada: '10' });
    }));
    expect(document.command).toBe('balance');
  });

  it('forces --json, because a tool call has no human to read prose', async () => {
    let seen: Args | undefined;
    await captureCommand('tip', ['--network', 'preprod'], moduleOf(async (args) => {
      seen = args;
      writeJson({});
    }));
    expect(seen?.flags.json).toBe(true);
    expect(seen?.flags.network).toBe('preprod');
  });

  it('passes positional arguments through in order', async () => {
    let seen: Args | undefined;
    await captureCommand('asset', ['send', 'addr_test1x', 'unit:5'], moduleOf(async (args) => {
      seen = args;
      writeJson({});
    }));
    expect(seen?.command).toBe('asset');
    expect(seen?.positionals).toEqual(['send', 'addr_test1x', 'unit:5']);
  });

  it('writes nothing to stdout — that stream belongs to the MCP transport', async () => {
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await captureCommand('tip', [], moduleOf(async () => { writeJson({ height: 1 }); }));
    expect(spy).not.toHaveBeenCalled();
  });

  it('restores the capture target afterwards, so the CLI still prints', async () => {
    await captureCommand('tip', [], moduleOf(async () => { writeJson({}); }));
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    writeJson({ after: true });
    expect(spy).toHaveBeenCalled();
  });
});

describe('a thrown command produces the same envelope as a reported failure', () => {
  it('converts an AdaError into a failure document', async () => {
    const { document, ok } = await captureCommand('transfer', [], moduleOf(async () => {
      throw new AdaError('insufficient_funds', 'not enough', EXIT_CHAIN_REJECTED, 'fund it');
    }));
    expect(ok).toBe(false);
    expect(document).toMatchObject({
      ok: false, error: true, command: 'transfer',
      code: 'insufficient_funds', message: 'not enough', hint: 'fund it',
    });
  });

  it('converts an unexpected throw rather than leaking a stack trace', async () => {
    const { document, ok } = await captureCommand('tip', [], moduleOf(async () => {
      throw new TypeError('undefined is not a function');
    }));
    expect(ok).toBe(false);
    expect(document.code).toBe('internal_error');
    expect(document.message).toMatch(/undefined is not a function/);
  });

  it('discards partial output when a command throws midway', async () => {
    // Otherwise an agent could read a half-written success document and act on it.
    const { document, ok } = await captureCommand('swap', [], moduleOf(async () => {
      writeJson({ partial: true });
      throw usageError('changed my mind');
    }));
    expect(ok).toBe(false);
    expect(document.partial).toBeUndefined();
    expect(document.code).toBe('invalid_args');
  });

  it('restores the capture target even when the command throws', async () => {
    await captureCommand('tip', [], moduleOf(async () => { throw new Error('boom'); }));
    const spy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    writeJson({ after: true });
    expect(spy).toHaveBeenCalled();
  });

  it('reports a command that produced nothing rather than returning an empty object', async () => {
    // Silence is a bug, but the agent still needs a shape to branch on.
    const { document, ok } = await captureCommand('tip', [], moduleOf(async () => { /* writes nothing */ }));
    expect(ok).toBe(false);
    expect(document.code).toBe('no_output');
  });

  it('keeps the last document when a command writes more than one', async () => {
    const { document } = await captureCommand('tip', [], moduleOf(async () => {
      writeJsonError('first', 'superseded');
      writeJson({ height: 7 });
    }));
    expect(document.height).toBe(7);
    expect(document.ok).toBe(true);
  });
});
