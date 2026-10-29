// The segment calculator's model (pages/tools/sms-segment-calculator.astro).
// The totals come straight from the SDK's estimateSegments(). The per-segment
// split is drawn with the same rules the SDK packs by: GSM-7 extension
// characters cost 2 septets, UCS-2 counts UTF-16 code units, and no character
// is split across a segment boundary. segments.test.ts checks that the split
// always agrees with estimateSegments().
//
// apps/docs has no dependency on the published package, so this imports the
// SDK source by path, the same way check-snippets.ts resolves it.
import {
  estimateSegments,
  GSM7_BASIC_CHARACTERS,
  GSM7_EXTENSION_CHARACTERS,
  SEGMENT_LIMITS,
  type SegmentPreview,
} from "../../../../packages/sms-sdk/src/core/encoding.ts";

const BASIC = new Set(GSM7_BASIC_CHARACTERS);
const EXTENSION = new Set(GSM7_EXTENSION_CHARACTERS);

/**
 * What one character costs: a plain unit, a 2-septet GSM-7 extension character,
 * or a character that forces UCS-2. In a UCS-2 message, extension characters
 * are plain: they cost one code unit like any other.
 */
export type CharacterKind = "basic" | "extension" | "unicode";

export type CountedCharacter = {
  readonly text: string;
  readonly kind: CharacterKind;
  /** Septets for GSM-7, UTF-16 code units for UCS-2. */
  readonly units: number;
};

export type Segment = {
  readonly characters: readonly CountedCharacter[];
  readonly units: number;
};

export type SegmentBreakdown = {
  readonly preview: SegmentPreview;
  /** Unicode code points, not UTF-16 code units. A joined emoji such as a family counts several. */
  readonly characterCount: number;
  readonly segments: readonly Segment[];
};

function kindOf(character: string, encoding: SegmentPreview["encoding"]): CharacterKind {
  if (BASIC.has(character)) return "basic";
  if (EXTENSION.has(character)) return encoding === "gsm7" ? "extension" : "basic";
  return "unicode";
}

/** Splits `body` into the segments a handset would receive, with the SDK's totals. */
export function breakDown(body: string): SegmentBreakdown {
  const preview = estimateSegments(body);
  const characters = Array.from(body, (text): CountedCharacter => {
    const kind = kindOf(text, preview.encoding);
    const units = preview.encoding === "ucs2" ? text.length : kind === "extension" ? 2 : 1;
    return { text, kind, units };
  });

  const limits = SEGMENT_LIMITS[preview.encoding];
  const capacity = preview.units <= limits.single ? limits.single : limits.concatenated;
  const segments: Segment[] = [];
  let current: CountedCharacter[] = [];
  let used = 0;
  for (const character of characters) {
    if (used + character.units > capacity) {
      segments.push({ characters: current, units: used });
      current = [];
      used = 0;
    }
    current.push(character);
    used += character.units;
  }
  if (current.length > 0) segments.push({ characters: current, units: used });

  return { preview, characterCount: characters.length, segments };
}
