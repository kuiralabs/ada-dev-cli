// The --json contract, pinned.
//
// This is the tool's machine-facing API. It is more load-bearing than any single
// command, because an agent branches on it — so it gets tests that assert the
// envelope rather than trusting each command to remember it.
//
// The bug these were written against: failures went to stderr from one code path
// and to stdout from another, in two different shapes. An agent piping stdout got
// nothing on some failures and an unlabelled object on others.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  writeJson, writeJsonError, setCaptureTarget, setCurrentCommand,
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
