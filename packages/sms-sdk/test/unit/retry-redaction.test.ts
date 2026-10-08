import { describe, expect, test } from "bun:test";
import { createSmsClient } from "../../src/core/client.js";
import {
  AllProvidersRejectedError,
  HandoffUnknownError,
  ProviderRejectedError,
  SmsError,
} from "../../src/core/errors.js";
import { parseRetryAfter, providerInfo } from "../../src/core/http.js";
import { redactText } from "../../src/core/redact.js";
import { decideRetry, resolveRetryOptions } from "../../src/core/retry.js";
import { twilio } from "../../src/providers/twilio.js";
import { telnyx } from "../../src/providers/telnyx.js";
import { mockFetch } from "../../src/testing/fetch.js";
import { rejection, TWILIO_SID } from "../helpers.js";

describe("decideRetry", () => {
  const options = resolveRetryOptions({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 });

  test("stops at maxAttempts", () => {
    expect(decideRetry({ attempt: 3, retryAfterMs: undefined, options })).toEqual({ kind: "stop" });
  });

  test("uses full jitter capped by exponential backoff", () => {
    expect(decideRetry({ attempt: 1, retryAfterMs: undefined, options, random: () => 0.999 })).toEqual({ kind: "wait", delayMs: 99 });
    expect(decideRetry({ attempt: 2, retryAfterMs: undefined, options, random: () => 0.5 })).toEqual({ kind: "wait", delayMs: 100 });
    expect(decideRetry({ attempt: 1, retryAfterMs: undefined, options, random: () => 0 })).toEqual({ kind: "wait", delayMs: 0 });
  });

  test("caps backoff at maxDelayMs", () => {
    const wide = resolveRetryOptions({ maxAttempts: 20, baseDelayMs: 100, maxDelayMs: 1_000 });
    expect(decideRetry({ attempt: 10, retryAfterMs: undefined, options: wide, random: () => 0.999 })).toEqual({ kind: "wait", delayMs: 999 });
  });

  test("honors Retry-After only within maxDelayMs", () => {
    expect(decideRetry({ attempt: 1, retryAfterMs: 500, options })).toEqual({ kind: "wait", delayMs: 500 });
    expect(decideRetry({ attempt: 1, retryAfterMs: 5_000, options })).toEqual({ kind: "stop" });
  });

  test("resolveRetryOptions applies defaults and clamps", () => {
    expect(resolveRetryOptions(undefined)).toEqual({ maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 10_000 });
    expect(resolveRetryOptions({ maxAttempts: 0 }).maxAttempts).toBe(1);
  });
});

describe("parseRetryAfter", () => {
  test("parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("3")).toBe(3_000);
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:05 GMT", Date.parse("Wed, 21 Oct 2015 07:28:00 GMT"))).toBe(5_000);
  });

  test("ignores missing or invalid values", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("soon")).toBeUndefined();
  });
});

describe("redaction", () => {
  test("masks phone numbers in provider text and truncates", () => {
    expect(redactText("The 'To' number +14155550123 is not a valid phone number.")).toBe(
      "The 'To' number +1********23 is not a valid phone number.",
    );
    expect(redactText("call 415 555 0123 now")).toBe("call 4*******23 now");
    expect(redactText("x".repeat(500))).toHaveLength(200);
    expect(redactText("error 21211")).toBe("error 21211");
  });

  test("providerInfo redacts the message", () => {
    expect(providerInfo({ provider: "twilio", message: "bad +447700900123" }).message).toBe("bad +4*********23");
  });

  const SECRET = "auth-token-SECRET-value";
  const BODY = "Your one-time code is 918273";

  async function thrownBy(status: number, responseBody: object, provider: "twilio" | "telnyx"): Promise<SmsError> {
    const mock = mockFetch({ status, body: responseBody });
    const adapter =
      provider === "twilio"
        ? twilio({ accountSid: TWILIO_SID, authToken: SECRET, from: "+15005550006", fetch: mock.fetch })
        : telnyx({ apiKey: SECRET, from: "+15005550006", fetch: mock.fetch });
    const error = await rejection(createSmsClient({ adapters: [adapter] }).send({ to: "+14155550123", body: BODY }));
    if (!(error instanceof SmsError)) throw new Error("expected SmsError");
    return error;
  }

  test.each([
    [400, { code: 21211, message: "The 'To' number +14155550123 is not a valid phone number.", status: 400 }, "twilio"],
    [401, { code: 20003, message: "Authenticate", status: 401 }, "twilio"],
    [500, { message: `echo ${BODY}` }, "twilio"],
    [422, { errors: [{ code: "40310", title: "Invalid 'to' address", detail: "+14155550123 is invalid" }] }, "telnyx"],
  ] as const)("serialized %i %s errors contain no secrets, bodies, or full numbers", async (status, body, provider) => {
    const error = await thrownBy(status, body, provider);
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(BODY);
    expect(serialized).not.toContain("918273");
    expect(serialized).not.toContain("+14155550123");
    expect(serialized).not.toContain("cause");
    expect(JSON.parse(serialized)).toMatchObject({ code: expect.any(String), retrySafe: expect.any(Boolean) });
  });

  test("toJSON has a stable, minimal shape", () => {
    const error = new ProviderRejectedError("rejected", {
      category: "recipient",
      provider: { provider: "twilio", httpStatus: 400, code: "21211" },
      attempts: [],
    });
    expect(error.toJSON()).toEqual({
      name: "ProviderRejectedError",
      code: "provider_rejected",
      message: "rejected",
      retrySafe: true,
      attempts: [],
      provider: { provider: "twilio", httpStatus: 400, code: "21211" },
    });
  });

  test("HandoffUnknownError keeps the cause off the JSON", () => {
    const error = new HandoffUnknownError("unknown", { reason: "network", attempts: [], cause: new Error(SECRET) });
    expect(error.cause).toBeInstanceOf(Error);
    expect(JSON.stringify(error)).not.toContain(SECRET);
  });

  test("AllProvidersRejectedError serializes every attempt without bodies", () => {
    const inner = new ProviderRejectedError("x", { category: "sender", provider: { provider: "a" }, attempts: [] });
    const error = new AllProvidersRejectedError([inner], [
      { provider: "a", attempt: 1, outcome: "rejected", category: "sender", durationMs: 3 },
    ]);
    expect(JSON.parse(JSON.stringify(error)).attempts).toEqual([
      { provider: "a", attempt: 1, outcome: "rejected", category: "sender", durationMs: 3 },
    ]);
  });
});
