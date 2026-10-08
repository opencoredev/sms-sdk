import type { SmsEncoding } from "./adapters.js";

export type { SmsEncoding } from "./adapters.js";

/** Characters of the GSM 03.38 default alphabet. Each costs one septet. */
export const GSM7_BASIC_CHARACTERS: string =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";

/** Characters of the GSM 03.38 extension table. Each costs two septets (escape + character). */
export const GSM7_EXTENSION_CHARACTERS: string = "\f^{}\\[~]|€";

const BASIC = new Set(GSM7_BASIC_CHARACTERS);
const EXTENSION = new Set(GSM7_EXTENSION_CHARACTERS);

/** Single-message and per-segment capacity for each encoding. */
export const SEGMENT_LIMITS: {
  readonly gsm7: { readonly single: 160; readonly concatenated: 153 };
  readonly ucs2: { readonly single: 70; readonly concatenated: 67 };
} = {
  gsm7: { single: 160, concatenated: 153 },
  ucs2: { single: 70, concatenated: 67 },
};

/**
 * Estimated encoding and segment count for a message body.
 *
 * Counts are estimates of billable units. Carriers, senders (for example some
 * toll-free routes), and provider-side smart encoding can change the real
 * count. Nothing here is a price quote.
 */
export type SegmentPreview = {
  readonly encoding: SmsEncoding;
  /** Estimated number of segments. `0` for an empty body. */
  readonly segments: number;
  /** Septets for GSM-7, UTF-16 code units for UCS-2. */
  readonly units: number;
  /** Capacity of each segment at this length: 160/153 for GSM-7, 70/67 for UCS-2. */
  readonly unitsPerSegment: number;
  /** Units left in the last segment before another segment is needed. */
  readonly remainingInSegment: number;
  /** True when at least one character is outside GSM-7, forcing UCS-2. */
  readonly containsUnicode: boolean;
  /** Distinct characters that forced UCS-2, in order of first appearance. Empty for GSM-7. */
  readonly nonGsmCharacters: readonly string[];
};

/** Returns true when every character is in the GSM-7 basic or extension table. */
export function isGsm7(text: string): boolean {
  for (const character of text) {
    if (!BASIC.has(character) && !EXTENSION.has(character)) {
      return false;
    }
  }
  return true;
}

/**
 * Estimates encoding and segments for `body`.
 *
 * GSM-7 is used when every character fits the GSM-7 tables; extension
 * characters cost two septets and are never split across segments. Otherwise
 * UCS-2 is used, counting UTF-16 code units, and surrogate pairs (most emoji)
 * are never split across segments.
 */
export function estimateSegments(body: string): SegmentPreview {
  const characters = Array.from(body);
  const nonGsm = uniqueNonGsm(characters);
  const encoding: SmsEncoding = nonGsm.length === 0 ? "gsm7" : "ucs2";
  const costs = characters.map((character) => characterCost(character, encoding));
  const units = costs.reduce((total, cost) => total + cost, 0);
  const limits = SEGMENT_LIMITS[encoding];

  if (units === 0) {
    return preview({ encoding, segments: 0, units, unitsPerSegment: limits.single, remaining: limits.single, nonGsm });
  }

  if (units <= limits.single) {
    return preview({
      encoding,
      segments: 1,
      units,
      unitsPerSegment: limits.single,
      remaining: limits.single - units,
      nonGsm,
    });
  }

  const { segments, lastSegmentUnits } = packSegments(costs, limits.concatenated);
  return preview({
    encoding,
    segments,
    units,
    unitsPerSegment: limits.concatenated,
    remaining: limits.concatenated - lastSegmentUnits,
    nonGsm,
  });
}

function characterCost(character: string, encoding: SmsEncoding): number {
  if (encoding === "ucs2") {
    return character.length;
  }
  return EXTENSION.has(character) ? 2 : 1;
}

function uniqueNonGsm(characters: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const character of characters) {
    if (!BASIC.has(character) && !EXTENSION.has(character)) {
      seen.add(character);
    }
  }
  return [...seen];
}

/** Greedily packs indivisible character costs into fixed-capacity segments. */
function packSegments(costs: readonly number[], capacity: number): { segments: number; lastSegmentUnits: number } {
  let segments = 1;
  let used = 0;
  for (const cost of costs) {
    if (used + cost > capacity) {
      segments += 1;
      used = 0;
    }
    used += cost;
  }
  return { segments, lastSegmentUnits: used };
}

function preview(input: {
  encoding: SmsEncoding;
  segments: number;
  units: number;
  unitsPerSegment: number;
  remaining: number;
  nonGsm: readonly string[];
}): SegmentPreview {
  return {
    encoding: input.encoding,
    segments: input.segments,
    units: input.units,
    unitsPerSegment: input.unitsPerSegment,
    remainingInSegment: input.remaining,
    containsUnicode: input.encoding === "ucs2",
    nonGsmCharacters: input.nonGsm,
  };
}
