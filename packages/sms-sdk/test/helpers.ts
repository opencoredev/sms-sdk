import { describe, expect, test } from "bun:test";
import type { SmsAdapter } from "../src/core/adapters.js";
import { createSmsClient } from "../src/core/client.js";
import { HandoffUnknownError, type SmsError } from "../src/core/errors.js";
import type { FetchLike } from "../src/core/http.js";
import type { SmsSendInput } from "../src/core/types.js";
import { mockFetch, type MockResponse } from "../src/testing/fetch.js";
import { memory } from "../src/testing/memory.js";

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

/**
 * Checks that only a provider's documented rate-limit body makes a 429
 * retryable. Bare 429s (proxy or CDN pages, empty or foreign JSON) must be
 * unknown, with no second request and no fallback.
 */
export function describeRateLimitProof(input: {
  readonly provider: string;
  readonly adapter: (fetch: FetchLike) => SmsAdapter;
  readonly to: SmsSendInput["to"];
  readonly documented: MockResponse;
  readonly bare: readonly (readonly [string, MockResponse])[];
}): void {
  const retry = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 };

  describe(`${input.provider} 429 handling`, () => {
    test("a documented rate-limit body is retried, then fails over", async () => {
      const primary = mockFetch(input.documented);
      const backup = memory({ name: "backup" });
      const sms = createSmsClient({ adapters: [input.adapter(primary.fetch), backup], fallback: "on-known-rejection", retry });
      const result = await sms.send({ to: input.to, body: "hi" });
      expect(primary.calls).toHaveLength(2);
      expect(result.provider).toBe("backup");
    });

    test.each(input.bare)("a bare 429 (%s) is unknown and sent once", async (_label, response) => {
      const primary = mockFetch(response);
      const backup = memory({ name: "backup" });
      const sms = createSmsClient({ adapters: [input.adapter(primary.fetch), backup], fallback: "on-known-rejection", retry });
      const error = await rejection(sms.send({ to: input.to, body: "hi" }));
      expect(error).toBeInstanceOf(HandoffUnknownError);
      expect(error).toMatchObject({ reason: "unexpected_status", retrySafe: false, provider: { httpStatus: 429 } });
      expect(primary.calls).toHaveLength(1);
      expect(backup.sent).toHaveLength(0);
    });
  });
}
