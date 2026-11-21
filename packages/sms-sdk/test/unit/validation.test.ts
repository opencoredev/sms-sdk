import { describe, expect, test } from "bun:test";
import { createSmsClient } from "../../src/core/client.js";
import { resolveSender, supportsSender } from "../../src/core/capabilities.js";
import {
  ConfigurationError,
  IdempotencyConflictError,
  InvalidMessageError,
  InvalidRecipientError,
  InvalidSenderError,
  MessageLookupError,
  PolicyRejectedError,
  SmsError,
  UnsupportedFieldError,
  WebhookPayloadError,
  WebhookSignatureError,
} from "../../src/core/errors.js";
import { memoryIdempotencyStore } from "../../src/core/idempotency.js";
import type { SmsSendInput } from "../../src/core/types.js";
import { bandwidth } from "../../src/providers/bandwidth.js";
import { plivo } from "../../src/providers/plivo.js";
import { sinch } from "../../src/providers/sinch.js";
import { telnyx } from "../../src/providers/telnyx.js";
import { twilio } from "../../src/providers/twilio.js";
import { vonage } from "../../src/providers/vonage.js";
import {
  computePlivoSignatureV2,
  computeTwilioSignature,
  parseSmsWebhook,
  verifyPlivoSignatureV2,
  verifySinchSignature,
  verifyTelnyxSignature,
  verifyTwilioSignature,
  verifyVonageSignature,
  type SinchWebhookVerification,
} from "../../src/webhooks/index.js";
import { paramsToRecord } from "../../src/webhooks/shared.js";
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

describe("malformed runtime input", () => {
  /** A message as it arrives from an untyped JavaScript caller or a JSON body. */
  const fromJson = (json: string): SmsSendInput => JSON.parse(json);
  const sms = createSmsClient({ adapters: [memory()] });

  test.each([
    ["mediaUrls is a string", '{"to":"+14155550123","body":"hi","mediaUrls":"https://example.com/a.png"}', "mediaUrls"],
    ["mediaUrls is a number", '{"to":"+14155550123","body":"hi","mediaUrls":5}', "mediaUrls"],
    ["mediaUrls is an object", '{"to":"+14155550123","body":"hi","mediaUrls":{"0":"https://example.com/a.png"}}', "mediaUrls"],
    ["idempotencyKey is a number", '{"to":"+14155550123","body":"hi","idempotencyKey":5}', "idempotencyKey"],
    ["body is a number", '{"to":"+14155550123","body":5}', "body"],
    ["input is null", "null", "message"],
    ["input is a string", '"+14155550123"', "message"],
    ["input is an array", "[]", "message"],
  ])("validate() returns an issue when %s", (_name, json, field) => {
    const result = sms.validate(fromJson(json));
    expect(result.supported).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "invalid_field", field }));
  });

  test.each([
    ['{"to":"+14155550123","body":"hi","mediaUrls":"https://example.com/a.png"}', "mediaUrls"],
    ['{"to":"+14155550123","body":"hi","idempotencyKey":5}', "idempotencyKey"],
    ["null", "message"],
    ["42", "message"],
  ])("send(%s) throws InvalidMessageError before any request", async (json, field) => {
    const adapter = memory();
    const client = createSmsClient({ adapters: [adapter] });
    const error = await rejection(client.send(fromJson(json)));
    expect(error).toBeInstanceOf(InvalidMessageError);
    expect(error).toBeInstanceOf(SmsError);
    expect(error).toMatchObject({ field, retrySafe: true });
    expect(adapter.sent).toHaveLength(0);
  });

  test("send(undefined) throws InvalidMessageError", async () => {
    // @ts-expect-error -- untyped JavaScript callers can omit the message.
    const error = await rejection(sms.send(undefined));
    expect(error).toBeInstanceOf(InvalidMessageError);
  });

  test.each([
    ["from.messagingService is a number", '{"to":"+14155550123","body":"hi","from":{"messagingService":123}}'],
    ["fromByAdapter.messagingService is a number", '{"to":"+14155550123","body":"hi","fromByAdapter":{"memory":{"messagingService":123}}}'],
    ["from.senderId is null", '{"to":"+14155550123","body":"hi","from":{"senderId":null}}'],
    ["fromByAdapter.senderId is null", '{"to":"+14155550123","body":"hi","fromByAdapter":{"memory":{"senderId":null}}}'],
    ["from.shortCode is a number", '{"to":"+14155550123","body":"hi","from":{"shortCode":12345}}'],
  ])("rejects malformed sender objects when %s without throwing TypeError", async (_name, json) => {
    const adapter = memory();
    const client = createSmsClient({ adapters: [adapter] });
    const parsed = fromJson(json);
    const result = client.validate(parsed);
    expect(result.supported).toBe(false);
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "invalid_sender", field: "from" }));
    const error = await rejection(client.send(parsed));
    expect(error).toBeInstanceOf(InvalidSenderError);
    expect(adapter.sent).toHaveLength(0);
  });

  test("ignores malformed fromByAdapter entries for unconfigured adapters", async () => {
    const adapter = memory();
    const client = createSmsClient({ adapters: [adapter] });
    const parsed = fromJson('{"to":"+14155550123","from":"+14155550100","body":"hi","fromByAdapter":{"unconfigured":null}}');
    expect(client.validate(parsed).supported).toBe(true);
    const result = await client.send(parsed);
    expect(result.provider).toBe("memory");
    expect(adapter.sent).toHaveLength(1);
  });

  test("rejects missing adapter options, invalid getMessage args, overflowing TTLs, and invalid webhook credentials/tolerances", async () => {
    const { sinch } = await import("../../src/providers/sinch.js");
    const { vonage } = await import("../../src/providers/vonage.js");
    const { ConfigurationError, WebhookPayloadError } = await import("../../src/core/errors.js");
    const { memoryIdempotencyStore } = await import("../../src/core/idempotency.js");
    const { hasBasicAuthorization } = await import("../../src/webhooks/shared.js");
    const { verifySinchSignature } = await import("../../src/webhooks/sinch.js");
    const { verifyTelnyxSignature } = await import("../../src/webhooks/telnyx.js");
    const { verifyVonageSignature } = await import("../../src/webhooks/vonage.js");
    const { interpretBandwidthEvents } = await import("../../src/webhooks/bandwidth.js");

    // @ts-expect-error -- untyped JS callers can omit options
    expect(() => sinch()).toThrow(ConfigurationError);
    // @ts-expect-error -- untyped JS callers can omit apiSecret
    expect(() => vonage({ apiKey: "k" })).toThrow(ConfigurationError);
    // @ts-expect-error -- untyped JS callers can omit privateKey
    expect(() => vonage({ applicationId: "app-1" })).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        adapters: [memory()],
        idempotency: { store: memoryIdempotencyStore(), ttlSec: 1e306 },
      }),
    ).toThrow(ConfigurationError);

    const client = createSmsClient({ adapters: [memory()] });
    expect(await rejection(client.getMessage(".."))).toBeInstanceOf(ConfigurationError);
    expect(await rejection(client.getMessage("."))).toBeInstanceOf(ConfigurationError);
    // @ts-expect-error -- untyped JS callers can pass null options
    expect(await rejection(client.getMessage("id", null))).toBeInstanceOf(ConfigurationError);

    expect(() => hasBasicAuthorization("Basic Og==", { username: "", password: "" })).toThrow(ConfigurationError);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(
        await rejection(
          verifySinchSignature({
            webhookSecret: "sec",
            rawBody: "{}",
            signature: "abc",
            nonce: "n",
            timestamp: "1",
            toleranceSec: bad,
          }),
        ),
      ).toBeInstanceOf(ConfigurationError);
      expect(
        await rejection(
          verifyTelnyxSignature({
            publicKey: "k",
            rawBody: "{}",
            signature: "abc",
            timestamp: "1",
            toleranceSec: bad,
          }),
        ),
      ).toBeInstanceOf(ConfigurationError);
      expect(
        await rejection(
          verifyVonageSignature({
            signatureSecret: "sec",
            authorization: "Bearer a.b.c",
            rawBody: "{}",
            toleranceSec: bad,
          }),
        ),
      ).toBeInstanceOf(ConfigurationError);
    }
    expect(
      await rejection(
        verifySinchSignature({
          webhookSecret: "",
          rawBody: "{}",
          signature: "abc",
          nonce: "n",
          timestamp: String(Math.floor(Date.now() / 1000)),
        }),
      ),
    ).toBeInstanceOf(ConfigurationError);

    const payloadErr = new WebhookPayloadError("too big", { provider: "twilio", reason: "body_too_large" });
    expect(payloadErr.toJSON()).toMatchObject({ providerName: "twilio", reason: "body_too_large" });

    const { twilio } = await import("../../src/providers/twilio.js");
    const { telnyx } = await import("../../src/providers/telnyx.js");
    const { plivo } = await import("../../src/providers/plivo.js");
    const { bandwidth } = await import("../../src/providers/bandwidth.js");
    const { parseSmsWebhook, parseSmsWebhooks } = await import("../../src/webhooks/index.js");

    const bwEvents = interpretBandwidthEvents(
      [
        { type: "message-delivered", message: { id: "g1", to: ["+15551111111"] } },
        { type: "message-delivered", message: { id: "g1", to: ["+15552222222"] } },
      ],
      true,
    );
    expect(bwEvents[0]?.dedupeKey).toBe("bandwidth:g1:+15551111111:message-delivered");
    expect(bwEvents[1]?.dedupeKey).toBe("bandwidth:g1:+15552222222:message-delivered");

    // @ts-expect-error -- untyped JS callers can omit options
    expect(() => vonage()).toThrow(ConfigurationError);
    // @ts-expect-error -- untyped JS callers can omit options
    expect(() => twilio()).toThrow(ConfigurationError);
    // @ts-expect-error -- untyped JS callers can omit options
    expect(() => telnyx()).toThrow(ConfigurationError);
    // @ts-expect-error -- untyped JS callers can omit options
    expect(() => plivo()).toThrow(ConfigurationError);
    // @ts-expect-error -- untyped JS callers can omit options
    expect(() => bandwidth()).toThrow(ConfigurationError);
    // @ts-expect-error -- untyped JS callers can omit options
    expect(() => createSmsClient()).toThrow(ConfigurationError);
    // @ts-expect-error -- untyped JS callers can pass non-string baseUrl
    expect(() => sinch({ servicePlanId: "sp", apiToken: "t", baseUrl: 5 })).toThrow(ConfigurationError);
    // @ts-expect-error -- untyped JS callers can pass a non-AbortSignal
    expect(await rejection(client.getMessage("id", { signal: {} }))).toBeInstanceOf(ConfigurationError);
    // @ts-expect-error -- untyped JS callers can pass null send options
    expect(await rejection(client.send({ to: "+14155550123", body: "hi" }, null))).toBeInstanceOf(ConfigurationError);
    // @ts-expect-error -- untyped JS callers can pass a non-AbortSignal
    expect(await rejection(client.send({ to: "+14155550123", body: "hi" }, { signal: {} }))).toBeInstanceOf(ConfigurationError);

    const unsignedStop = () =>
      new Request("https://example.com/webhooks/sinch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "mo_text", id: "m1", from: "+14155550123", to: "+15005550006", body: "STOP" }),
      });
    for (const badCreds of [
      undefined,
      {},
      { username: "u", password: "p" },
      { kind: "Basic", username: "u", password: "p" },
      { kind: "HMAC", webhookSecret: "s" },
      { kind: "oauth" },
    ]) {
      expect(
        await rejection(
          parseSmsWebhooks({
            provider: "sinch",
            request: unsignedStop(),
            // @ts-expect-error -- untyped JS callers can pass bad credentials.kind
            credentials: badCreds,
          }),
        ),
      ).toBeInstanceOf(ConfigurationError);
    }
    // @ts-expect-error -- untyped JS callers can pass an unknown provider
    expect(await rejection(parseSmsWebhook({ provider: "bogus" }))).toBeInstanceOf(ConfigurationError);
    // @ts-expect-error -- untyped JS callers can pass an unknown provider
    expect(await rejection(parseSmsWebhooks({ provider: "bogus" }))).toBeInstanceOf(ConfigurationError);

    // Fake AbortSignal objects must be rejected with ConfigurationError
    const fakeSignal = { aborted: false, addEventListener() {}, removeEventListener() {} };
    // @ts-expect-error -- fake signal is not an AbortSignal
    expect(await rejection(client.send({ to: "+14155550123", body: "hi" }, { signal: fakeSignal }))).toBeInstanceOf(
      ConfigurationError,
    );
    // @ts-expect-error -- fake signal is not an AbortSignal
    expect(await rejection(client.getMessage("id", { signal: fakeSignal }))).toBeInstanceOf(ConfigurationError);

    // Malformed adapters, beforeSend, baseUrl, and fetch fail at construction time
    // @ts-expect-error -- null adapter
    expect(() => createSmsClient({ adapters: [null] })).toThrow(ConfigurationError);
    // @ts-expect-error -- empty adapter
    expect(() => createSmsClient({ adapters: [{}] })).toThrow(ConfigurationError);
    // @ts-expect-error -- non-function beforeSend
    expect(() => createSmsClient({ adapters: [memory()], beforeSend: 5 })).toThrow(ConfigurationError);
    expect(() => twilio({ accountSid: "AC" + "0".repeat(32), authToken: "t", baseUrl: "not-a-url" })).toThrow(
      ConfigurationError,
    );
    // @ts-expect-error -- non-function fetch
    expect(() => twilio({ accountSid: "AC" + "0".repeat(32), authToken: "t", fetch: 5 })).toThrow(ConfigurationError);

    // Missing or empty webhook secrets must throw ConfigurationError even on unsigned requests
    const unsignedReq = () => new Request("https://example.com/hook", { method: "POST", body: "{}" });
    for (const badOpts of [
      { provider: "twilio", request: unsignedReq(), credentials: undefined },
      { provider: "twilio", request: unsignedReq(), credentials: { authToken: "" } },
      { provider: "plivo", request: unsignedReq(), credentials: undefined },
      { provider: "plivo", request: unsignedReq(), credentials: { authToken: "" } },
      { provider: "telnyx", request: unsignedReq(), credentials: { publicKey: "" } },
      { provider: "vonage", request: unsignedReq(), credentials: { signatureSecret: "" } },
      { provider: "sinch", request: unsignedReq(), credentials: { kind: "hmac", webhookSecret: "" } },
      { provider: "twilio", credentials: { authToken: "tok" } },
    ]) {
      // @ts-expect-error -- testing invalid runtime webhook configurations
      expect(await rejection(parseSmsWebhook(badOpts))).toBeInstanceOf(ConfigurationError);
    }

    // Object.hasOwn guard for prototype keys in providerOptions
    const protoClient = createSmsClient({ adapters: [memory({ name: "toString" })] });
    expect(protoClient.validate({ to: "+14155550123", body: "hi", providerOptions: {} }).supported).toBe(true);
  });

  test("rejects spoofed AbortSignal, malformed adapters/fallback/hooks, invalid baseUrl/region/fetch, and malformed webhooks", async () => {
    const client = createSmsClient({ adapters: [memory()] });

    // Symbol.toStringTag and Object.create(AbortSignal.prototype) spoofs
    const tagSpoof = { [Symbol.toStringTag]: "AbortSignal", aborted: false, addEventListener() {}, removeEventListener() {} };
    const protoSpoof = Object.create(AbortSignal.prototype);
    for (const badSignal of [tagSpoof, protoSpoof]) {
      expect(await rejection(client.send({ to: "+14155550123", body: "hi" }, { signal: badSignal }))).toBeInstanceOf(
        ConfigurationError,
      );
      expect(await rejection(client.getMessage("id", { signal: badSignal }))).toBeInstanceOf(ConfigurationError);
    }

    // createSmsClient fallback, hooks, and adapter capabilities shape
    // @ts-expect-error -- invalid fallback string
    expect(() => createSmsClient({ adapters: [memory()], fallback: "on-known-rejections" })).toThrow(ConfigurationError);
    // @ts-expect-error -- invalid hooks
    expect(() => createSmsClient({ adapters: [memory()], hooks: "x" })).toThrow(ConfigurationError);
    // @ts-expect-error -- invalid hook value
    expect(() => createSmsClient({ adapters: [memory()], hooks: { onAttempt: 5 } })).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        // @ts-expect-error -- missing capabilities.senderTypes
        adapters: [{ name: "bad", capabilities: {}, send: async () => ({ kind: "sent", providerId: "1" }) }],
      }),
    ).toThrow(ConfigurationError);

    // All 6 factories validate baseUrl (whitespace/query/hash/protocol) and fetch; Vonage validates region
    expect(() => twilio({ accountSid: "AC" + "0".repeat(32), authToken: "t", baseUrl: "https://api.twilio.com " })).toThrow(
      ConfigurationError,
    );
    expect(() => twilio({ accountSid: "AC" + "0".repeat(32), authToken: "t", baseUrl: "https://api.twilio.com?x=1" })).toThrow(
      ConfigurationError,
    );
    expect(() => telnyx({ apiKey: "k", baseUrl: "ftp://example.com" })).toThrow(ConfigurationError);
    // @ts-expect-error -- non-function fetch
    expect(() => telnyx({ apiKey: "k", fetch: "no" })).toThrow(ConfigurationError);
    expect(() => plivo({ authId: "a", authToken: "t", baseUrl: "https://api.plivo.com#frag" })).toThrow(ConfigurationError);
    // @ts-expect-error -- non-function fetch
    expect(() => plivo({ authId: "a", authToken: "t", fetch: null })).toThrow(ConfigurationError);
    // @ts-expect-error -- invalid Vonage region
    expect(() => vonage({ apiKey: "k", apiSecret: "s", region: "attacker.example/steal#" })).toThrow(ConfigurationError);
    expect(() => vonage({ apiKey: "k", apiSecret: "s", baseUrl: "junk" })).toThrow(ConfigurationError);
    expect(() =>
      bandwidth({ userId: "a", applicationId: "app", apiToken: "u", apiSecret: "p", baseUrl: "junk" }),
    ).toThrow(ConfigurationError);
    expect(() => sinch({ servicePlanId: "sp", apiToken: "t", baseUrl: "junk" })).toThrow(ConfigurationError);

    // Plivo validates publicUrl before signature headers and even with unsafeSkipVerification
    const unsigned = () => new Request("https://example.com/hook", { method: "POST", body: "{}" });
    expect(
      await rejection(
        parseSmsWebhook({ provider: "plivo", request: unsigned(), credentials: { authToken: "tok" }, publicUrl: "not-a-url" }),
      ),
    ).toBeInstanceOf(ConfigurationError);
    expect(
      await rejection(
        parseSmsWebhook({
          provider: "plivo",
          request: unsigned(),
          credentials: { authToken: "tok" },
          publicUrl: "ftp://example.com/hook",
          unsafeSkipVerification: true,
        }),
      ),
    ).toBeInstanceOf(ConfigurationError);

    // Malformed forwarded proxy headers fail closed with WebhookSignatureError instead of TypeError
    const badProxyReq = new Request("https://example.com/hook", {
      method: "POST",
      headers: { "x-forwarded-host": "[invalid" },
      body: "{}",
    });
    expect(
      await rejection(
        parseSmsWebhook({ provider: "twilio", request: badProxyReq, credentials: { authToken: "tok" }, trustProxy: true }),
      ),
    ).toBeInstanceOf(WebhookSignatureError);

    // Malformed Request object (missing body/url/method) and non-function now throw ConfigurationError
    expect(
      await rejection(
        parseSmsWebhook({
          provider: "telnyx",
          credentials: { publicKey: "a" },
          request: { headers: { get: () => null } } as unknown as Request,
        }),
      ),
    ).toBeInstanceOf(ConfigurationError);
    expect(
      await rejection(
        parseSmsWebhook({
          provider: "telnyx",
          credentials: { publicKey: "a" },
          request: unsigned(),
          now: 123 as unknown as () => number,
        }),
      ),
    ).toBeInstanceOf(ConfigurationError);

    // Bandwidth & Sinch Basic auth validate credentials before reading headers
    let headerRead = false;
    const spyReq = {
      url: "https://example.com/hook",
      method: "POST",
      body: null,
      headers: {
        get: (name: string) => {
          if (name.toLowerCase() === "authorization") headerRead = true;
          return null;
        },
      },
    } as unknown as Request;
    expect(
      await rejection(
        parseSmsWebhook({ provider: "bandwidth", request: spyReq, credentials: { username: "", password: "p" } }),
      ),
    ).toBeInstanceOf(ConfigurationError);
    expect(headerRead).toBe(false);

    // Non-plain prototype objects inside providerOptions[provider] are rejected with invalid_field
    const inheritedEntry = Object.create({ shortenUrls: "not-a-boolean", extra: "not-an-object" });
    const twilioClient = createSmsClient({
      adapters: [twilio({ accountSid: "AC" + "0".repeat(32), authToken: "t", from: "+15005550006" })],
    });
    expect(
      twilioClient
        .validate({
          to: "+14155550123",
          body: "hi",
          providerOptions: { twilio: inheritedEntry },
        })
        .issues.some((i) => i.code === "invalid_field"),
    ).toBe(true);

    // Error toJSON includes providerName and reason
    const lookupErr = new MessageLookupError({ providerName: "twilio", providerId: "SM1", reason: "network" });
    expect(lookupErr.toJSON()).toMatchObject({ providerName: "twilio", reason: "network" });
    const sigErr = new WebhookSignatureError("bad sig", { provider: "plivo", reason: "invalid_signature" });
    expect(sigErr.toJSON()).toMatchObject({ providerName: "plivo", reason: "invalid_signature" });
  });

  test("beforeSend fails closed on unrecognized or malformed decisions without stranding idempotency", async () => {
    const store = memoryIdempotencyStore();
    const denyClient = createSmsClient({
      adapters: [memory()],
      idempotency: { store },
      // @ts-expect-error -- typo in policy decision kind
      beforeSend: () => ({ kind: "deny", reason: "blocked" }),
    });
    expect(
      await rejection(denyClient.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-deny" })),
    ).toBeInstanceOf(PolicyRejectedError);
    expect((await store.get("k-deny"))?.state).toBe("rejected");

    const nullClient = createSmsClient({
      adapters: [memory()],
      idempotency: { store },
      // @ts-expect-error -- malformed policy decision
      beforeSend: () => null,
    });
    expect(
      await rejection(nullClient.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-null" })),
    ).toBeInstanceOf(PolicyRejectedError);
    expect((await store.get("k-null"))?.state).toBe("rejected");
  });

  test("rejects baseUrl with bare ?/#, userinfo, or control chars; null region/adapter; and incomplete capabilities", async () => {
    for (const badBase of [
      "https://api.example.com?",
      "https://api.example.com#",
      "http://u:p@127.0.0.1:9",
      "https://api.example.com/\nfoo",
      "https://api.example.com/\tfoo",
    ]) {
      expect(() => twilio({ accountSid: "AC" + "0".repeat(32), authToken: "t", baseUrl: badBase })).toThrow(
        ConfigurationError,
      );
      expect(() => telnyx({ apiKey: "k", baseUrl: badBase })).toThrow(ConfigurationError);
    }

    // @ts-expect-error -- null region
    expect(() => vonage({ apiKey: "k", apiSecret: "s", region: null })).toThrow(ConfigurationError);

    const client = createSmsClient({ adapters: [memory()] });
    // @ts-expect-error -- null adapter
    expect(await rejection(client.getMessage("m1", { adapter: null }))).toBeInstanceOf(ConfigurationError);

    expect(() =>
      createSmsClient({
        adapters: [
          {
            name: "missing-validity",
            // @ts-expect-error -- missing capabilities.validityPeriod
            capabilities: { senderTypes: ["long_code"] },
            support: { status: "supported", notes: [] },
            send: async () => ({ kind: "accepted", providerId: "1", delivery: "queued" }),
          },
        ],
      }),
    ).toThrow(ConfigurationError);
  });

  test("hardens verify helpers, publicUrl, trustProxy host, Request spoofs/bodyUsed, NumMedia cap, and __proto__ idempotency", async () => {
    // Verify helpers refuse empty secrets before reading headers/timestamps
    const _typeCheck: SinchWebhookVerification = { valid: true };
    expect(_typeCheck.valid).toBe(true);
    expect(
      await rejection(verifyTelnyxSignature({ publicKey: "", rawBody: "{}", signature: null, timestamp: null })),
    ).toBeInstanceOf(ConfigurationError);
    expect(
      await rejection(verifyVonageSignature({ signatureSecret: "", authorization: null, rawBody: "{}" })),
    ).toBeInstanceOf(ConfigurationError);
    expect(
      await rejection(
        verifySinchSignature({ webhookSecret: "", rawBody: "{}", signature: null, nonce: null, timestamp: null }),
      ),
    ).toBeInstanceOf(ConfigurationError);

    // Sinch Basic auth checks credentials before reading Authorization header
    let sinchHeaderRead = false;
    const sinchSpyReq = {
      url: "https://example.com/hook",
      method: "POST",
      body: null,
      bodyUsed: false,
      headers: {
        get: (name: string) => {
          if (name.toLowerCase() === "authorization") sinchHeaderRead = true;
          return null;
        },
      },
    } as unknown as Request;
    expect(
      await rejection(
        parseSmsWebhook({
          provider: "sinch",
          request: sinchSpyReq,
          credentials: { kind: "basic", username: "", password: "p" },
        }),
      ),
    ).toBeInstanceOf(ConfigurationError);
    expect(sinchHeaderRead).toBe(false);

    // publicUrl rejects whitespace and fragments on both Twilio and Plivo
    const unsigned = () => new Request("https://example.com/hook?a=1", { method: "POST", body: "{}" });
    for (const provider of ["twilio", "plivo"] as const) {
      for (const badPublicUrl of [" https://example.com/hook", "https://example.com/hook#frag"]) {
        expect(
          await rejection(
            parseSmsWebhook({
              provider,
              request: unsigned(),
              credentials: { authToken: "tok" },
              publicUrl: badPublicUrl,
              unsafeSkipVerification: true,
            }),
          ),
        ).toBeInstanceOf(ConfigurationError);
      }
    }

    // trustProxy rejects host with path/query/fragment/userinfo
    for (const badHost of ["evil.com/extra", "user:pass@evil.com", "evil.com?q=1", "evil.com#frag"]) {
      const req = new Request("https://internal.local/hook", {
        method: "POST",
        headers: { "x-forwarded-host": badHost },
        body: "Body=hi",
      });
      expect(
        await rejection(
          parseSmsWebhook({ provider: "twilio", request: req, credentials: { authToken: "tok" }, trustProxy: true }),
        ),
      ).toBeInstanceOf(WebhookSignatureError);
    }

    // Object.create(Request.prototype) and disturbed bodyUsed Request throw ConfigurationError
    expect(
      await rejection(
        parseSmsWebhook({
          provider: "twilio",
          request: Object.create(Request.prototype) as Request,
          credentials: { authToken: "tok" },
        }),
      ),
    ).toBeInstanceOf(ConfigurationError);

    const disturbed = new Request("https://example.com/hook", { method: "POST", body: "hello" });
    const reader = disturbed.body!.getReader();
    await reader.read();
    reader.releaseLock();
    expect(
      await rejection(parseSmsWebhook({ provider: "twilio", request: disturbed, credentials: { authToken: "tok" } })),
    ).toBeInstanceOf(ConfigurationError);

    // NumMedia huge count is capped and finishes immediately
    const bigMediaReq = new Request("https://example.com/hook", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "MessageSid=SM1&From=%2B14155550123&To=%2B15005550006&Body=hi&NumMedia=100000000",
    });
    const t0 = Date.now();
    const ev = await parseSmsWebhook({
      provider: "twilio",
      request: bigMediaReq,
      credentials: { authToken: "tok" },
      unsafeSkipVerification: true,
    });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(ev.type).toBe("message.received");

    // Empty nestedPrefixes does not infinite-loop; __proto__ adapter name preserves idempotency fingerprint
    const custom = {
      ...memory({ name: "__proto__" }),
      providerOptions: {
        options: { tag: { wire: "tag", type: "string" as const } },
        reserved: [],
        nestedPrefixes: [""],
      },
    };
    const store = memoryIdempotencyStore();
    const protoClient = createSmsClient({ adapters: [custom], idempotency: { store } });
    const first = await protoClient.send({
      to: "+14155550123",
      body: "hi",
      idempotencyKey: "k-proto",
      providerOptions: Object.fromEntries([["__proto__", { tag: "a" }]]),
    });
    expect(first.replayed).toBe(false);
    await expect(
      protoClient.send({
        to: "+14155550123",
        body: "hi",
        idempotencyKey: "k-proto",
        providerOptions: Object.fromEntries([["__proto__", { tag: "b" }]]),
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  test("snapshots beforeSend decision safely, validates adapter specs, and hardens URLs and webhook streams", async () => {
    // 1. Throwing decision.kind getter does not strand idempotency reservation
    const store = memoryIdempotencyStore();
    let allow = false;
    const client = createSmsClient({
      adapters: [memory({ name: "a" })],
      idempotency: { store },
      beforeSend: () =>
        allow
          ? { kind: "allow" }
          : ({
              get kind() {
                throw new Error("getter boom");
              },
            } as unknown as { kind: "allow" }),
    });
    await expect(
      client.send({ to: "+14155550123", body: "hi", from: "+14155550124", idempotencyKey: "k-getter" }),
    ).rejects.toThrow("getter boom");
    expect((await store.get("k-getter"))?.state).toBe("rejected");
    allow = true;
    const retried = await client.send({ to: "+14155550123", body: "hi", from: "+14155550124", idempotencyKey: "k-getter" });
    expect(retried.replayed).toBe(false);

    // Mutating getter returning "deny" then "allow" still fails closed
    let reads = 0;
    const flaky = createSmsClient({
      adapters: [memory({ name: "a" })],
      beforeSend: () =>
        ({
          get kind() {
            reads += 1;
            return reads === 1 ? "deny" : "allow";
          },
        }) as unknown as { kind: "allow" },
    });
    await expect(flaky.send({ to: "+14155550123", body: "hi" })).rejects.toBeInstanceOf(PolicyRejectedError);

    // 2. Unicode whitespace rejected in baseUrl and publicUrl; publicUrl rejects userinfo and bare '?'
    expect(() => twilio({ accountSid: TWILIO_SID, authToken: "tok", baseUrl: "https://example.com/a\u00a0b" })).toThrow(
      ConfigurationError,
    );
    for (const badPublicUrl of [
      "https://example.com/a\u00a0b",
      "https://user:pass@example.com/hook",
      "https://example.com/hook?",
    ]) {
      expect(
        await rejection(
          parseSmsWebhook({
            provider: "twilio",
            request: new Request("https://example.com/hook", { method: "POST", body: "" }),
            credentials: { authToken: "tok" },
            publicUrl: badPublicUrl,
          }),
        ),
      ).toBeInstanceOf(ConfigurationError);
    }

    // 3. Prototype-spoofed body/headers throw ConfigurationError; errored stream throws WebhookPayloadError
    expect(
      await rejection(
        parseSmsWebhook({
          provider: "twilio",
          request: {
            url: "https://example.com/hook",
            method: "POST",
            headers: new Headers(),
            body: Object.create(ReadableStream.prototype),
            bodyUsed: false,
          } as unknown as Request,
          credentials: { authToken: "tok" },
        }),
      ),
    ).toBeInstanceOf(ConfigurationError);

    expect(
      await rejection(
        parseSmsWebhook({
          provider: "twilio",
          request: {
            url: "https://example.com/hook",
            method: "POST",
            headers: Object.create(Headers.prototype),
            body: null,
            bodyUsed: false,
          } as unknown as Request,
          credentials: { authToken: "tok" },
        }),
      ),
    ).toBeInstanceOf(ConfigurationError);

    const brokenStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("client disconnected"));
      },
    });
    const streamErr = await rejection(
      parseSmsWebhook({
        provider: "twilio",
        request: new Request("https://example.com/hook", { method: "POST", body: brokenStream }),
        credentials: { authToken: "tok" },
      }),
    );
    expect(streamErr).toBeInstanceOf(WebhookPayloadError);
    expect((streamErr as WebhookPayloadError).reason).toBe("body_unreadable");

    // 4. verifyTwilioSignature / verifyPlivoSignatureV2 reject empty authToken before URL parsing
    expect(
      await rejection(verifyTwilioSignature({ authToken: "", url: "not-a-url", params: [], signature: "" })),
    ).toBeInstanceOf(ConfigurationError);
    expect(
      await rejection(verifyPlivoSignatureV2({ authToken: "", url: "not-a-url", nonce: "1", signature: "" })),
    ).toBeInstanceOf(ConfigurationError);
    expect(
      await rejection(verifyTwilioSignature({ authToken: "tok", url: "not-a-url", params: [], signature: "" })),
    ).toBeInstanceOf(ConfigurationError);
    expect(
      await rejection(verifyPlivoSignatureV2({ authToken: "tok", url: "not-a-url", nonce: "1", signature: "" })),
    ).toBeInstanceOf(ConfigurationError);

    // 5. createSmsClient validates validityPeriod, senderTypes, and providerOptions spec
    const base = memory({ name: "a" });
    expect(() =>
      createSmsClient({
        adapters: [{ ...base, capabilities: { ...base.capabilities, validityPeriod: { minSec: 0, maxSec: 10 } } }],
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        adapters: [{ ...base, capabilities: { ...base.capabilities, validityPeriod: { minSec: 100, maxSec: 10 } } }],
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        adapters: [
          {
            ...base,
            capabilities: { ...base.capabilities, senderTypes: ["long-code" as unknown as "long_code"] },
          },
        ],
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        adapters: [
          {
            ...base,
            providerOptions: { options: { a: { type: "enum", wire: "a", values: "xyz" } }, reserved: [] } as unknown as NonNullable<
              typeof base.providerOptions
            >,
          },
        ],
      }),
    ).toThrow(ConfigurationError);

    // 6. paramsToRecord keeps __proto__ as own property without mutating prototype; extra.__proto__ is rejected
    const rec = paramsToRecord([
      ["__proto__", "first"],
      ["__proto__", "second"],
    ]);
    expect(Object.hasOwn(rec, "__proto__")).toBe(true);
    expect(rec["__proto__"]).toBe("first");
    expect(Object.getPrototypeOf(rec)).toBe(Object.prototype);

    const extraClient = createSmsClient({
      adapters: [
        {
          ...base,
          providerOptions: { options: {}, reserved: [] },
        },
      ],
    });
    const result = extraClient.validate({
      to: "+14155550123",
      body: "hi",
      providerOptions: { a: { extra: JSON.parse('{"__proto__":"x"}') } } as NonNullable<SmsSendInput["providerOptions"]>,
    });
    expect(result.issues.length).toBeGreaterThan(0);
  });

  test("snapshots send input against post-validation mutation, validates signature helper URLs/IPv6, clones regexes, and hardens spoofed streams", async () => {
    // 1. Post-validation mutation of mediaUrls, sendAt, or getters cannot bypass validation
    let receivedMedia: readonly string[] = [];
    let receivedSendAt: Date | undefined;
    let receivedTo = "";
    const base = memory({ name: "a" });
    const spy = {
      ...base,
      capabilities: { ...base.capabilities, mms: true, scheduling: true },
      send: async (msg: Parameters<typeof base.send>[0], ctx: Parameters<typeof base.send>[1]) => {
        receivedMedia = msg.mediaUrls;
        receivedSendAt = msg.sendAt;
        receivedTo = msg.to;
        return base.send(msg, ctx);
      },
    };
    const sms = createSmsClient({
      adapters: [spy],
      beforeSend: ({ message }) => {
        message.sendAt?.setTime(Number.NaN);
        return { kind: "allow" };
      },
    });
    const mediaUrls = ["https://example.com/ok.png"];
    const sendAt = new Date(Date.now() + 600_000);
    const originalTime = sendAt.getTime();
    let toReads = 0;
    const tricky = {
      get to() {
        toReads += 1;
        return (toReads === 1 ? "+14155550123" : "not-a-number") as "+14155550123";
      },
      body: "hi",
      mediaUrls,
      sendAt,
    } satisfies SmsSendInput;
    const p = sms.send(tricky);
    mediaUrls.push("javascript:alert(1)");
    sendAt.setTime(Number.NaN);
    await p;
    expect(receivedMedia).toEqual(["https://example.com/ok.png"]);
    expect(receivedSendAt?.getTime()).toBe(originalTime);
    expect(receivedTo).toBe("+14155550123");

    // 2. computeTwilioSignature / verifyTwilioSignature / Plivo helpers reject invalid & non-http(s) URLs and handle IPv6
    for (const badUrl of ["not-a-url", "", "ftp://example.com/hook", "file:///etc/passwd"]) {
      expect(await rejection(computeTwilioSignature({ authToken: "tok", url: badUrl, params: [] }))).toBeInstanceOf(
        ConfigurationError,
      );
      expect(
        await rejection(verifyTwilioSignature({ authToken: "tok", url: badUrl, params: [], signature: "x" })),
      ).toBeInstanceOf(ConfigurationError);
      expect(await rejection(computePlivoSignatureV2({ authToken: "tok", url: badUrl, nonce: "1" }))).toBeInstanceOf(
        ConfigurationError,
      );
      expect(
        await rejection(verifyPlivoSignatureV2({ authToken: "tok", url: badUrl, nonce: "1", signature: "x" })),
      ).toBeInstanceOf(ConfigurationError);
    }
    const ipv6Sig = await computeTwilioSignature({
      authToken: "tok",
      url: "https://[::1]:443/hook",
      params: [["a", "1"]],
    });
    expect(
      await verifyTwilioSignature({
        authToken: "tok",
        url: "https://[::1]/hook",
        params: [["a", "1"]],
        signature: ipv6Sig,
      }),
    ).toBe(true);

    // 3. Empty userinfo (@) rejected in baseUrl and publicUrl; trustProxy rejects \p{Cf} and "." / ".."
    expect(() => twilio({ accountSid: TWILIO_SID, authToken: "tok", baseUrl: "https://@example.com" })).toThrow(
      ConfigurationError,
    );
    expect(
      await rejection(
        parseSmsWebhook({
          provider: "twilio",
          request: new Request("https://example.com/hook", { method: "POST", body: "" }),
          publicUrl: "https://@example.com/hook",
          credentials: { authToken: "tok" },
        }),
      ),
    ).toBeInstanceOf(ConfigurationError);
    for (const badHost of ["evil.com\u200B", ".", ".."]) {
      const hdrs = new Map([
        ["x-forwarded-proto", "https"],
        ["x-forwarded-host", badHost],
      ]);
      expect(
        await rejection(
          parseSmsWebhook({
            provider: "twilio",
            request: {
              url: "https://example.com/hook",
              method: "POST",
              headers: { get: (k: string) => hdrs.get(k.toLowerCase()) ?? null },
              body: null,
              bodyUsed: false,
            } as unknown as Request,
            trustProxy: true,
            credentials: { authToken: "tok" },
          }),
        ),
      ).toBeInstanceOf(WebhookSignatureError);
    }

    // 4. Prototype-spoofed ReadableStream with own locked: false throws ConfigurationError
    const fakeStream = Object.create(ReadableStream.prototype);
    Object.defineProperty(fakeStream, "locked", { value: false, configurable: true });
    expect(
      await rejection(
        parseSmsWebhook({
          provider: "twilio",
          request: {
            url: "https://example.com/hook",
            method: "POST",
            headers: new Headers(),
            body: fakeStream,
            bodyUsed: false,
          } as unknown as Request,
          credentials: { authToken: "tok" },
        }),
      ),
    ).toBeInstanceOf(ConfigurationError);

    // 5. Stateful /g regex in providerOptions works repeatedly across sends
    const regexClient = createSmsClient({
      adapters: [
        {
          ...base,
          providerOptions: {
            options: { tag: { type: "string", wire: "tag", pattern: /^ok$/g } },
            reserved: [],
          },
        },
      ],
    });
    await regexClient.send({
      to: "+14155550123",
      body: "1",
      providerOptions: { a: { tag: "ok" } } as NonNullable<SmsSendInput["providerOptions"]>,
    });
    await regexClient.send({
      to: "+14155550123",
      body: "2",
      providerOptions: { a: { tag: "ok" } } as NonNullable<SmsSendInput["providerOptions"]>,
    });

    // 6. Throwing options Proxy throws ConfigurationError
    expect(
      await rejection(
        parseSmsWebhook(
          new Proxy({} as never, {
            get() {
              throw new Error("proxy boom");
            },
          }),
        ),
      ),
    ).toBeInstanceOf(ConfigurationError);
  });

  test("preserves class-getter senders/credentials, rejects non-plain providerOptions and RegExp/Date spoofs, and freezes client/factory options", async () => {
    // 1. Class-getter sender works in validate() and send(), and unrelated throwing getters are never read
    class BrandSender {
      get senderId() {
        return "BRAND";
      }
      get unrelated() {
        throw new Error("should not be read");
      }
    }
    const base = memory({ name: "a" });
    const alphaClient = createSmsClient({
      adapters: [
        {
          ...base,
          capabilities: { ...base.capabilities, senderTypes: ["long_code", "alphanumeric"] },
        },
      ],
    });
    const sender = new BrandSender() as unknown as NonNullable<SmsSendInput["from"]>;
    expect(alphaClient.validate({ to: "+447700900123", body: "hi", from: sender }).supported).toBe(true);
    const sent = await alphaClient.send({ to: "+447700900123", body: "hi", from: sender });
    expect(sent.providerId).toBeTruthy();

    // 2. Revoked Proxy or throwing to getter returns issues in validate() and InvalidMessageError in send()
    const revoked = Proxy.revocable({ to: "+14155550123", body: "hi" }, {});
    revoked.revoke();
    expect(alphaClient.validate(revoked.proxy as unknown as SmsSendInput).issues.length).toBeGreaterThan(0);
    expect(await rejection(alphaClient.send(revoked.proxy as unknown as SmsSendInput))).toBeInstanceOf(
      InvalidMessageError,
    );

    const throwingTo = {
      get to(): string {
        throw new Error("to boom");
      },
      body: "hi",
    } as unknown as SmsSendInput;
    expect(alphaClient.validate(throwingTo).issues.length).toBeGreaterThan(0);
    expect(await rejection(alphaClient.send(throwingTo))).toBeInstanceOf(InvalidMessageError);

    // 3. beforeSend cannot be mutated or disabled after client creation
    let policyCalled = 0;
    const clientOpts: Parameters<typeof createSmsClient>[0] = {
      adapters: [memory({ name: "a" })],
      beforeSend: () => {
        policyCalled += 1;
        return { kind: "reject", reason: "blocked" };
      },
    };
    const lockedClient = createSmsClient(clientOpts);
    (clientOpts as { beforeSend?: unknown }).beforeSend = undefined;
    expect(await rejection(lockedClient.send({ to: "+14155550123", body: "hi" }))).toBeInstanceOf(PolicyRejectedError);
    expect(policyCalled).toBe(1);

    // 4. Non-plain providerOptions entry (class instance) returns invalid_field; RegExp subclass throwing source/flags is caught
    class CustomOpts {
      shortenUrls = true;
    }
    const twilioClient = createSmsClient({
      adapters: [twilio({ accountSid: TWILIO_SID, authToken: "tok", from: "+15005550006" })],
    });
    const nonPlain = twilioClient.validate({
      to: "+14155550123",
      body: "hi",
      providerOptions: { twilio: new CustomOpts() as unknown as Record<string, unknown> },
    });
    expect(nonPlain.issues.some((i) => i.code === "invalid_field")).toBe(true);

    // Object.create(Date.prototype) is rejected as invalid_field
    const fakeDate = Object.create(Date.prototype) as Date;
    const schedClient = createSmsClient({
      adapters: [{ ...base, capabilities: { ...base.capabilities, scheduling: true } }],
    });
    expect(
      schedClient.validate({ to: "+14155550123", body: "hi", sendAt: fakeDate }).issues.length,
    ).toBeGreaterThan(0);

    // RegExp subclass with throwing source/flags getters
    class EvilRegExp extends RegExp {
      override get source(): string {
        throw new Error("source boom");
      }
      override get flags(): string {
        throw new Error("flags boom");
      }
    }
    const evilReClient = createSmsClient({
      adapters: [
        {
          ...base,
          providerOptions: {
            options: { tag: { type: "string", wire: "tag", pattern: new EvilRegExp("^ok$") } },
            reserved: [],
          },
        },
      ],
    });
    expect(
      evilReClient.validate({
        to: "+14155550123",
        body: "hi",
        providerOptions: { a: { tag: "ok" } } as NonNullable<SmsSendInput["providerOptions"]>,
      }).supported,
    ).toBe(true);

    // 5. Class-getter webhook credentials work; single-event parseSmsWebhooks reads provider once; non-string signature returns { valid: false }
    class TwilioCreds {
      get authToken() {
        return "tok";
      }
    }
    const sigUrl = "https://example.com/hook";
    const sig = await computeTwilioSignature({
      authToken: "tok",
      url: sigUrl,
      params: [
        ["MessageSid", "SM1"],
        ["From", "+14155550123"],
        ["To", "+15005550006"],
        ["Body", "hi"],
      ],
    });
    const signedReq = new Request(sigUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": sig,
      },
      body: "MessageSid=SM1&From=%2B14155550123&To=%2B15005550006&Body=hi",
    });
    const parsedFromClassCreds = await parseSmsWebhook({
      provider: "twilio",
      request: signedReq,
      credentials: new TwilioCreds(),
    });
    expect(parsedFromClassCreds.type).toBe("message.received");

    let providerReads = 0;
    const singleReadReq = new Request(sigUrl, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": sig,
      },
      body: "MessageSid=SM1&From=%2B14155550123&To=%2B15005550006&Body=hi",
    });
    const { parseSmsWebhooks } = await import("../../src/webhooks/index.js");
    const many = await parseSmsWebhooks({
      get provider() {
        providerReads += 1;
        return "twilio" as const;
      },
      request: singleReadReq,
      credentials: { authToken: "tok" },
    });
    expect(many).toHaveLength(1);
    expect(providerReads).toBe(1);

    // Spoofed Headers.get returning non-string (5) fails closed with ConfigurationError
    expect(
      await rejection(
        parseSmsWebhook({
          provider: "twilio",
          request: {
            url: "https://example.com/hook",
            method: "POST",
            headers: { get: (name: string) => (name.toLowerCase() === "x-forwarded-host" ? 5 : null) },
            body: null,
            bodyUsed: false,
          } as unknown as Request,
          trustProxy: true,
          credentials: { authToken: "tok" },
        }),
      ),
    ).toBeInstanceOf(ConfigurationError);

    // verifyTelnyxSignature / verifySinchSignature with undefined signature return { valid: false }
    expect(
      await verifyTelnyxSignature({
        publicKey: "a".repeat(44),
        rawBody: "{}",
        signature: undefined as unknown as string,
        timestamp: String(Math.floor(Date.now() / 1000)),
      }),
    ).toMatchObject({ valid: false });
    expect(
      await verifySinchSignature({
        webhookSecret: "sec",
        rawBody: "{}",
        signature: undefined as unknown as string,
        nonce: "n",
        timestamp: String(Math.floor(Date.now() / 1000)),
      }),
    ).toMatchObject({ valid: false });

    // Canonical URL checks in verifyTwilioSignature / verifyPlivoSignatureV2
    for (const bad of ["https://user:pass@example.com/hook", "https://example.com/hook#frag", "https://example.com/a\u00a0b"]) {
      expect(
        await rejection(verifyTwilioSignature({ authToken: "tok", url: bad, params: [], signature: "x" })),
      ).toBeInstanceOf(ConfigurationError);
      expect(
        await rejection(verifyPlivoSignatureV2({ authToken: "tok", url: bad, nonce: "1", signature: "x" })),
      ).toBeInstanceOf(ConfigurationError);
    }

    // 6. bandwidth & telnyx capture applicationId / messagingProfileId at factory time
    let sentAppId = "";
    const bwOpts = {
      userId: "acc",
      applicationId: "app-original",
      apiToken: "u",
      apiSecret: "p",
      from: "+15005550006" as const,
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentAppId = JSON.parse(String(init?.body ?? "{}")).applicationId;
        return new Response(JSON.stringify({ id: "bw1" }), { status: 202 });
      },
    };
    const bwAdapter = bandwidth(bwOpts);
    bwOpts.applicationId = "app-mutated";
    await createSmsClient({ adapters: [bwAdapter] }).send({ to: "+14155550123", body: "hi" });
    expect(sentAppId).toBe("app-original");

    let sentProfileId = "";
    const txOpts = {
      apiKey: "key",
      messagingProfileId: "prof-original",
      from: "+15005550006" as const,
      fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
        sentProfileId = JSON.parse(String(init?.body ?? "{}")).messaging_profile_id;
        return new Response(JSON.stringify({ data: { id: "tx1" } }), { status: 200 });
      },
    };
    const txAdapter = telnyx(txOpts);
    txOpts.messagingProfileId = "prof-mutated";
    await createSmsClient({ adapters: [txAdapter] }).send({ to: "+14155550123", body: "hi" });
    expect(sentProfileId).toBe("prof-original");
  });
});
