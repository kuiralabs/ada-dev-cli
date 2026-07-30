// The offer that travels between two parties.
//
// A Cardano atomic swap needs no smart contract: one transaction is built from
// both parties' inputs and requires both signatures, so either both sides move or
// nothing does. What has to move between them is the partially-signed transaction
// plus enough context for the receiver to understand it without trusting the
// sender's description of it.
//
// **Transport is deliberately not this tool's problem.** The offer is a blob; how
// it reaches the counterparty — a file, a paste, a message — is the calling
// application's decision. The tool's responsibility ends at producing something
// safe to hand over.

import { usageError } from './errors.ts';

/** Bumped only on an incompatible change, so an old offer fails loudly rather
 *  than being misread by a newer parser. */
export const OFFER_VERSION = 1;

export interface OfferSide {
  address: string;
  /** What this side is giving up. Assets as `unit` → quantity. */
  gives: Array<{ unit: string; quantity: string }>;
}

export interface SwapOffer {
  version: number;
  network: string;
  /** The unsigned-or-partially-signed transaction, hex CBOR. */
  tx: string;
  maker: OfferSide;
  taker: OfferSide;
  /** Set once the maker has signed. A taker must never sign an unsigned offer. */
  makerSigned: boolean;
  /** Unix seconds. An offer past this must not be signed — the chain state it was
   *  built against has moved on. */
  expiresAt: number;
  createdAt: number;
}

/**
 * Encode an offer for transport.
 *
 * Base64 of JSON: opaque enough that nobody hand-edits one and expects it to
 * work, printable enough to paste into anything.
 */
export function encodeOffer(offer: SwapOffer): string {
  return Buffer.from(JSON.stringify(offer), 'utf-8').toString('base64');
}

/**
 * Decode and validate an offer.
 *
 * A received offer is **untrusted input**. Every field is checked before anything
 * downstream reads it, because the whole point of `swap inspect` is that the
 * receiver does not have to take the sender's word for what the transaction does.
 */
export function decodeOffer(encoded: string): SwapOffer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded.trim(), 'base64').toString('utf-8'));
  } catch {
    throw usageError(
      'that is not a valid offer',
      'an offer is the base64 blob produced by `ada swap build` — check it was copied whole',
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw usageError('that offer is not an object');
  }
  const offer = parsed as Partial<SwapOffer>;

  if (offer.version !== OFFER_VERSION) {
    throw usageError(
      `unsupported offer version: ${String(offer.version)}`,
      `this build understands version ${OFFER_VERSION}`,
    );
  }
  requireString(offer.tx, 'tx');
  requireString(offer.network, 'network');
  requireSide(offer.maker, 'maker');
  requireSide(offer.taker, 'taker');
  if (typeof offer.expiresAt !== 'number' || typeof offer.createdAt !== 'number') {
    throw usageError('offer is missing its timestamps');
  }

  return {
    version: offer.version,
    network: offer.network,
    tx: offer.tx,
    maker: offer.maker,
    taker: offer.taker,
    makerSigned: offer.makerSigned === true,
    expiresAt: offer.expiresAt,
    createdAt: offer.createdAt,
  };
}

export const isExpired = (offer: SwapOffer, now = Date.now()): boolean =>
  offer.expiresAt * 1000 <= now;

function requireString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value === '') {
    throw usageError(`offer is missing its ${field}`);
  }
}

function requireSide(value: unknown, field: string): asserts value is OfferSide {
  if (typeof value !== 'object' || value === null) {
    throw usageError(`offer is missing its ${field}`);
  }
  const side = value as Partial<OfferSide>;
  requireString(side.address, `${field} address`);
  if (!Array.isArray(side.gives)) {
    throw usageError(`offer's ${field} does not say what it gives`);
  }
  for (const asset of side.gives) {
    if (typeof asset?.unit !== 'string' || typeof asset?.quantity !== 'string') {
      throw usageError(`offer's ${field} has a malformed asset entry`);
    }
  }
}
