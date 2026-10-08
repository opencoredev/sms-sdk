import { describe, expect, test } from "bun:test";
import { WebhookPayloadError, WebhookSignatureError } from "../../src/core/errors.js";
import { parseSmsWebhook } from "../../src/webhooks/index.js";
import { computeTwilioSignature, verifyTwilioSignature } from "../../src/webhooks/twilio.js";
import { signedTwilioRequest } from "../../src/testing/webhooks.js";
import { rejection, TWILIO_MESSAGE_SID } from "../helpers.js";

const AUTH_TOKEN = "twilio-auth-token";
const URL_PUBLIC = "https://example.com/webhooks/twilio";

const inboundParams = {
  MessageSid: TWILIO_MESSAGE_SID,
  SmsSid: TWILIO_MESSAGE_SID,
  AccountSid: "AC0123456789abcdef0123456789abcdef",
  From: "+14155550123",
  To: "+15005550006",
  Body: "Hello there",
  NumMedia: "0",
  NumSegments: "1",
  SmsStatus: "received",
};

const parse = (request: Request, extra: { publicUrl?: string; trustProxy?: boolean } = {}) =>
  parseSmsWebhook({ provider: "twilio", request, credentials: { authToken: AUTH_TOKEN }, ...extra });

describe("Twilio signature", () => {
  test("matches Twilio's published example", async () => {
    const signature = await computeTwilioSignature({
      authToken: "12345",
      url: "https://example.com/myapp.php?foo=1&bar=2",
      params: [
        ["Digits", "1234"],
        ["To", "+18005551212"],
        ["From", "+14158675310"],
        ["Caller", "+14158675310"],
        ["CallSid", "CA1234567890ABCDE"],
      ],
    });
    expect(signature).toBe("L/OH5YylLD5NRKLltdqwSvS0BnU=");
  });

  test("sorts repeated parameter values", async () => {
    const a = await computeTwilioSignature({ authToken: "t", url: URL_PUBLIC, params: [["M", "b"], ["M", "a"]] });
    const b = await computeTwilioSignature({ authToken: "t", url: URL_PUBLIC, params: [["M", "a"], ["M", "b"]] });
    expect(a).toBe(b);
  });

  test("accepts the URL with or without the default port", async () => {
    const params: Array<[string, string]> = [["A", "1"]];
    const withPort = await computeTwilioSignature({ authToken: "t", url: "https://example.com:443/hook", params });
    expect(await verifyTwilioSignature({ authToken: "t", url: "https://example.com/hook", params, signature: withPort })).toBe(true);
    const without = await computeTwilioSignature({ authToken: "t", url: "https://example.com/hook", params });
    expect(await verifyTwilioSignature({ authToken: "t", url: "https://example.com:443/hook", params, signature: without })).toBe(true);
  });
});

describe("parse Twilio webhooks", () => {
  test("normalizes an inbound message", async () => {
    const event = await parse(await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: inboundParams }));
    expect(event).toMatchObject({
      type: "message.received",
      provider: "twilio",
      providerId: TWILIO_MESSAGE_SID,
      from: "+14155550123",
      to: "+15005550006",
      body: "Hello there",
      mediaUrls: [],
      dedupeKey: `twilio:${TWILIO_MESSAGE_SID}:received`,
    });
    expect(event.raw).toMatchObject({ AccountSid: "AC0123456789abcdef0123456789abcdef" });
  });

  test("collects inbound media URLs", async () => {
    const params = { ...inboundParams, NumMedia: "2", MediaUrl0: "https://api.twilio.com/m0", MediaUrl1: "https://api.twilio.com/m1" };
    const event = await parse(await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params }));
    expect(event.type === "message.received" && event.mediaUrls).toEqual(["https://api.twilio.com/m0", "https://api.twilio.com/m1"]);
  });

  test.each([
    ["queued", "message.queued"],
    ["sent", "message.sent"],
    ["delivered", "message.delivered"],
    ["undelivered", "message.undelivered"],
    ["failed", "message.undelivered"],
  ] as const)("status %s maps to %s", async (status, type) => {
    const params = { MessageSid: TWILIO_MESSAGE_SID, MessageStatus: status, From: "+15005550006", To: "+14155550123" };
    const event = await parse(await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params }));
    expect(event).toMatchObject({ type, providerId: TWILIO_MESSAGE_SID, providerStatus: status, dedupeKey: `twilio:${TWILIO_MESSAGE_SID}:${status}` });
  });

  test("undelivered with error 30007 is filtered", async () => {
    const params = { MessageSid: TWILIO_MESSAGE_SID, MessageStatus: "undelivered", ErrorCode: "30007" };
    const event = await parse(await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params }));
    expect(event).toMatchObject({ type: "message.filtered", errorCode: "30007" });
  });

  test("other error codes stay undelivered", async () => {
    const params = { MessageSid: TWILIO_MESSAGE_SID, MessageStatus: "undelivered", ErrorCode: "30003" };
    const event = await parse(await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params }));
    expect(event).toMatchObject({ type: "message.undelivered", errorCode: "30003" });
  });

  test("unmapped statuses are unrecognized, not errors", async () => {
    const params = { MessageSid: TWILIO_MESSAGE_SID, MessageStatus: "read" };
    const event = await parse(await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params }));
    expect(event).toMatchObject({ type: "unrecognized", providerEventType: "read" });
  });

  test.each([
    ["STOP", "recipient.opted_out"],
    ["HELP", "recipient.help"],
    ["START", "recipient.opted_in"],
  ] as const)("OptOutType %s is a provider-declared %s", async (optOutType, type) => {
    const params = { ...inboundParams, Body: "please stop", OptOutType: optOutType };
    const event = await parse(await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params }));
    expect(event).toMatchObject({ type, source: "provider", keyword: optOutType, body: "please stop", from: "+14155550123" });
  });

  test("a STOP body without OptOutType is keyword-derived", async () => {
    const event = await parse(await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: { ...inboundParams, Body: " stop! " } }));
    expect(event).toMatchObject({ type: "recipient.opted_out", source: "keyword", keyword: "STOP", body: " stop! " });
  });

  test("keyword detection can be turned off", async () => {
    const request = await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: { ...inboundParams, Body: "STOP" } });
    const event = await parseSmsWebhook({ provider: "twilio", request, credentials: { authToken: AUTH_TOKEN }, detectKeywords: false });
    expect(event.type).toBe("message.received");
  });

  test("new fields Twilio adds are verified and ignored", async () => {
    const params = { ...inboundParams, FutureField: "x", ToCountry: "US", ButtonPayload: "" };
    const event = await parse(await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params }));
    expect(event.type).toBe("message.received");
  });

  test("a duplicate delivery has the same dedupe key", async () => {
    const first = await parse(await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: inboundParams }));
    const second = await parse(await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: inboundParams }));
    expect(second.dedupeKey).toBe(first.dedupeKey);
  });
});

describe("Twilio verification failures", () => {
  test("a tampered body is rejected", async () => {
    const signed = await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: inboundParams });
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: new URLSearchParams({ ...inboundParams, Body: "Hello therf" }).toString(),
    });
    const error = await rejection(parse(tampered));
    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect(error).toMatchObject({ reason: "invalid_signature", providerName: "twilio" });
  });

  test("the wrong auth token is rejected", async () => {
    const request = await signedTwilioRequest({ authToken: "other-token", url: URL_PUBLIC, params: inboundParams });
    await expect(parse(request)).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  test("a missing signature header is rejected", async () => {
    const request = new Request(URL_PUBLIC, { method: "POST", body: new URLSearchParams(inboundParams).toString() });
    const error = await rejection(parse(request));
    expect(error).toMatchObject({ reason: "missing_signature" });
  });

  test("verification runs before parsing: a forged, malformed payload is a signature error", async () => {
    const request = new Request(URL_PUBLIC, { method: "POST", headers: { "x-twilio-signature": "forged" }, body: "garbage" });
    await expect(parse(request)).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  test("an authentic payload without MessageSid is a payload error", async () => {
    const request = await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: { Body: "hi" } });
    await expect(parse(request)).rejects.toBeInstanceOf(WebhookPayloadError);
  });

  test("unsafeSkipVerification parses unsigned requests (tests only)", async () => {
    const request = new Request(URL_PUBLIC, { method: "POST", body: new URLSearchParams(inboundParams).toString() });
    const event = await parseSmsWebhook({ provider: "twilio", request, credentials: { authToken: "unused" }, unsafeSkipVerification: true });
    expect(event.type).toBe("message.received");
  });
});

describe("Twilio URL handling behind proxies", () => {
  const internalUrl = "http://10.0.0.5:3000/webhooks/twilio";

  async function internalRequest(headers: Record<string, string> = {}): Promise<Request> {
    const signed = await signedTwilioRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: inboundParams });
    const merged = new Headers(signed.headers);
    for (const [name, value] of Object.entries(headers)) {
      merged.set(name, value);
    }
    return new Request(internalUrl, {
      method: "POST",
      headers: merged,
      body: new URLSearchParams(inboundParams).toString(),
    });
  }

  test("fails when the internal URL differs from the signed URL", async () => {
    await expect(parse(await internalRequest())).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  test("publicUrl fixes the mismatch", async () => {
    await expect(parse(await internalRequest(), { publicUrl: URL_PUBLIC })).resolves.toMatchObject({ type: "message.received" });
  });

  test("forwarded headers are ignored unless trustProxy is set", async () => {
    const request = await internalRequest({ "x-forwarded-proto": "https", "x-forwarded-host": "example.com" });
    await expect(parse(request)).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  test("trustProxy builds the URL from forwarded headers", async () => {
    const request = await internalRequest({ "x-forwarded-proto": "https", "x-forwarded-host": "example.com" });
    await expect(parse(request, { trustProxy: true })).resolves.toMatchObject({ type: "message.received" });
  });

  test("publicUrl keeps the request query string", async () => {
    const signedUrl = `${URL_PUBLIC}?tenant=42`;
    const signed = await signedTwilioRequest({ authToken: AUTH_TOKEN, url: signedUrl, params: inboundParams });
    const request = new Request("http://10.0.0.5:3000/webhooks/twilio?tenant=42", {
      method: "POST",
      headers: signed.headers,
      body: new URLSearchParams(inboundParams).toString(),
    });
    await expect(parse(request, { publicUrl: URL_PUBLIC })).resolves.toMatchObject({ type: "message.received" });
  });
});

describe("Twilio JSON bodies (bodySHA256)", () => {
  const body = '{"MessageSid":"SM0123456789abcdef0123456789abcdef","MessageStatus":"delivered"}';

  async function jsonRequest(rawBody: string, hashOf: string = rawBody): Promise<Request> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(hashOf)));
    const hash = [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const url = `${URL_PUBLIC}?bodySHA256=${hash}`;
    const signature = await computeTwilioSignature({ authToken: AUTH_TOKEN, url, params: [] });
    return new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-twilio-signature": signature },
      body: rawBody,
    });
  }

  test("verifies the body hash and the URL signature", async () => {
    await expect(parse(await jsonRequest(body))).resolves.toMatchObject({ type: "message.delivered" });
  });

  test("rejects a body that does not match bodySHA256", async () => {
    const error = await rejection(parse(await jsonRequest(body.replace("delivered", "failed"), body)));
    expect(error).toMatchObject({ reason: "body_hash_mismatch" });
  });

  test("checks the signature before parsing malformed JSON", async () => {
    const malformed = '{"MessageSid":';
    const signed = await jsonRequest(malformed);
    const forged = new Request(signed.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-twilio-signature": "AAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
      body: malformed,
    });
    const error = await rejection(parse(forged));
    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect(error).toMatchObject({ reason: "invalid_signature" });
  });

  test("checks the body hash before parsing malformed JSON", async () => {
    const error = await rejection(parse(await jsonRequest('{"MessageSid":', body)));
    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect(error).toMatchObject({ reason: "body_hash_mismatch" });
  });

  test("reports malformed JSON only after verification passes", async () => {
    const error = await rejection(parse(await jsonRequest('{"MessageSid":')));
    expect(error).toBeInstanceOf(WebhookPayloadError);
  });

  test("matches Twilio's published body hash example", async () => {
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode('{"CallSid":"CA1234567890ABCDE","Caller":"+12349013030"}')),
    );
    expect([...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("")).toBe(
      "5ccde7145dfb8f56479710896586cb9d5911809d83afbe34627818790db0aec9",
    );
  });
});

describe("Twilio GET callbacks", () => {
  test("verifies the signature over the full query URL", async () => {
    const url = `${URL_PUBLIC}?${new URLSearchParams(inboundParams).toString()}`;
    const signature = await computeTwilioSignature({ authToken: AUTH_TOKEN, url, params: [] });
    const request = new Request(url, { method: "GET", headers: { "x-twilio-signature": signature } });
    await expect(parse(request)).resolves.toMatchObject({ type: "message.received", body: "Hello there" });
  });
});
