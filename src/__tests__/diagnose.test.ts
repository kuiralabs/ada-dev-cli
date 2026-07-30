// The two startup failures that actually occurred, pinned as log samples.
//
// Both were diagnosable from the last few log lines while the error message
// guessed wrongly at "the devkit may be downloading node binaries". These tests
// hold the mapping from real log output to the right advice.

import { describe, it, expect } from 'vitest';
import { diagnoseFailure } from '../lib/yaci.ts';

const BIND_CONFLICT = [
  'Caused by: org.springframework.boot.web.server.WebServerException: Unable to start embedded Tomcat',
  'Caused by: org.apache.catalina.LifecycleException: Protocol handler initialization failed',
  'Caused by: java.net.BindException: Address already in use',
  'yaci-cli process exited with code: 1',
];

const MISSING_NODE = [
  'cardno-node binary is not found in /Users/x/.yaci-cli/cardano-node/bin',
  "Use 'download -c node' command to download cardano-node",
];

const MISSING_STORE = [
  'Waiting for next block...',
  'yaci-store binary is not found at /Users/x/.yaci-cli/components/store',
];

describe('diagnoseFailure', () => {
  it('names a port conflict, which is what a stale devkit process causes', () => {
    expect(diagnoseFailure(BIND_CONFLICT)).toMatch(/port .*in use/i);
  });

  it('points at bootstrap when the node binaries are missing', () => {
    expect(diagnoseFailure(MISSING_NODE)).toMatch(/localnet bootstrap/);
  });

  it('distinguishes a missing indexer from missing node binaries', () => {
    const store = diagnoseFailure(MISSING_STORE);
    expect(store).toMatch(/indexer/i);
    expect(store).not.toMatch(/cardano-node binaries/);
  });

  it('offers nothing rather than a wrong guess for an unrecognised failure', () => {
    expect(diagnoseFailure(['something entirely new went wrong'])).toBeUndefined();
  });
});
