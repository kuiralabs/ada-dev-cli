// Persistent config. Dotted paths are supported for endpoint overrides so a
// public network can be pointed somewhere without hand-editing JSON.

import type { Args } from '../lib/argv.ts';
import { hasFlag } from '../lib/argv.ts';
import { loadConfig, saveConfig, configPath, assertNetworkName, type AdaConfig } from '../lib/cli-config.ts';
import { usageError } from '../lib/errors.ts';
import { writeJson } from '../lib/json-output.ts';
import { fields, heading, ok } from '../ui/format.ts';

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
  const cfg = loadConfig();
  if (json) {
    writeJson({ ok: true, config: cfg, configPath: configPath() });
    return;
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
