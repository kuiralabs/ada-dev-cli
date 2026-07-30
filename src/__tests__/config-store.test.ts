// Config store behaviour, including the data-loss bug.
//
// The bug: a config file that did not parse was silently replaced with defaults
// on the next write, taking every other setting with it. A stray comma cost the
// user their endpoints. These tests run against a real temporary HOME so the
// atomic write and the preservation path are genuinely exercised, not mocked.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadConfigState, saveConfig, configPath, configDir, invalidConfigPath,
} from '../lib/cli-config.ts';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;
let realHome: string | undefined;

// Every path in cli-config is resolved through os.homedir() at call time rather
// than captured at import time, so pointing HOME at a temp directory fully
// isolates each test — no module reloading needed.
beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'ada-cfg-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

const writeRaw = (contents: string) => {
  mkdirSync(join(home, '.ada'), { recursive: true });
  writeFileSync(join(home, '.ada', 'config.json'), contents);
};

describe('config status reporting', () => {
  it('reports missing when there is no file', () => {
    const state = loadConfigState();
    expect(state.status).toBe('missing');
    expect(state.config.network).toBe('devnet');
  });

  it('reports missing for an empty file rather than corrupt', () => {
    writeRaw('   \n');
    expect(loadConfigState().status).toBe('missing');
  });

  it('reports corrupt for unparseable JSON', () => {
    writeRaw('{ "network": "devnet", }');
    const state = loadConfigState();
    expect(state.status).toBe('corrupt');
    // Still usable, so `ada help` cannot be broken by a bad config.
    expect(state.config.network).toBe('devnet');
  });

  it('reports ok and round-trips a written config', () => {
    saveConfig({ network: 'preprod', activeWallet: 'alice', endpoints: { preprod: { apiUrl: 'https://h/api/v1' } } });
    const state = loadConfigState();
    expect(state.status).toBe('ok');
    expect(state.config.network).toBe('preprod');
    expect(state.config.activeWallet).toBe('alice');
    expect(state.config.endpoints.preprod?.apiUrl).toBe('https://h/api/v1');
  });
});

describe('a corrupt config is preserved, not destroyed', () => {
  it('moves the unparseable file aside instead of overwriting it', () => {
    const original = '{ "network": "preprod", "endpoints": { BROKEN';
    writeRaw(original);

    saveConfig({ network: 'devnet', endpoints: {} });

    // The salvageable original still exists...
    expect(existsSync(invalidConfigPath())).toBe(true);
    expect(readFileSync(invalidConfigPath(), 'utf-8')).toBe(original);
    // ...and the new config is valid.
    expect(JSON.parse(readFileSync(configPath(), 'utf-8')).network).toBe('devnet');
  });

  it('does not create an .invalid file when the config was fine', () => {
    saveConfig({ network: 'devnet', endpoints: {} });
    saveConfig({ network: 'preview', endpoints: { preview: { apiUrl: 'https://h' } } });
    expect(existsSync(invalidConfigPath())).toBe(false);
  });
});

describe('writes are atomic', () => {
  it('leaves no temporary file behind', () => {
    saveConfig({ network: 'devnet', endpoints: {} });
    expect(existsSync(`${configPath()}.tmp`)).toBe(false);
  });

  it('produces parseable JSON with a trailing newline', () => {
    saveConfig({ network: 'devnet', endpoints: {} });
    const raw = readFileSync(configPath(), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('creates the config directory when absent', () => {
    expect(existsSync(configDir())).toBe(false);
    saveConfig({ network: 'devnet', endpoints: {} });
    expect(existsSync(configDir())).toBe(true);
  });
});
