// Every endpoint path in the tool is composed from a prefix declared here.
// Nothing constructs a URL from an inline literal — a magic endpoint scattered
// across command files is how two callers end up disagreeing about a version.

/** Blockfrost-compatible API prefix, served by Yaci Store on the devnet and by
 *  hosted providers on public networks. */
export const API_V1 = '/api/v1';

/** Yaci DevKit's own admin surface, used for devnet-only operations such as the
 *  faucet. Not part of the Blockfrost-compatible API. */
export const LOCAL_CLUSTER_API = '/local-cluster/api';

export const ENDPOINTS = {
  latestBlock: `${API_V1}/blocks/latest`,
  genesis: `${API_V1}/genesis`,
  addressUtxos: (addr: string) => `${API_V1}/addresses/${addr}/utxos`,
  address: (addr: string) => `${API_V1}/addresses/${addr}`,
  txSubmit: `${API_V1}/tx/submit`,
  epochParameters: `${API_V1}/epochs/latest/parameters`,
} as const;

export const DEVKIT_ENDPOINTS = {
  topup: `${LOCAL_CLUSTER_API}/addresses/topup`,
  clusterInfo: `${LOCAL_CLUSTER_API}/admin/devnet`,
  reset: `${LOCAL_CLUSTER_API}/admin/devnet/reset`,
} as const;

/** Default devnet ports as shipped by Yaci DevKit. Overridable via config so a
 *  second devnet on one machine does not require editing the tool. */
export const DEVNET_DEFAULTS = {
  apiUrl: 'http://localhost:8080',
  adminUrl: 'http://localhost:10000',
  ogmiosUrl: 'ws://localhost:1337',
} as const;

export const CONFIG_DIR_NAME = '.ada';
export const CONFIG_FILE_NAME = 'config.json';

/** How long a single HTTP call to a local service may take before we call it
 *  unreachable. Local services answer in milliseconds; a long wait means the
 *  devnet is starting or gone, and either way the user wants to know now. */
export const LOCAL_HTTP_TIMEOUT_MS = 5_000;

/**
 * How stale the chain tip may be before the chain is considered stalled.
 *
 * A devnet makes a block a second, so half a minute of silence means the producer
 * has stopped — a state where every query still answers and nothing advances.
 * Public networks are probabilistic and a several-minute gap is ordinary, so the
 * threshold there is deliberately loose: a false "stalled" is worse than a slow
 * one, because it sends people debugging a healthy chain.
 */
export const STALL_AFTER_MS = { local: 30_000, public: 600_000 } as const;

/** Upper bound on waiting for a freshly started devnet to answer. */
export const DEVNET_READY_TIMEOUT_MS = 180_000;
export const DEVNET_READY_POLL_MS = 1_000;
