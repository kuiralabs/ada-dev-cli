// Encryption at rest for a recovery phrase.
//
// The wallet store's header explains why keys were plaintext to begin with:
// encryption means a passphrase, a passphrase means a prompt, and no path an
// agent needs may block on a prompt. That reasoning holds — so the passphrase
// arrives by **environment variable**, never a prompt and never an argument.
// A command line appears in shell history and in `ps` output for every process
// on the machine, which is a worse place for a passphrase than the file it is
// protecting.
//
// scrypt for the key derivation and AES-256-GCM for the sealing, both from
// node:crypto — no dependency, and GCM authenticates the ciphertext so a
// corrupted or tampered file fails loudly instead of decrypting to noise that
// then derives some other wallet entirely.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { AdaError, configError } from './errors.ts';
import { EXIT_INVALID_ARGS } from './exit-codes.ts';

/** Where the passphrase comes from. Never an argument. */
export const PASSPHRASE_ENV = 'ADA_WALLET_PASSPHRASE';

/**
 * scrypt cost. N=2^17 takes appreciable time on a laptop by design: the whole
 * point is to make a guess expensive, and this is unlocked once per command
 * rather than in a loop.
 */
const SCRYPT_N = 131_072;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12; // 96 bits, what GCM is specified for

/** A sealed phrase, as stored. Self-describing so the parameters can change. */
export interface SealedSecret {
  kdf: 'scrypt';
  n: number;
  r: number;
  p: number;
  cipher: 'aes-256-gcm';
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

const derive = (passphrase: string, salt: Buffer, params: { n: number; r: number; p: number }): Buffer =>
  scryptSync(passphrase.normalize('NFKD'), salt, KEY_BYTES, {
    N: params.n, r: params.r, p: params.p,
    // scrypt's default maxmem is too small for N this large; it is a guard
    // against accidental cost, not a security parameter.
    maxmem: 256 * params.n * params.r,
  });

/** The passphrase from the environment, or a refusal that names the variable. */
export function passphraseFromEnv(): string {
  const value = process.env[PASSPHRASE_ENV];
  if (value === undefined || value === '') {
    throw new AdaError(
      'passphrase_required',
      `this wallet is encrypted and ${PASSPHRASE_ENV} is not set`,
      EXIT_INVALID_ARGS,
      `export ${PASSPHRASE_ENV} in the shell that runs this command — it is read from the `
      + 'environment rather than an argument, because command lines land in shell history and in `ps`',
    );
  }
  return value;
}

export function seal(plaintext: string, passphrase: string): SealedSecret {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = derive(passphrase, salt, { n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    kdf: 'scrypt', n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P,
    cipher: 'aes-256-gcm',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

/**
 * Open a sealed phrase.
 *
 * A wrong passphrase and a tampered file are the same event here — GCM's tag
 * fails either way — and that is reported as a wrong passphrase, because it
 * almost always is and the alternative reads as an accusation.
 */
export function open(sealed: SealedSecret, passphrase: string): string {
  if (sealed.kdf !== 'scrypt' || sealed.cipher !== 'aes-256-gcm') {
    throw configError(
      `unsupported keystore: kdf=${sealed.kdf}, cipher=${sealed.cipher}`,
      'this wallet was written by a newer version of the tool',
    );
  }
  const key = derive(passphrase, Buffer.from(sealed.salt, 'hex'), sealed);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(sealed.ciphertext, 'hex')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new AdaError(
      'passphrase_wrong',
      'could not decrypt the wallet',
      EXIT_INVALID_ARGS,
      `the passphrase in ${PASSPHRASE_ENV} does not open this wallet (or the file has been altered)`,
    );
  }
}

/** Constant-time equality, for confirming a passphrase against itself. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}
