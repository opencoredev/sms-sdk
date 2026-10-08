import { maskPhoneNumber } from "./e164.js";

const PHONE_LIKE = /\+?\d[\d\s().-]{5,}\d/g;
const MAX_MESSAGE_LENGTH = 200;

/**
 * Makes provider-supplied text safe to log: masks digit runs that look like
 * phone numbers, removes control characters, and truncates to 200 characters.
 */
export function redactText(text: string): string {
  const masked = text.replace(PHONE_LIKE, (match) => maskPhoneNumber(match.replace(/[^\d+]/g, "")));
  const clean = masked.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return clean.length > MAX_MESSAGE_LENGTH ? `${clean.slice(0, MAX_MESSAGE_LENGTH - 1)}…` : clean;
}
