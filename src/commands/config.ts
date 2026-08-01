// Persistent config. Dotted paths are supported for endpoint overrides so a
// public network can be pointed somewhere without hand-editing JSON.

import type { Args } from '../lib/argv.ts';
import { hasFlag } from '../lib/argv.ts';
import {
  loadConfig, loadConfigState, saveConfig, configPath, invalidConfigPath,
  assertNetworkName, type AdaConfig,
} from '../lib/cli-config.ts';
import { listWallets } from '../lib/wallet-store.ts';
import { usageError } from '../lib/errors.ts';
import { writeJson } from '../lib/json-output.ts';
import { fields, heading, ok, warn } from '../ui/format.ts';

export default async function config(args: Args): Promise<void> {
  const [action, key, value] = args.positionals;
  const json = hasFlag(args, 'json');

  if (!action || action === 'list') return list(json);
  if (action === 'get') return get(key, json);
  if (action === 'set') return set(key, value, json);
  if (action === 'unset') return unset(key, json);

  throw usageError(`unknown config action: ${action}`, 'one of: list, get, set, unset');
}

function list(json: boolean): void {
  const { config: cfg, status } = loadConfigState();
  if (json) {
    writeJson({ ok: true, config: cfg, status, configPath: configPath() });
    return;
  }
  if (status === 'corrupt') {
    process.stdout.write(
      warn(`${configPath()} is not valid JSON — showing defaults`) + '\n' +
      `  it will be preserved as ${invalidConfigPath()} on the next write\n`,
    );
  }
  process.stdout.write(heading('Config') + '\n');
  process.stdout.write(
    fields([
      ['network', cfg.network],
      ['activeWallet', cfg.activeWallet ?? 'none'],
      ['endpoints', JSON.stringify(cfg.endpoints)],
      ['path', configPath()],
    ]) + '\n',
  );
}

function get(key: string | undefined, json: boolean): void {
  if (!key) throw usageError('config get needs a key', 'example: ada config get network');
  const found = readPath(loadConfig(), key);
  if (json) {
    writeJson({ ok: true, key, value: found ?? null });
    return;
  }
  process.stdout.write((found === undefined ? '' : String(found)) + '\n');
}

function set(key: string | undefined, value: string | undefined, json: boolean): void {
  if (!key || value === undefined) {
    throw usageError('config set needs a key and a value', 'example: ada config set network preprod');
  }
  const cfg = loadConfig();

  if (key === 'network') {
    cfg.network = assertNetworkName(value);
  } else if (key === 'activeWallet') {
    // Checked now rather than at the next command. Writing a wallet that does
    // not exist leaves every later invocation failing on a name the user has
    // since forgotten typing, and the config is the last place they would look.
    assertWalletExists(value);
    cfg.activeWallet = value;
  } else if (key.startsWith('endpoints.')) {
    const [, networkPart, field] = key.split('.');
    if (!networkPart || !field) {
      throw usageError(
        `malformed endpoint key: ${key}`,
        'example: ada config set endpoints.preprod.apiUrl https://host/api/v1',
      );
    }
    const network = assertNetworkName(networkPart);
    if (field !== 'apiUrl' && field !== 'adminUrl') {
      throw usageError(`unknown endpoint field: ${field}`, 'one of: apiUrl, adminUrl');
    }
    // An endpoint that is not a URL bricks the tool until it is unset, and the
    // failure arrives as `devnet_not_running` from a devnet that is running
    // perfectly well. Refusing here costs nothing and saves that hunt.
    assertEndpointUrl(value);
    cfg.endpoints[network] = { ...cfg.endpoints[network], [field]: value };
  } else {
    throw usageError(
      `unknown config key: ${key}`,
      'settable: network, activeWallet, endpoints.<network>.apiUrl, endpoints.<network>.adminUrl',
    );
  }

  saveConfig(cfg);
  if (json) {
    writeJson({ ok: true, key, value });
    return;
  }
  process.stdout.write(ok(`${key} = ${value}`) + '\n');
}

function unset(key: string | undefined, json: boolean): void {
  if (!key) throw usageError('config unset needs a key');
  const cfg = loadConfig();

  if (key === 'activeWallet') {
    delete cfg.activeWallet;
  } else if (key.startsWith('endpoints.')) {
    const [, networkPart, field] = key.split('.');
    const network = assertNetworkName(networkPart ?? '');
    if (field) {
      const entry = cfg.endpoints[network];
      if (entry) delete entry[field as 'apiUrl' | 'adminUrl'];
    } else {
      delete cfg.endpoints[network];
    }
  } else {
    throw usageError(`cannot unset: ${key}`, 'unsettable: network (set it instead)');
  }

  saveConfig(cfg);
  if (json) {
    writeJson({ ok: true, key, unset: true });
    return;
  }
  process.stdout.write(ok(`unset ${key}`) + '\n');
}

function readPath(cfg: AdaConfig, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, cfg);
}

/**
 * An endpoint has to be an absolute http(s) URL.
 *
 * `ada config set endpoints.devnet.apiUrl junk` was accepted, and every command
 * afterwards reported `devnet_not_running` — for a devnet that was running, with
 * `ada status` cheerfully showing its pid. The config is the last place anybody
 * looks for that, so the value is checked where it is written.
 */
function assertEndpointUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw usageError(`not a URL: ${value}`,
      'an endpoint is absolute, like http://localhost:8080/api/v1');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw usageError(`an endpoint must be http or https, not ${url.protocol.replace(':', '')}`,
      'for example http://localhost:8080/api/v1');
  }
}

/** The active wallet has to be one that exists. */
function assertWalletExists(name: string): void {
  const known = listWallets();
  if (known.some((w) => w.name === name)) return;
  throw usageError(`no wallet named ${name}`,
    known.length > 0
      ? `there is ${known.map((w) => w.name).join(', ')} — or create one with: ada wallet generate ${name}`
      : 'create one with: ada wallet generate <name>');
}
