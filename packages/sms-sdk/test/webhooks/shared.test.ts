import { afterEach, describe, expect, test } from "bun:test";
import { ConfigurationError, WebhookPayloadError, WebhookSignatureError } from "../../src/core/errors.js";
import { generateTelnyxKeyPair, signedPlivoRequest, signedTwilioRequest } from "../../src/testing/webhooks.js";
import { parseSmsWebhook, parseSmsWebhooks, type ParseSmsWebhookOptions } from "../../src/webhooks/index.js";
import { MAX_WEBHOOK_BYTES, resolveSignedUrl } from "../../src/webhooks/shared.js";
import { TWILIO_MESSAGE_SID } from "../helpers.js";

const AUTH_TOKEN = "twilio-auth-token";
const inboundParams = {
  MessageSid: TWILIO_MESSAGE_SID,
  AccountSid: "AC0123456789abcdef0123456789abcdef",
  From: "+14155550123",
  To: "+15005550006",
  Body: "Hello there",
  NumMedia: "0",
};

describe("unsafeSkipVerification in production", () => {
  const originalNodeEnv = process.env["NODE_ENV"];
  afterEach(() => {
    if (originalNodeEnv === undefined) {
      delete process.env["NODE_ENV"];
    } else {
      process.env["NODE_ENV"] = originalNodeEnv;
    }
  });

  const unsigned = (body: string): Request => new Request("https://example.com/hook", { method: "POST", body });
  const form = new URLSearchParams(inboundParams).toString();

  async function everyProvider(): Promise<ParseSmsWebhookOptions[]> {
    const { publicKey } = await generateTelnyxKeyPair();
    const basic = { username: "u", password: "p" };
    return [
      { provider: "twilio", request: unsigned(form), credentials: { authToken: AUTH_TOKEN }, unsafeSkipVerification: true },
      { provider: "telnyx", request: unsigned("{}"), credentials: { publicKey }, unsafeSkipVerification: true },
      { provider: "plivo", request: unsigned(form), credentials: { authToken: "plivo-token" }, unsafeSkipVerification: true },
      { provider: "vonage", request: unsigned("{}"), credentials: { signatureSecret: "vonage-secret" }, unsafeSkipVerification: true },
      { provider: "bandwidth", request: unsigned("[]"), credentials: basic, unsafeSkipVerification: true },
      { provider: "sinch", request: unsigned("{}"), credentials: { kind: "basic", ...basic }, unsafeSkipVerification: true },
    ];
  }

  test("every provider refuses it when NODE_ENV is production (case-insensitive) even with an oversized body", async () => {
    process.env["NODE_ENV"] = "PRODUCTION";
    for (const options of await everyProvider()) {
      await expect(parseSmsWebhook(options)).rejects.toBeInstanceOf(ConfigurationError);
    }
    for (const options of await everyProvider()) {
      await expect(parseSmsWebhooks(options)).rejects.toBeInstanceOf(ConfigurationError);
    }
    const oversized = new Request("https://example.com/hook", {
      method: "POST",
      headers: { "content-length": String(MAX_WEBHOOK_BYTES + 1) },
      body: "{}",
    });
    await expect(
      parseSmsWebhook({ provider: "twilio", request: oversized, credentials: { authToken: AUTH_TOKEN }, unsafeSkipVerification: true }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  test("it still works outside production", async () => {
    process.env["NODE_ENV"] = "test";
    const event = await parseSmsWebhook({
      provider: "twilio",
      request: unsigned(form),
      credentials: { authToken: "unused" },
      unsafeSkipVerification: true,
    });
    expect(event.type).toBe("message.received");
  });

  test("verification still runs in production when the flag is off", async () => {
    process.env["NODE_ENV"] = "production";
    const request = unsigned(form);
    await expect(parseSmsWebhook({ provider: "twilio", request, credentials: { authToken: AUTH_TOKEN } })).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
  });
});

describe("forged X-Forwarded-Host without trustProxy", () => {
  // An attacker replays a request Twilio signed for another URL on the same
  // account, and sets X-Forwarded-Host so the signed URL would match if the
  // parser believed the header.
  const signedFor = "https://other-app.example.com/webhooks/twilio";
  const receivedAt = "https://app.example.com/webhooks/twilio";

  async function replay(): Promise<Request> {
    const signed = await signedTwilioRequest({ authToken: AUTH_TOKEN, url: signedFor, params: inboundParams });
    const headers = new Headers(signed.headers);
    headers.set("x-forwarded-host", "other-app.example.com");
    headers.set("x-forwarded-proto", "https");
    return new Request(receivedAt, { method: "POST", headers, body: new URLSearchParams(inboundParams).toString() });
  }

  test("resolveSignedUrl ignores forwarded headers unless trustProxy is true", async () => {
    const request = await replay();
    expect(resolveSignedUrl(request, {})).toBe(receivedAt);
    expect(resolveSignedUrl(request, { trustProxy: false })).toBe(receivedAt);
    expect(resolveSignedUrl(request, { trustProxy: true })).toBe(signedFor);
  });

  test.each([[undefined], [false]])("Twilio rejects the replay with trustProxy %p", async (trustProxy) => {
    const request = await replay();
    const options: ParseSmsWebhookOptions = {
      provider: "twilio",
      request,
      credentials: { authToken: AUTH_TOKEN },
      ...(trustProxy === undefined ? {} : { trustProxy }),
    };
    await expect(parseSmsWebhook(options)).rejects.toMatchObject({ code: "webhook_signature", reason: "invalid_signature" });
  });

  test("Plivo rejects the same replay with trustProxy false", async () => {
    const signed = await signedPlivoRequest({ authToken: "plivo-token", url: "https://other-app.example.com/webhooks/plivo", params: inboundParams });
    const headers = new Headers(signed.headers);
    headers.set("x-forwarded-host", "other-app.example.com");
    headers.set("x-forwarded-proto", "https");
    const request = new Request("https://app.example.com/webhooks/plivo", { method: "POST", headers, body: new URLSearchParams(inboundParams).toString() });
    await expect(
      parseSmsWebhook({ provider: "plivo", request, credentials: { authToken: "plivo-token" }, trustProxy: false }),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});

describe("webhook body size limit", () => {
  test("rejects oversized streamed webhook bodies before verification with WebhookPayloadError", async () => {
    let cancelled = false;
    let emitted = 0;
    const chunk = new Uint8Array(256 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += chunk.byteLength;
        controller.enqueue(chunk);
        if (emitted > MAX_WEBHOOK_BYTES + chunk.byteLength * 2) {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("https://example.com/hook", { method: "POST", body: stream });
    await expect(
      parseSmsWebhook({ provider: "twilio", request, credentials: { authToken: AUTH_TOKEN } }),
    ).rejects.toBeInstanceOf(WebhookPayloadError);
    expect(cancelled).toBe(true);
  });

  test("rejects requests whose Content-Length exceeds MAX_WEBHOOK_BYTES", async () => {
    const request = new Request("https://example.com/hook", {
      method: "POST",
      headers: { "content-length": String(MAX_WEBHOOK_BYTES + 1) },
      body: "{}",
    });
    await expect(
      parseSmsWebhooks({ provider: "bandwidth", request, credentials: { username: "u", password: "p" } }),
    ).rejects.toMatchObject({ code: "webhook_payload", reason: "body_too_large" });
  });
});
