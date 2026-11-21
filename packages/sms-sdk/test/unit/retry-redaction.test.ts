import { describe, expect, test } from "bun:test";
import { createSmsClient } from "../../src/core/client.js";
import {
  AllProvidersRejectedError,
  ConfigurationError,
  HandoffUnknownError,
  InvalidMessageError,
  MessageLookupError,
  ProviderRejectedError,
  SendAbortedError,
  SmsError,
} from "../../src/core/errors.js";
import { parseRetryAfter, providerInfo } from "../../src/core/http.js";
import { redactText } from "../../src/core/redact.js";
import { decideRetry, resolveRetryOptions } from "../../src/core/retry.js";
import { sinch } from "../../src/providers/sinch.js";
import { twilio } from "../../src/providers/twilio.js";
import { telnyx } from "../../src/providers/telnyx.js";
import { mockFetch } from "../../src/testing/fetch.js";
import { memory, rejectedOutcome, unknownOutcome } from "../../src/testing/memory.js";
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
    const wide = resolveRetryOptions({ maxAttempts: 10, baseDelayMs: 100, maxDelayMs: 1_000 });
    expect(decideRetry({ attempt: 9, retryAfterMs: undefined, options: wide, random: () => 0.999 })).toEqual({ kind: "wait", delayMs: 999 });
  });

  test("honors Retry-After only within maxDelayMs", () => {
    expect(decideRetry({ attempt: 1, retryAfterMs: 500, options })).toEqual({ kind: "wait", delayMs: 500 });
    expect(decideRetry({ attempt: 1, retryAfterMs: 5_000, options })).toEqual({ kind: "stop" });
  });

  test("resolveRetryOptions applies defaults and raises maxDelayMs to baseDelayMs", () => {
    expect(resolveRetryOptions(undefined)).toEqual({ maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 10_000 });
    expect(resolveRetryOptions({ baseDelayMs: 2_000, maxDelayMs: 100 }).maxDelayMs).toBe(2_000);
  });

  test.each([
    [{ maxAttempts: 0 }],
    [{ maxAttempts: 11 }],
    [{ maxAttempts: 1e9 }],
    [{ maxAttempts: 2.5 }],
    [{ maxAttempts: Number.NaN }],
    [{ baseDelayMs: Number.NaN }],
    [{ baseDelayMs: -1 }],
    [{ baseDelayMs: Number.POSITIVE_INFINITY }],
    [{ maxDelayMs: Number.NaN }],
    [{ maxDelayMs: Number.POSITIVE_INFINITY }],
  ])("rejects retry %j with ConfigurationError", (retry) => {
    expect(() => resolveRetryOptions(retry)).toThrow(ConfigurationError);
    expect(() => createSmsClient({ adapters: [memory()], retry })).toThrow(ConfigurationError);
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

  test("providerInfo omits free-form response text", () => {
    expect(providerInfo({ provider: "twilio", message: "bad +447700900123" }).message).toBeUndefined();
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
    [400, { code: 21211, message: `echo ${BODY} ${SECRET} alice@example.test`, status: 400 }, "twilio"],
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

  test("strict RFC 9110 parseRetryAfter validates calendar/clock bounds and RFC 850 50-year rule", () => {
    const now = Date.UTC(2020, 0, 1, 0, 0, 0);
    expect(parseRetryAfter("1 Jan 2030", now)).toBeUndefined();
    expect(parseRetryAfter("2030-01-01T00:00:00Z", now)).toBeUndefined();
    expect(parseRetryAfter("5.", now)).toBeUndefined();
    expect(parseRetryAfter(".5", now)).toBeUndefined();
    expect(parseRetryAfter("5 5", now)).toBeUndefined();
    // Impossible calendar dates and out-of-range clock values must be rejected.
    expect(parseRetryAfter("Wed, 31 Feb 2020 00:00:10 GMT", now)).toBeUndefined();
    expect(parseRetryAfter("Thu, 31 Apr 2020 00:00:10 GMT", now)).toBeUndefined();
    expect(parseRetryAfter("Mon, 29 Feb 2021 00:00:10 GMT", now)).toBeUndefined();
    expect(parseRetryAfter("Wed, 01 Jan 2020 24:00:00 GMT", now)).toBeUndefined();
    expect(parseRetryAfter("Wed, 01 Jan 2020 00:00:60 GMT", now)).toBeUndefined();
    expect(parseRetryAfter("Wed, 01 Jan 2020 00:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfter("Sat, 29 Feb 2020 00:00:00 GMT", now)).toBe(Date.UTC(2020, 1, 29) - now);
    expect(parseRetryAfter("Wednesday, 01-Jan-20 00:00:10 GMT", now)).toBe(10_000);
    // RFC 9110 §5.6.7: 2-digit year > 50 years in future maps to previous century.
    expect(parseRetryAfter("Sunday, 06-Nov-94 08:49:37 GMT", now)).toBe(0);
    expect(parseRetryAfter("Sunday, 06-Nov-69 08:49:37 GMT", now)).toBe(Date.UTC(2069, 10, 6, 8, 49, 37) - now);
    expect(parseRetryAfter("Wed Jan  1 00:00:10 2020", now)).toBe(10_000);
  });

  test("single coalesced abort during retry backoff returns SendAbortedError with completed attempts", async () => {
    const adapter = memory({
      outcomes: [rejectedOutcome("rate_limited", { retryAfterMs: 5_000 })],
    });
    const sms = createSmsClient({
      adapters: [adapter],
      retry: { maxAttempts: 2, baseDelayMs: 5_000, maxDelayMs: 10_000 },
    });
    const input = { to: "+14155550123", body: "hi", idempotencyKey: "single-abort-backoff" } as const;
    const a = new AbortController();
    const b = new AbortController();
    const pa = sms.send(input, { signal: a.signal }).catch((e) => e);
    const pb = sms.send(input, { signal: b.signal }).catch((e) => e);

    await new Promise((resolve) => setTimeout(resolve, 25));
    a.abort("only-a");

    const errorA = await pa;
    expect(errorA).toBeInstanceOf(SendAbortedError);
    expect(errorA.retrySafe).toBe(true);
    expect(errorA.attempts).toHaveLength(1);
    expect(errorA.cause).toBe("only-a");
    expect(adapter.sent).toHaveLength(1);

    b.abort("cleanup-b");
    const errorB = await pb;
    expect(errorB).toBeInstanceOf(SendAbortedError);
    expect(errorB.cause).toBe("cleanup-b");
  });

  test("final coalesced in-flight abort preserves its own signal.reason", async () => {
    const adapter = {
      ...memory(),
      name: "deferred",
      send(_message: Parameters<ReturnType<typeof memory>["send"]>[0], context: Parameters<ReturnType<typeof memory>["send"]>[1]) {
        return new Promise<Awaited<ReturnType<ReturnType<typeof memory>["send"]>>>((resolve) => {
          context.signal.addEventListener(
            "abort",
            () => {
              resolve({ kind: "unknown", reason: "aborted" });
            },
            { once: true },
          );
        });
      },
    };
    const sms = createSmsClient({ adapters: [adapter] });
    const input = { to: "+14155550123", body: "hi", idempotencyKey: "all-abort-inflight" } as const;
    const a = new AbortController();
    const b = new AbortController();
    const pa = sms.send(input, { signal: a.signal }).catch((e) => e);
    const pb = sms.send(input, { signal: b.signal }).catch((e) => e);

    await new Promise((resolve) => setTimeout(resolve, 20));
    a.abort("own-a");
    b.abort("own-b");

    const [ea, eb] = await Promise.all([pa, pb]);
    expect(ea).toBeInstanceOf(HandoffUnknownError);
    expect(eb).toBeInstanceOf(HandoffUnknownError);
    expect(ea.cause).toBe("own-a");
    expect(eb.cause).toBe("own-b");
  });

  test("Sinch sendAt + validityPeriodSec overflow fails validation before any HTTP request", async () => {
    let requests = 0;
    const client = createSmsClient({
      adapters: [
        sinch({
          servicePlanId: "plan",
          apiToken: "token",
          from: "+15005550006",
          fetch: async () => {
            requests += 1;
            throw new Error("must not fetch");
          },
        }),
      ],
    });
    const error = await rejection(
      client.send({
        to: "+14155550123",
        body: "hi",
        sendAt: new Date(8_640_000_000_000_000),
        validityPeriodSec: 1,
      }),
    );
    expect(error).toBeInstanceOf(InvalidMessageError);
    expect(requests).toBe(0);
  });

  test("custom adapter names stay intact on in-memory errors while messages and toJSON() sanitize them", async () => {
    const secretName = "sk-live-PROVIDER-SECRET";
    const friendlyName = "Acme SMS";

    const smsSecret = createSmsClient({
      adapters: [
        {
          ...memory(),
          name: secretName,
          async send() {
            return unknownOutcome("network");
          },
        },
      ],
    });
    const secretErr = await rejection(smsSecret.send({ to: "+14155550123", body: "hi" }));
    expect(secretErr).toBeInstanceOf(HandoffUnknownError);
    expect((secretErr as HandoffUnknownError).providerName).toBe(secretName);
    expect((secretErr as HandoffUnknownError).message).not.toContain(secretName);
    const secretJson = JSON.stringify(secretErr);
    expect(secretJson).not.toContain(secretName);
    expect(JSON.parse(secretJson).providerName).toBe("unknown");

    const smsFriendly = createSmsClient({
      adapters: [
        {
          ...memory(),
          name: friendlyName,
          async send() {
            return unknownOutcome("network");
          },
        },
      ],
    });
    const friendlyErr = await rejection(smsFriendly.send({ to: "+14155550123", body: "hi" }));
    expect((friendlyErr as HandoffUnknownError).providerName).toBe(friendlyName);

    const lookupErr = new MessageLookupError({
      reason: "network",
      providerName: secretName,
      providerId: "msg-1",
    });
    expect(lookupErr.providerName).toBe(secretName);
    expect(lookupErr.message).not.toContain(secretName);
    expect(JSON.stringify(lookupErr)).not.toContain(secretName);
    expect(lookupErr.toJSON().providerName).toBe("unknown");
  });
});
