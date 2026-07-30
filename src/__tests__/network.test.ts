import { describe, it, expect } from 'vitest';
import { resolveNetwork, assertNetworkName, type AdaConfig } from '../lib/cli-config.ts';
import { ENDPOINTS, DEVKIT_ENDPOINTS, API_V1, LOCAL_CLUSTER_API } from '../lib/constants.ts';
import { AdaError } from '../lib/errors.ts';

const base = (over: Partial<AdaConfig> = {}): AdaConfig => ({
  network: 'devnet',
  endpoints: {},
  ...over,
});

describe('resolveNetwork', () => {
  it('gives devnet a working default without any config', () => {
    const net = resolveNetwork(base());
    expect(net.name).toBe('devnet');
    expect(net.isLocal).toBe(true);
    expect(net.apiUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(net.adminUrl).toBeDefined();
  });

  it('gives a public network a working default, so nothing needs configuring', () => {
    // Earlier this threw, demanding an endpoint. Requiring a signup before someone
    // can read a testnet balance is bad enough that a free community API became the
    // default instead.
    for (const name of ['preprod', 'preview'] as const) {
      const net = resolveNetwork(base({ network: name }));
      expect(net.name).toBe(name);
      expect(net.isLocal).toBe(false);
      // A sentinel, not a URL: the provider is built from a network name, and
      // inventing a URL here would be a lie that only surfaced later.
      expect(net.apiUrl).toBe(`koios:${name}`);
    }
  });

  it('lets an explicit endpoint override the default', () => {
    const net = resolveNetwork(
      base({ network: 'preprod', endpoints: { preprod: { apiUrl: 'https://my-host/api/v1' } } }),
    );
    expect(net.apiUrl).toBe('https://my-host/api/v1');
  });

  it('lets a flag override the configured network for one run', () => {
    const net = resolveNetwork(base({ network: 'mainnet' }), 'devnet');
    expect(net.name).toBe('devnet');
  });

  it('strips a trailing slash so endpoint composition cannot double up', () => {
    const net = resolveNetwork(
      base({ network: 'preprod', endpoints: { preprod: { apiUrl: 'https://host/api/v1/' } } }),
      'preprod',
    );
    expect(net.apiUrl).toBe('https://host/api/v1');
  });

  it('rejects an unknown network name', () => {
    expect(() => assertNetworkName('nonesuch')).toThrowError(AdaError);
  });
});

describe('endpoint composition', () => {
  // Guards the no-magic-endpoints rule: every path must derive from a declared
  // prefix, so a stray inline literal in a command file shows up here.
  it('builds every Blockfrost-shaped path from the versioned prefix', () => {
    const paths = [
      ENDPOINTS.latestBlock,
      ENDPOINTS.genesis,
      ENDPOINTS.txSubmit,
      ENDPOINTS.epochParameters,
      ENDPOINTS.address('addr_test1abc'),
      ENDPOINTS.addressUtxos('addr_test1abc'),
    ];
    for (const path of paths) expect(path.startsWith(API_V1)).toBe(true);
  });

  it('builds every devkit-only path from the local-cluster prefix', () => {
    for (const path of Object.values(DEVKIT_ENDPOINTS)) {
      expect(path.startsWith(LOCAL_CLUSTER_API)).toBe(true);
    }
  });

  it('keeps the two prefixes distinct — the devkit admin API is not Blockfrost', () => {
    expect(LOCAL_CLUSTER_API.startsWith(API_V1)).toBe(false);
  });
});
