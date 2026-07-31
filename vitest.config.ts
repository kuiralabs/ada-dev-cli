import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest defaults to 5s. That is ample for the assertions here — every test
    // in this suite is offline and most run in single-digit milliseconds — but
    // not for the *imports* they trigger. MeshJS and the Plutus VM behind it take
    // roughly a second each to load, and under parallel execution several files
    // pay that at once, so a 5s ceiling produced timeouts in tests that pass in
    // 400ms when run alone. Raising it fixes flakiness without hiding slowness:
    // a genuinely hung test still fails, just later.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
