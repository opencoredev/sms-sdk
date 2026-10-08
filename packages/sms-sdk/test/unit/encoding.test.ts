import { describe, expect, test } from "bun:test";
import {
  estimateSegments,
  GSM7_BASIC_CHARACTERS,
  GSM7_EXTENSION_CHARACTERS,
  isGsm7,
  SEGMENT_LIMITS,
} from "../../src/core/encoding.js";

describe("GSM-7 detection", () => {
  test("the basic and extension tables are GSM-7", () => {
    expect(isGsm7(GSM7_BASIC_CHARACTERS)).toBe(true);
    expect(isGsm7(GSM7_EXTENSION_CHARACTERS)).toBe(true);
    // 128 code points minus the escape (0x1B), which is not a character.
    expect(GSM7_BASIC_CHARACTERS.length).toBe(127);
    expect(GSM7_EXTENSION_CHARACTERS.length).toBe(10);
  });

  test.each([["ж"], ["📦"], ["ç"], ["`"], ["’"], ["你"]])("%s is not GSM-7", (character) => {
    expect(isGsm7(`hello ${character}`)).toBe(false);
  });
});

describe("GSM-7 segments", () => {
  test("empty body has zero segments", () => {
    const preview = estimateSegments("");
    expect(preview).toMatchObject({ encoding: "gsm7", segments: 0, units: 0, containsUnicode: false });
  });

  test.each([
    [1, 1],
    [160, 1],
    [161, 2],
    [306, 2],
    [307, 3],
    [459, 3],
    [460, 4],
  ])("%i basic characters use %i segment(s)", (length, segments) => {
    const preview = estimateSegments("a".repeat(length));
    expect(preview.encoding).toBe("gsm7");
    expect(preview.units).toBe(length);
    expect(preview.segments).toBe(segments);
    expect(preview.unitsPerSegment).toBe(length <= 160 ? 160 : 153);
  });

  test("extension characters cost two septets", () => {
    expect(estimateSegments("€").units).toBe(2);
    expect(estimateSegments("{[]}").units).toBe(8);
    expect(estimateSegments("€".repeat(80))).toMatchObject({ units: 160, segments: 1 });
    expect(estimateSegments("€".repeat(81))).toMatchObject({ units: 162, segments: 2 });
  });

  test("an extension character never straddles a segment boundary", () => {
    // 306 septets would fit in 2x153, but the escape pair cannot split at septet 153.
    const body = `${"a".repeat(152)}€${"a".repeat(152)}`;
    const preview = estimateSegments(body);
    expect(preview.units).toBe(306);
    expect(preview.segments).toBe(3);
  });

  test("an extension character that fits exactly does not add a segment", () => {
    const preview = estimateSegments(`${"a".repeat(151)}€${"a".repeat(153)}`);
    expect(preview.units).toBe(306);
    expect(preview.segments).toBe(2);
    expect(preview.remainingInSegment).toBe(0);
  });

  test("reports remaining capacity in the last segment", () => {
    expect(estimateSegments("a".repeat(100)).remainingInSegment).toBe(60);
    expect(estimateSegments("a".repeat(200)).remainingInSegment).toBe(153 - 47);
  });
});

describe("UCS-2 segments", () => {
  test.each([
    [70, 1],
    [71, 2],
    [134, 2],
    [135, 3],
    [201, 3],
    [202, 4],
  ])("%i non-GSM characters use %i segment(s)", (length, segments) => {
    const preview = estimateSegments("ж".repeat(length));
    expect(preview.encoding).toBe("ucs2");
    expect(preview.units).toBe(length);
    expect(preview.segments).toBe(segments);
    expect(preview.unitsPerSegment).toBe(length <= 70 ? 70 : 67);
  });

  test("one emoji switches encoding but not necessarily segment count", () => {
    const preview = estimateSegments("Your package is ready 📦");
    expect(preview.encoding).toBe("ucs2");
    expect(preview.segments).toBe(1);
    expect(preview.units).toBe(24);
    expect(preview.containsUnicode).toBe(true);
    expect(preview.nonGsmCharacters).toEqual(["📦"]);
  });

  test("emoji count as two UTF-16 code units", () => {
    expect(estimateSegments(`${"a".repeat(68)}📦`)).toMatchObject({ units: 70, segments: 1 });
    expect(estimateSegments(`${"a".repeat(69)}📦`)).toMatchObject({ units: 71, segments: 2 });
  });

  test("a surrogate pair is never split across segments", () => {
    const body = `${"a".repeat(66)}📦${"a".repeat(66)}`;
    const preview = estimateSegments(body);
    expect(preview.units).toBe(134);
    expect(preview.segments).toBe(3);
  });

  test("GSM extension characters cost one unit in UCS-2", () => {
    expect(estimateSegments("€ж").units).toBe(2);
  });

  test("lists each forcing character once, in order", () => {
    expect(estimateSegments("жaжb📦ж").nonGsmCharacters).toEqual(["ж", "📦"]);
  });

  test("does not transliterate", () => {
    expect(estimateSegments("“smart quotes”").encoding).toBe("ucs2");
  });
});

test("segment limits are the documented values", () => {
  expect(SEGMENT_LIMITS).toEqual({ gsm7: { single: 160, concatenated: 153 }, ucs2: { single: 70, concatenated: 67 } });
});
