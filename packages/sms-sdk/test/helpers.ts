import type { SmsError } from "../src/core/errors.js";

/** Runs `promise` and returns what it rejected with, failing if it resolved. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/** Like {@link rejection} but returns the error typed as an SmsError after checking it. */
export async function smsRejection(promise: Promise<unknown>): Promise<SmsError> {
  const error = await rejection(promise);
  const { SmsError: SmsErrorClass } = await import("../src/core/errors.js");
  if (!(error instanceof SmsErrorClass)) {
    throw new Error(`expected an SmsError, got ${String(error)}`);
  }
  return error;
}

export const TWILIO_SID = "AC0123456789abcdef0123456789abcdef";
export const TWILIO_MESSAGE_SID = "SM0123456789abcdef0123456789abcdef";
export const TWILIO_SERVICE_SID = "MG0123456789abcdef0123456789abcdef";
