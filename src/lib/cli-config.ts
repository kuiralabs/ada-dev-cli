// Persistent config at ~/.ada/config.json.
//
// Two rules from the output contract: every value is overridable by a flag for
// a single run (so an agent can act without mutating state a human relies on),
// and reads never throw on a missing or corrupt file — they fall back to
// defaults, because a broken config should not make `ada help` fail.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { CONFIG_DIR_NAME, CONFIG_FILE_NAME, DEVNET_DEFAULTS } from './constants.ts';
import { configError, usageError } from './errors.ts';

export type NetworkName = 'devnet' | 'preprod' | 'preview' | 'mainnet';

export const NETWORK_NAMES: readonly NetworkName[] = ['devnet', 'preprod', 'preview', 'mainnet'];

export interface AdaConfig {
  network: NetworkName;
  activeWallet?: string;
  /** Per-network endpoint overrides. Absent means "use the built-in default",
   *  which only exists for devnet — public networks require an explicit URL. */
  endpoints: Partial<Record<NetworkName, { apiUrl?: string; adminUrl?: string }>>;
}

const DEFAULT_CONFIG: AdaConfig = {
  network: 'devnet',
  endpoints: {},
};

export const configDir = () => join(homedir(), CONFIG_DIR_NAME);
export const configPath = () => join(configDir(), CONFIG_FILE_NAME);

export type ConfigStatus = 'ok' | 'missing' | 'corrupt';

export interface ConfigState {
  config: AdaConfig;
  status: ConfigStatus;
}

/**
 * Read the config, reporting whether the file was usable.
 *
 * The status matters because a corrupt file must not be silently discarded. A
 * plain `loadConfig` that swallowed the parse error meant the next `config set`
 * wrote defaults over the user's file and took every other setting with it —
 * silent data loss triggered by a stray comma.
 */
export function loadConfigState(): ConfigState {
  const path = configPath();
  if (!existsSync(path)) return { config: { ...DEFAULT_CONFIG }, status: 'missing' };
  try {
    const raw = readFileSync(path, 'utf-8');
    if (raw.trim() === '') return { config: { ...DEFAULT_CONFIG }, status: 'missing' };
    const parsed = JSON.parse(raw) as Partial<AdaConfig>;
    return {
      config: {
        network: parsed.network ?? DEFAULT_CONFIG.network,
        activeWallet: parsed.activeWallet,
        endpoints: parsed.endpoints ?? {},
      },
      status: 'ok',
    };
  } catch {
    // Defaults are still returned so a bad file cannot break `ada help`, but the
    // status lets writers preserve the original instead of clobbering it.
    return { config: { ...DEFAULT_CONFIG }, status: 'corrupt' };
  }
}

export function loadConfig(): AdaConfig {
  return loadConfigState().config;
}

export function saveConfig(config: AdaConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = configPath();

  // Never overwrite something unparseable. It may hold settings the user wants
  // back, and a diagnosable file beside the new one is strictly better than a
  // silent loss.
  if (loadConfigState().status === 'corrupt') {
    try {
      renameSync(path, `${path}.invalid`);
    } catch {
      // If it cannot be preserved, the write below still proceeds — refusing to
      // save would leave the tool permanently unusable.
    }
  }

  // Write-then-rename: an interrupted write must not leave a truncated file. A
  // zero-byte config has bricked things before; atomicity is cheap here.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
}

/** Where a preserved unparseable config is moved to. */
export const invalidConfigPath = (): string => `${configPath()}.invalid`;

export function assertNetworkName(value: string): NetworkName {
  if ((NETWORK_NAMES as readonly string[]).includes(value)) return value as NetworkName;
  throw usageError(
    `unknown network: ${value}`,
    `known networks: ${NETWORK_NAMES.join(', ')}`,
  );
}

export interface ResolvedNetwork {
  name: NetworkName;
  apiUrl: string;
  adminUrl?: string;
  isLocal: boolean;
}

/**
 * Resolve the network for this run: an explicit flag wins over config, config
 * wins over the built-in default.
 *
 * Only devnet has a usable built-in endpoint. Public networks fail loudly with
 * the exact command to fix it rather than silently pointing somewhere wrong —
 * a transaction built against the wrong network is worse than an error.
 */
export function resolveNetwork(config: AdaConfig, override?: string): ResolvedNetwork {
  const name = override ? assertNetworkName(override) : config.network;
  const configured = config.endpoints[name] ?? {};

  if (name === 'devnet') {
    return {
      name,
      apiUrl: stripTrailingSlash(configured.apiUrl ?? DEVNET_DEFAULTS.apiUrl),
      adminUrl: stripTrailingSlash(configured.adminUrl ?? DEVNET_DEFAULTS.adminUrl),
      isLocal: true,
    };
  }

  if (!configured.apiUrl) {
    throw configError(
      `no API endpoint configured for ${name}`,
      `set one with: ada config set endpoints.${name}.apiUrl <url>`,
    );
  }

  return {
    name,
    apiUrl: stripTrailingSlash(configured.apiUrl),
    adminUrl: configured.adminUrl ? stripTrailingSlash(configured.adminUrl) : undefined,
    isLocal: false,
  };
}

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, '');
