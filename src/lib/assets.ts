// Native assets, in both directions.
//
// A unit is `policyId ++ assetNameHex` with nothing between them — 56 hex
// characters of policy followed by up to 64 of name. Building one was already
// done in two places; taking one apart was done nowhere, so a wallet that had
// just minted `RANDCOIN` reported it as:
//
//   1000  2b0f0c0a61f4525664aa2478e78358d67d783c58607e67540c521fe552414e44434f494e
//
// The name is the tail of that string. The tool put it there and then could not
// read it back, in human output or in JSON — so every caller, human or agent,
// had to know the 56-character split and decode the hex themselves.

/** A policy id is blake2b-224 of the script: 28 bytes, 56 hex characters. */
export const POLICY_ID_HEX_LENGTH = 56;

/** The ledger's own cap on an asset name. */
export const MAX_ASSET_NAME_BYTES = 32;

export interface AssetUnit {
  /** The whole `policyId ++ assetNameHex` string, as the ledger stores it. */
  unit: string;
  policyId: string;
  assetNameHex: string;
  /**
   * The name as text, when the bytes are unambiguously text. Absent otherwise —
   * see `decodeAssetName` for what "unambiguously" has to mean here.
   */
  assetName?: string;
}

/**
 * Asset-name bytes as text, or nothing.
 *
 * Most names are ASCII someone typed, and showing those as hex is the defect
 * this fixes. But an asset name is arbitrary bytes: CIP-68 prefixes a four-byte
 * label like `(222)`, and plenty of tokens carry a hash or a counter. Rendering
 * those through a UTF-8 decoder produces replacement characters and control
 * codes — a name that looks like text but is not the name, which is worse than
 * hex because it invites copying.
 *
 * So the bar is deliberately high: decode only if the result is printable ASCII
 * and re-encodes to exactly the bytes we started from. Anything else keeps its
 * hex, and the caller still has `assetNameHex` either way.
 */
export function decodeAssetName(assetNameHex: string): string | undefined {
  if (assetNameHex === '') return undefined;
  if (assetNameHex.length % 2 !== 0) return undefined;
  if (!/^[0-9a-fA-F]+$/.test(assetNameHex)) return undefined;

  const bytes = Buffer.from(assetNameHex, 'hex');
  const text = bytes.toString('utf8');

  // Printable ASCII only: space through tilde. Excludes the control codes and
  // the replacement character a failed decode leaves behind.
  if (!/^[\x20-\x7e]+$/.test(text)) return undefined;

  // Round-trip, so a byte sequence that merely survives decoding is not mistaken
  // for one that means what it now looks like.
  if (Buffer.from(text, 'utf8').toString('hex') !== assetNameHex.toLowerCase()) return undefined;

  return text;
}

/** Split a unit into its parts, decoding the name where that is honest. */
export function splitUnit(unit: string): AssetUnit {
  // `lovelace` is not a native asset and has no policy, but it arrives through
  // the same value maps, so it is handled rather than mangled into a 56/rest
  // split that would produce nonsense.
  if (unit === 'lovelace') {
    return { unit, policyId: '', assetNameHex: '', assetName: 'lovelace' };
  }

  const policyId = unit.slice(0, POLICY_ID_HEX_LENGTH);
  const assetNameHex = unit.slice(POLICY_ID_HEX_LENGTH);
  return { unit, policyId, assetNameHex, assetName: decodeAssetName(assetNameHex) };
}

/** Build a unit from its parts. The one place that concatenation happens. */
export const buildUnit = (policyId: string, assetNameHex: string): string => policyId + assetNameHex;

/** An asset name as the ledger wants it: hex of the UTF-8 bytes. */
export const assetNameToHex = (name: string): string => Buffer.from(name, 'utf8').toString('hex');

/**
 * How to show an asset in one line of human output.
 *
 * The name leads because it is what was asked for, and the policy follows
 * shortened, because it is what distinguishes two tokens that share a name —
 * a collision that is not exotic on a chain where anyone may mint `USDC`.
 * A name we could not decode falls back to the full unit rather than guessing.
 */
export function formatAsset(unit: string): string {
  const parts = splitUnit(unit);
  if (!parts.assetName) return unit;
  if (!parts.policyId) return parts.assetName;
  return `${parts.assetName}  ${parts.policyId.slice(0, 8)}…`;
}

/** Lovelace is not a native asset; it is summed separately by the caller. */
const LOVELACE_UNIT = 'lovelace';

/**
 * One row per asset, summed, with the name decoded.
 *
 * Summed because the two ways this balance is obtained do not agree otherwise:
 * the wallet's own `getBalance` returns one entry per asset, while the
 * address path flattens every UTxO — so an asset spread across three UTxOs was
 * listed three times, each with a partial quantity and no total anywhere. Which
 * of the two you got depended on whether you passed `--wallet`.
 */
export function summariseAssets(
  assets: Array<{ unit: string; quantity: string }>,
): Array<{ unit: string; policyId: string; assetName?: string; quantity: string }> {
  const totals = new Map<string, bigint>();
  for (const a of assets) {
    if (a.unit === LOVELACE_UNIT || a.unit === '') continue;
    totals.set(a.unit, (totals.get(a.unit) ?? 0n) + BigInt(a.quantity));
  }

  return [...totals.entries()]
    .map(([unit, quantity]) => {
      const { policyId, assetName } = splitUnit(unit);
      return { unit, policyId, ...(assetName ? { assetName } : {}), quantity: quantity.toString() };
    })
    .sort((a, b) => a.unit.localeCompare(b.unit)); // deterministic ordering
}
