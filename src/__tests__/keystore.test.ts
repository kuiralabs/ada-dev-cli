// Encryption at rest for a recovery phrase.
//
// The phrase IS the wallet, so the failures that matter here are the ones that
// lose it: a seal that will not open, a wrong passphrase that decrypts to
// something plausible, or a tampered file that goes unnoticed. Each is pinned.

import { describe, it, expect, afterEach } from 'vitest';
import { seal, open, sameSecret, passphraseFromEnv, PASSPHRASE_ENV } from '../lib/keystore.ts';
import { AdaError } from '../lib/errors.ts';

const PHRASE = 'enlist vault pumpkin own thumb pelican door ketchup banana always tonight soft '
  + 'brother carry hotel acoustic front jar talent sauce giant sword custom answer';
const PASS = 'correct horse battery staple';

afterEach(() => { delete process.env[PASSPHRASE_ENV]; });

describe('sealing a recovery phrase', () => {
  it('opens back to exactly what went in', () => {
    expect(open(seal(PHRASE, PASS), PASS)).toBe(PHRASE);
  });

  it('never stores the phrase, in whole or in part', () => {
    const sealed = seal(PHRASE, PASS);
    const asText = JSON.stringify(sealed);
    expect(asText).not.toContain('pumpkin');
    expect(asText).not.toContain(PHRASE);
    // Nor the passphrase, which would be a spectacular own goal.
    expect(asText).not.toContain(PASS);
  });

  it('is salted — the same phrase and passphrase seal differently every time', () => {
    // Without this an observer could tell two wallets hold the same phrase, and
    // a precomputed table would work against every wallet at once.
    const a = seal(PHRASE, PASS);
    const b = seal(PHRASE, PASS);
    expect(a.salt).not.toBe(b.salt);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(open(a, PASS)).toBe(open(b, PASS));
  });

  it('refuses a wrong passphrase instead of returning noise', () => {
    // The danger is not failing to decrypt; it is decrypting to something that
    // looks like a phrase and derives a wallet nobody owns. GCM's tag makes the
    // failure loud, which is why it is authenticated encryption and not a cipher.
    expect(() => open(seal(PHRASE, PASS), 'wrong')).toThrowError(AdaError);
    try { open(seal(PHRASE, PASS), 'wrong'); } catch (e) {
      expect((e as AdaError).code).toBe('passphrase_wrong');
    }
  });

  it('notices a tampered ciphertext', () => {
    const sealed = seal(PHRASE, PASS);
    const flipped = sealed.ciphertext.slice(0, -2) + (sealed.ciphertext.endsWith('00') ? '01' : '00');
    expect(() => open({ ...sealed, ciphertext: flipped }, PASS)).toThrowError(AdaError);
  });

  it('notices a swapped authentication tag', () => {
    const a = seal(PHRASE, PASS);
    const b = seal(PHRASE, PASS);
    expect(() => open({ ...a, tag: b.tag }, PASS)).toThrowError(AdaError);
  });

  it('refuses a keystore it does not understand rather than guessing', () => {
    const sealed = seal(PHRASE, PASS);
    expect(() => open({ ...sealed, cipher: 'aes-128-cbc' as never }, PASS)).toThrowError(AdaError);
  });
});

describe('where the passphrase comes from', () => {
  it('is the environment, and says so when unset', () => {
    delete process.env[PASSPHRASE_ENV];
    try {
      passphraseFromEnv();
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AdaError).code).toBe('passphrase_required');
      // The hint has to explain the choice, or the next person "helpfully" adds a flag.
      expect((err as AdaError).hint).toMatch(/shell history|ps/);
    }
  });

  it('treats an empty variable as unset', () => {
    process.env[PASSPHRASE_ENV] = '';
    expect(() => passphraseFromEnv()).toThrowError(AdaError);
  });

  it('reads it when set', () => {
    process.env[PASSPHRASE_ENV] = PASS;
    expect(passphraseFromEnv()).toBe(PASS);
  });
});

describe('comparing secrets', () => {
  it('matches equal secrets and rejects unequal ones', () => {
    expect(sameSecret(PHRASE, PHRASE)).toBe(true);
    expect(sameSecret(PHRASE, PHRASE + ' ')).toBe(false);
    expect(sameSecret('', '')).toBe(true);
  });
});
