import { describe, expect, test } from "bun:test";
import { createSmsClient } from "../../src/core/client.js";
import { resolveSender, supportsSender } from "../../src/core/capabilities.js";
import {
  ConfigurationError,
  InvalidMessageError,
  InvalidRecipientError,
  InvalidSenderError,
  UnsupportedFieldError,
} from "../../src/core/errors.js";
import type { SmsSendInput } from "../../src/core/types.js";
import { telnyx } from "../../src/providers/telnyx.js";
import { twilio } from "../../src/providers/twilio.js";
import { vonage } from "../../src/providers/vonage.js";
import { plivo } from "../../src/providers/plivo.js";
import { memory } from "../../src/testing/memory.js";
import { mockFetch } from "../../src/testing/fetch.js";
import { rejection, TWILIO_SERVICE_SID, TWILIO_SID } from "../helpers.js";

describe("resolveSender", () => {
  test.each([
    [{ senderId: "Acme" }, "alphanumeric"],
    [{ senderId: "ACME 2FA" }, "alphanumeric"],
    [{ senderId: "A1234567890" }, "alphanumeric"],
    [{ shortCode: "123" }, "short_code"],
    [{ shortCode: "12345678" }, "short_code"],
    [{ messagingService: "MG1" }, "messaging_service"],
    ["+15005550006", "phone_number"],
  ] as const)("accepts %j as %s", (from, kind) => {
    const resolution = resolveSender(from);
    expect(resolution.kind).toBe("ok");
    if (resolution.kind === "ok") {
      expect(resolution.sender.kind).toBe(kind);
    }
  });

  test.each([
    [{ senderId: "" }],
    [{ senderId: "123456" }],
    [{ senderId: "TwelveChars1" }],
    [{ senderId: "Acme!" }],
    [{ shortCode: "12" }],
    [{ shortCode: "123456789" }],
    [{ shortCode: "12a45" }],
    [{ messagingService: "  " }],
    ["+0123"],
  ] as const)("rejects %j", (from) => {
    expect(resolveSender(from).kind).toBe("invalid");
  });

  test("reports a missing sender", () => {
    expect(resolveSender(undefined).kind).toBe("missing");
  });

  test("phone numbers need long_code or toll_free support", () => {
    const sender = { kind: "phone_number", value: "+15005550006" } as const;
    expect(supportsSender(memory({ capabilities: { senderTypes: ["toll_free"] } }).capabilities, sender)).toBe(true);
    expect(supportsSender(memory({ capabilities: { senderTypes: ["short_code"] } }).capabilities, sender)).toBe(false);
  });
});

describe("createSmsClient configuration", () => {
  test("rejects duplicate adapter names", () => {
    expect(() => createSmsClient({ adapters: [memory(), memory()] })).toThrow(ConfigurationError);
  });

  test("rejects an empty adapter list", () => {
    const adapters: never[] = [];
    // @ts-expect-error the type requires at least one adapter
    expect(() => createSmsClient({ adapters })).toThrow(ConfigurationError);
  });

  test("rejects a non-positive timeout", () => {
    expect(() => createSmsClient({ adapters: [memory()], timeoutMs: 0 })).toThrow(ConfigurationError);
  });
});

describe("local validation fails before any request", () => {
  const cases: Array<[string, SmsSendInput, abstract new (...args: never[]) => Error]> = [
    ["invalid recipient", { to: "+0123", body: "hi" }, InvalidRecipientError],
    ["recipient with spaces", { to: "+1 415 555 0123", body: "hi" }, InvalidRecipientError],
    ["empty body", { to: "+14155550123", body: "" }, InvalidMessageError],
    ["bad media URL", { to: "+14155550123", body: "hi", mediaUrls: ["ftp://x"] }, InvalidMessageError],
    ["invalid sendAt", { to: "+14155550123", body: "hi", sendAt: new Date("nope") }, InvalidMessageError],
    ["negative validity", { to: "+14155550123", body: "hi", validityPeriodSec: -1 }, InvalidMessageError],
    ["relative webhook", { to: "+14155550123", body: "hi", webhookUrl: "/status" }, InvalidMessageError],
    ["empty idempotency key", { to: "+14155550123", body: "hi", idempotencyKey: "" }, InvalidMessageError],
    ["malformed sender", { to: "+14155550123", body: "hi", from: "5550006" as `+${string}` }, InvalidSenderError],
  ];

  test.each(cases)("%s", async (_name, input, errorClass) => {
    const mock = mockFetch({ status: 201, body: {} });
    const sms = createSmsClient({
      adapters: [twilio({ accountSid: TWILIO_SID, authToken: "token", from: "+15005550006", fetch: mock.fetch })],
    });
    const error = await rejection(sms.send(input));
    expect(error).toBeInstanceOf(errorClass);
    expect(mock.calls).toHaveLength(0);
  });

  test("missing sender throws InvalidSenderError naming the adapter", async () => {
    const mock = mockFetch({ status: 201, body: {} });
    const sms = createSmsClient({ adapters: [telnyx({ apiKey: "key", fetch: mock.fetch })] });
    const error = await rejection(sms.send({ to: "+14155550123", body: "hi" }));
    expect(error).toBeInstanceOf(InvalidSenderError);
    expect(error).toMatchObject({ providerName: "telnyx", retrySafe: true });
    expect(mock.calls).toHaveLength(0);
  });

  test("media-only messages may have an empty body", () => {
    const sms = createSmsClient({ adapters: [memory()] });
    expect(sms.validate({ to: "+14155550123", body: "", mediaUrls: ["https://example.com/a.png"] }).supported).toBe(true);
  });
});

describe("unsupported fields throw UnsupportedFieldError before fetch", () => {
  const vonageAdapter = (fetch: ReturnType<typeof mockFetch>["fetch"]) =>
    vonage({ apiKey: "key", apiSecret: "secret", from: "+15005550006", fetch });

  test.each([
    ["mediaUrls", { mediaUrls: ["https://example.com/a.png"] }],
    ["sendAt", { sendAt: new Date(Date.now() + 3_600_000) }],
    ["webhookUrl", { webhookUrl: "https://example.com/status" }],
    ["from", { from: { shortCode: "12345" } }],
    ["from", { from: { messagingService: "pool" } }],
  ] as const)("vonage (basic auth) rejects %s", async (field, extra) => {
    const mock = mockFetch({ status: 202, body: { message_uuid: "x" } });
    const sms = createSmsClient({ adapters: [vonageAdapter(mock.fetch)] });
    const error = await rejection(sms.send({ to: "+14155550123", body: "hi", ...extra }));
    expect(error).toBeInstanceOf(UnsupportedFieldError);
    expect(error).toMatchObject({ field, providerName: "vonage" });
    expect(mock.calls).toHaveLength(0);
  });

  test("telnyx rejects validityPeriodSec", async () => {
    const mock = mockFetch({ status: 200, body: {} });
    const sms = createSmsClient({ adapters: [telnyx({ apiKey: "key", from: "+15005550006", fetch: mock.fetch })] });
    const error = await rejection(sms.send({ to: "+14155550123", body: "hi", validityPeriodSec: 600 }));
    expect(error).toBeInstanceOf(UnsupportedFieldError);
    expect(mock.calls).toHaveLength(0);
  });

  test("plivo rejects sendAt", async () => {
    const mock = mockFetch({ status: 202, body: {} });
    const sms = createSmsClient({
      adapters: [plivo({ authId: "MA1", authToken: "token", from: "+15005550006", fetch: mock.fetch })],
    });
    const error = await rejection(sms.send({ to: "+14155550123", body: "hi", sendAt: new Date(Date.now() + 3_600_000) }));
    expect(error).toBeInstanceOf(UnsupportedFieldError);
    expect(mock.calls).toHaveLength(0);
  });

  test("twilio rejects sendAt without a Messaging Service sender", async () => {
    const mock = mockFetch({ status: 201, body: {} });
    const sms = createSmsClient({
      adapters: [twilio({ accountSid: TWILIO_SID, authToken: "token", from: "+15005550006", fetch: mock.fetch })],
    });
    const error = await rejection(sms.send({ to: "+14155550123", body: "hi", sendAt: new Date(Date.now() + 3_600_000) }));
    expect(error).toBeInstanceOf(UnsupportedFieldError);
    expect(error).toMatchObject({ field: "sendAt", providerName: "twilio" });
    expect(mock.calls).toHaveLength(0);
  });

  test("telnyx rejects an alphanumeric sender without a messaging profile", async () => {
    const mock = mockFetch({ status: 200, body: {} });
    const sms = createSmsClient({ adapters: [telnyx({ apiKey: "key", fetch: mock.fetch })] });
    const error = await rejection(sms.send({ to: "+14155550123", body: "hi", from: { senderId: "Acme" } }));
    expect(error).toBeInstanceOf(InvalidSenderError);
    expect(mock.calls).toHaveLength(0);
  });

  test("validity periods outside the provider range are invalid", async () => {
    const mock = mockFetch({ status: 201, body: {} });
    const sms = createSmsClient({
      adapters: [twilio({ accountSid: TWILIO_SID, authToken: "token", from: "+15005550006", fetch: mock.fetch })],
    });
    const error = await rejection(sms.send({ to: "+14155550123", body: "hi", validityPeriodSec: 36_001 }));
    expect(error).toBeInstanceOf(InvalidMessageError);
    expect(mock.calls).toHaveLength(0);
  });

  test("twilio rejects bodies over 1600 characters", async () => {
    const mock = mockFetch({ status: 201, body: {} });
    const sms = createSmsClient({
      adapters: [twilio({ accountSid: TWILIO_SID, authToken: "token", from: "+15005550006", fetch: mock.fetch })],
    });
    const error = await rejection(sms.send({ to: "+14155550123", body: "a".repeat(1601) }));
    expect(error).toBeInstanceOf(InvalidMessageError);
    expect(mock.calls).toHaveLength(0);
  });

  test("twilio rejects a malformed Messaging Service SID", async () => {
    const mock = mockFetch({ status: 201, body: {} });
    const sms = createSmsClient({
      adapters: [twilio({ accountSid: TWILIO_SID, authToken: "token", fetch: mock.fetch })],
    });
    const error = await rejection(sms.send({ to: "+14155550123", body: "hi", from: { messagingService: "MG123" } }));
    expect(error).toBeInstanceOf(InvalidSenderError);
    expect(mock.calls).toHaveLength(0);
  });
});

describe("sms.validate", () => {
  const sms = createSmsClient({
    adapters: [
      twilio({ accountSid: TWILIO_SID, authToken: "token", from: { messagingService: TWILIO_SERVICE_SID } }),
      vonage({ apiKey: "key", apiSecret: "secret", from: "+15005550006" }),
    ],
  });

  test("returns encoding, segments, and candidates", () => {
    const result = sms.validate({ to: "+14155550123", body: "Your package is ready 📦" });
    expect(result).toMatchObject({ supported: true, encoding: "ucs2", segments: 1, adapterCandidates: ["twilio", "vonage"] });
    expect(result.issues).toEqual([]);
  });

  test("lists per-adapter issues and drops unsupported candidates", () => {
    const result = sms.validate({ to: "+14155550123", body: "hi", sendAt: new Date(Date.now() + 3_600_000) });
    expect(result.supported).toBe(true);
    expect(result.adapterCandidates).toEqual(["twilio"]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "unsupported_field", field: "sendAt", provider: "vonage" })]);
  });

  test("is unsupported when the primary adapter cannot send", () => {
    const result = sms.validate({ to: "+14155550123", body: "hi", mediaUrls: ["https://example.com/a.png"], from: "+15005550006" });
    expect(result.supported).toBe(true);
    const vonageFirst = createSmsClient({ adapters: [vonage({ apiKey: "k", apiSecret: "s", from: "+15005550006" })] });
    expect(vonageFirst.validate({ to: "+14155550123", body: "hi", mediaUrls: ["https://example.com/a.png"] }).supported).toBe(false);
  });

  test("reports message-level issues without adapter candidates", () => {
    const result = sms.validate({ to: "+1", body: "" });
    expect(result.supported).toBe(false);
    expect(result.adapterCandidates).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toEqual(["invalid_recipient", "empty_body"]);
  });

  test("never calls fetch", () => {
    const mock = mockFetch({ status: 500 });
    const client = createSmsClient({ adapters: [telnyx({ apiKey: "k", from: "+15005550006", fetch: mock.fetch })] });
    client.validate({ to: "+14155550123", body: "hi" });
    expect(mock.calls).toHaveLength(0);
  });
});

describe("capabilities()", () => {
  test("exposes adapter metadata", () => {
    const sms = createSmsClient({ adapters: [memory({ name: "a" }), plivo({ authId: "MA1", authToken: "t" })] });
    const info = sms.capabilities();
    expect(info.map((entry) => entry.name)).toEqual(["a", "plivo"]);
    expect(info[1]?.support.status).toBe("partial");
    expect(info[1]?.capabilities.validityPeriod).toEqual({ minSec: 5, maxSec: 10_799 });
  });
});
