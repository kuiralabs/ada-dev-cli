// The --json contract, pinned.
//
// This is the tool's machine-facing API. It is more load-bearing than any single
// command, because an agent branches on it — so it gets tests that assert the
// envelope rather than trusting each command to remember it.
//
// The bug these were written against: failures went to stderr from one code path
// and to stdout from another, in two different shapes. An agent piping stdout got
// nothing on some failures and an unlabelled object on others.

import { COMMANDS } from '../lib/reference.ts';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeJson, writeJsonError, writeJsonEvent, setCaptureTarget, setCurrentCommand,
} from '../lib/json-output.ts';

let captured: string[] = [];

beforeEach(() => {
  captured = [];
  setCaptureTarget((json) => captured.push(json));
  setCurrentCommand(undefined);
});

afterEach(() => {
  setCaptureTarget(null);
  setCurrentCommand(undefined);
});

const one = () => {
  expect(captured).toHaveLength(1);
  return JSON.parse(captured[0]) as Record<string, unknown>;
};

describe('every document is parseable and self-labelling', () => {
  it('stamps ok:true on a result', () => {
    writeJson({ height: 42 });
    const doc = one();
    expect(doc.ok).toBe(true);
    expect(doc.height).toBe(42);
  });

  it('stamps ok:false and error:true on a failure', () => {
    writeJsonError('devnet_not_running', 'cannot reach the devnet');
    const doc = one();
    expect(doc.ok).toBe(false);
    // Both discriminators, so an agent taught either convention works.
    expect(doc.error).toBe(true);
    expect(doc.code).toBe('devnet_not_running');
    expect(doc.message).toBe('cannot reach the devnet');
  });

  it('emits exactly one document per call, newline-terminated', () => {
    writeJson({ a: 1 });
    expect(captured).toHaveLength(1);
    expect(captured[0].endsWith('\n')).toBe(true);
    expect(() => JSON.parse(captured[0])).not.toThrow();
  });

  it('permits more than one document only where the command declares it', () => {
    // The contract is one document per invocation, and a watch loop cannot
    // honour it: an agent following a build wants the rebuilds as they happen.
    // That exception is declared on the command rather than explained in the
    // manual, so it is checkable — an undocumented streaming command is the
    // thing this prevents, not streaming itself.
    const streaming = COMMANDS.filter((c) => c.streaming).map((c) => c.name);
    expect(streaming).toEqual(['dev']);

    for (const command of COMMANDS.filter((c) => c.implemented && !c.streaming)) {
      // Anything that runs until interrupted must say so, since a caller
      // reading one document and exiting would hang or truncate.
      expect(command.usage, `${command.name} looks like a watch loop`)
        .not.toMatch(/\bwatch\b/i);
    }
  });

  it('puts a streaming event on exactly one line', () => {
    // The claim was "one document per event, newline-delimited". It was false:
    // the writer pretty-printed, so one event spanned twenty lines and a reader
    // consuming line by line got nothing but parse errors. A stream's unit is
    // the line, so a line has to be a whole document.
    writeJsonEvent({ event: 'rebuild', addressChanged: true, nested: { a: 1, b: [2, 3] } });
    expect(captured).toHaveLength(1);

    const [line] = captured;
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n'), 'the event spans more than one line').toBe(false);
    expect(() => JSON.parse(line)).not.toThrow();
  });

  it('stamps a streaming event the same way as a single result', () => {
    // Same document shape either way; only the formatting differs. An agent
    // should not need two parsers.
    setCurrentCommand('dev');
    writeJsonEvent({ event: 'rebuild' });
    const doc = JSON.parse(captured[0]);
    expect(doc.ok).toBe(true);
    expect(doc.command).toBe('dev');
    expect(doc.event).toBe('rebuild');
  });

  it('says so in the human help for a streaming command', () => {
    const dev = COMMANDS.find((c) => c.name === 'dev');
    expect(dev?.streaming).toBe(true);
    expect(dev?.detail).toMatch(/one document/i);
  });

  it('includes the command name so a result can be correlated', () => {
    setCurrentCommand('tip');
    writeJson({ height: 1 });
    expect(one().command).toBe('tip');
  });

  it('labels the command on failures too', () => {
    setCurrentCommand('localnet');
    writeJsonError('devnet_exited', 'it died');
    expect(one().command).toBe('localnet');
  });
});

describe('a command cannot break the envelope', () => {
  it('ignores an ok field passed by a caller', () => {
    // A command that tried to report failure through writeJson would otherwise
    // emit ok:false with no code — parseable, and a lie.
    writeJson({ ok: false, status: 'running' });
    const doc = one();
    expect(doc.ok).toBe(true);
    expect(doc.status).toBe('running');
  });

  it('ignores a command field passed by a caller', () => {
    setCurrentCommand('tip');
    writeJson({ command: 'something-else' });
    expect(one().command).toBe('tip');
  });
});

describe('optional fields appear only when present', () => {
  it('omits hint when there is none', () => {
    writeJsonError('some_code', 'a message');
    expect('hint' in one()).toBe(false);
  });

  it('includes hint when given, because it is the agent\'s next action', () => {
    writeJsonError('devnet_not_running', 'no devnet', 'start it with: ada localnet up');
    expect(one().hint).toBe('start it with: ada localnet up');
  });

  it('merges structured extras for diagnosis', () => {
    writeJsonError('stop_incomplete', 'ports still held', undefined, { portsHeld: [8080, 3001] });
    expect(one().portsHeld).toEqual([8080, 3001]);
  });

  it('omits command entirely when none is set', () => {
    writeJson({ a: 1 });
    expect('command' in one()).toBe(false);
  });
});

describe('capture redirects output away from stdout', () => {
  it('sends nothing to stdout while a capture target is set', () => {
    // The MCP server needs this: writing to stdout would corrupt its transport.
    let stdoutCalls = 0;
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: unknown) => {
      stdoutCalls++;
      return realWrite(chunk as string);
    }) as typeof process.stdout.write;
    try {
      writeJson({ a: 1 });
      writeJsonError('x', 'y');
    } finally {
      process.stdout.write = realWrite;
    }
    expect(stdoutCalls).toBe(0);
    expect(captured).toHaveLength(2);
  });
});

describe('help scopes to a topic in json mode', () => {
  // The bug: the json branch ran before the topic check, so `help tip --json`
  // returned all ten commands and `help nonesuch --json` returned success.
  it('returns one command_info for a known topic, not the whole list', async () => {
    const help = (await import('../commands/help.ts')).default;
    const { parseArgs } = await import('../lib/argv.ts');
    await help(parseArgs(['help', 'tip', '--json']));
    const doc = one();
    expect(doc.commands).toBeUndefined();
    expect((doc.command_info as Record<string, unknown>).name).toBe('tip');
  });

  it('fails rather than succeeding for an unknown topic', async () => {
    const help = (await import('../commands/help.ts')).default;
    const { parseArgs } = await import('../lib/argv.ts');
    await expect(help(parseArgs(['help', 'nonesuch', '--json']))).rejects.toThrow(/no such command/);
  });

  it('still returns the full list with no topic', async () => {
    const help = (await import('../commands/help.ts')).default;
    const { parseArgs } = await import('../lib/argv.ts');
    await help(parseArgs(['help', '--json']));
    expect(Array.isArray(one().commands)).toBe(true);
  });
});

describe('provider chatter does not leak onto stderr', () => {
  // Mesh logs a cost-model stack trace on every build against the devnet. Node
  // routes console.warn to stderr, and the first fix patched only console.error —
  // so it suppressed nothing. This pins both.
  it('suppresses the cost-model warning from warn and error alike', async () => {
    const { withoutCostModelNoise } = await import('../lib/mesh.ts');
    const seen: string[] = [];
    const realWarn = console.warn;
    const realError = console.error;
    console.warn = (...p: unknown[]) => { seen.push(`warn:${String(p[0])}`); };
    console.error = (...p: unknown[]) => { seen.push(`error:${String(p[0])}`); };
    try {
      await withoutCostModelNoise(async () => {
        console.warn('Failed to fetch cost models, using default cost models. Error: ', new Error('x'));
        console.error('Failed to fetch cost models, using default cost models. Error: ', new Error('x'));
        console.warn('something else entirely');
      });
    } finally {
      console.warn = realWarn;
      console.error = realError;
    }
    expect(seen).toEqual(['warn:something else entirely']);
  });

  it('restores the console even when the wrapped work throws', async () => {
    const { withoutCostModelNoise } = await import('../lib/mesh.ts');
    const before = console.warn;
    await expect(withoutCostModelNoise(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    // A patched console surviving a failure would silence the rest of the process.
    expect(console.warn).toBe(before);
  });
});
