/**
 * An E.164 phone number such as `+14155550123`.
 *
 * The template literal type documents intent only. Values are validated at
 * runtime with {@link isE164} before any provider request is made.
 */
export type E164 = `+${string}`;

const E164_PATTERN = /^\+[1-9]\d{1,14}$/;

/**
 * Returns true when `value` is a syntactically valid E.164 number: a `+`, a
 * non-zero leading digit, and 2 to 15 digits in total. No spaces or
 * punctuation are allowed.
 *
 * This is a format check only. It cannot tell whether the number exists,
 * belongs to a mobile network, or can receive SMS.
 */
export function isE164(value: unknown): value is E164 {
  return typeof value === "string" && E164_PATTERN.test(value);
}

/**
 * Masks a phone number for logs and error messages, keeping the `+`, the
 * first digit, and the last two digits: `+14155550123` becomes `+1********23`.
 *
 * Strings that are not E.164 are masked the same way when they are long
 * enough, and fully replaced when they are short.
 */
export function maskPhoneNumber(value: string): string {
  if (value.length <= 4) {
    return "*".repeat(value.length);
  }

  const keepStart = value.startsWith("+") ? 2 : 1;
  const hidden = value.length - keepStart - 2;
  return `${value.slice(0, keepStart)}${"*".repeat(hidden)}${value.slice(-2)}`;
}
