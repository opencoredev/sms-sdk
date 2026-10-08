import { describe, expect, test } from "bun:test";
import { isE164, maskPhoneNumber } from "../../src/core/e164.js";

describe("isE164", () => {
  test.each([
    ["+14155550123"],
    ["+447700900123"],
    ["+12"],
    ["+123456789012345"],
    ["+8613800138000"],
  ])("accepts %s", (value) => {
    expect(isE164(value)).toBe(true);
  });

  test.each([
    ["14155550123", "missing +"],
    ["+04155550123", "leading zero country code"],
    ["+1", "too short"],
    ["+1234567890123456", "16 digits"],
    ["+1 415 555 0123", "spaces"],
    ["+1-415-555-0123", "dashes"],
    ["+1(415)5550123", "parentheses"],
    ["", "empty"],
    ["+", "plus only"],
    ["++14155550123", "double plus"],
    ["+14155550123\n", "trailing newline"],
    ["+١٤١٥٥٥٥٠١٢٣", "non-ASCII digits"],
  ])("rejects %j (%s)", (value) => {
    expect(isE164(value)).toBe(false);
  });

  test("rejects non-strings", () => {
    expect(isE164(14155550123)).toBe(false);
    expect(isE164(undefined)).toBe(false);
    expect(isE164(null)).toBe(false);
  });
});

describe("maskPhoneNumber", () => {
  test("keeps the country digit and last two digits", () => {
    expect(maskPhoneNumber("+14155550123")).toBe("+1********23");
  });

  test("fully masks very short values", () => {
    expect(maskPhoneNumber("1234")).toBe("****");
  });
});
