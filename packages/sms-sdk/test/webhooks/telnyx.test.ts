import { beforeAll, describe, expect, test } from "bun:test";
import { WebhookPayloadError, WebhookSignatureError } from "../../src/core/errors.js";
import { toBase64 } from "../../src/core/crypto.js";
import { parseSmsWebhook } from "../../src/webhooks/index.js";
import { verifyTelnyxSignature } from "../../src/webhooks/telnyx.js";
import { generateTelnyxKeyPair, signedTelnyxRequest } from "../../src/testing/webhooks.js";
import { rejection } from "../helpers.js";

const URL_PUBLIC = "https://example.com/webhooks/telnyx";
let keys: { privateKey: CryptoKey; publicKey: string };
let otherKeys: { privateKey: CryptoKey; publicKey: string };

beforeAll(async () => {
  keys = await generateTelnyxKeyPair();
  otherKeys = await generateTelnyxKeyPair();
});

function envelope(eventType: string, payload: Record<string, unknown>, id = "evt-1"): unknown {
  return {
    data: {
      event_type: eventType,
      id,
      occurred_at: "2026-10-08T12:00:00.000+00:00",
      payload: { id: "msg-1", ...payload },
      record_type: "event",
    },
    meta: { attempt: 1, delivered_to: URL_PUBLIC },
  };
}

const inbound = envelope("message.received", {
  direction: "inbound",
  from: { phone_number: "+14155550123", carrier: "T-Mobile" },
  to: [{ phone_number: "+15005550006", status: "webhook_delivered" }],
  text: "Hi from a phone",
  media: [{ url: "https://media.telnyx.com/a.jpg", content_type: "image/jpeg" }],
  type: "MMS",
});

const parse = (request: Request, toleranceSec?: number, now?: () => number) =>
  parseSmsWebhook({
    provider: "telnyx",
    request,
    credentials: { publicKey: keys.publicKey },
    ...(toleranceSec === undefined ? {} : { toleranceSec }),
    ...(now === undefined ? {} : { now }),
  });

describe("parse Telnyx webhooks", () => {
  test("normalizes an inbound message", async () => {
    const event = await parse(await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body: inbound }));
    expect(event).toMatchObject({
      type: "message.received",
      provider: "telnyx",
      providerId: "msg-1",
      from: "+14155550123",
      to: "+15005550006",
      body: "Hi from a phone",
      mediaUrls: ["https://media.telnyx.com/a.jpg"],
      dedupeKey: "telnyx:evt-1",
    });
    expect(event.occurredAt?.toISOString()).toBe("2026-10-08T12:00:00.000Z");
  });

  test.each([
    ["message.sent", "sent", "message.sent"],
    ["message.sent", "queued", "message.queued"],
    ["message.finalized", "delivered", "message.delivered"],
    ["message.finalized", "delivery_unconfirmed", "message.sent"],
    ["message.finalized", "delivery_failed", "message.undelivered"],
    ["message.finalized", "sending_failed", "message.undelivered"],
  ] as const)("%s with status %s maps to %s", async (eventType, status, type) => {
    const body = envelope(eventType, {
      direction: "outbound",
      from: { phone_number: "+15005550006" },
      to: [{ phone_number: "+14155550123", status }],
    });
    const event = await parse(await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body }));
    expect(event).toMatchObject({ type, providerId: "msg-1", providerStatus: status, to: "+14155550123" });
  });

  test("a spam-filter error code maps to filtered", async () => {
    const body = envelope("message.finalized", {
      to: [{ phone_number: "+14155550123", status: "delivery_failed" }],
      errors: [{ code: "40002", title: "Blocked as spam - temporary" }],
    });
    const event = await parse(await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body }));
    expect(event).toMatchObject({ type: "message.filtered", errorCode: "40002" });
  });

  test("an unknown error code stays undelivered", async () => {
    const body = envelope("message.finalized", {
      to: [{ phone_number: "+14155550123", status: "delivery_failed" }],
      errors: [{ code: "40001", title: "Not routable" }],
    });
    const event = await parse(await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body }));
    expect(event).toMatchObject({ type: "message.undelivered", errorCode: "40001" });
  });

  test("other event types are unrecognized", async () => {
    const body = envelope("message.link_click", {});
    const event = await parse(await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body }));
    expect(event).toMatchObject({ type: "unrecognized", providerEventType: "message.link_click" });
  });

  test("an inbound HELP is keyword-derived", async () => {
    const body = envelope("message.received", {
      from: { phone_number: "+14155550123" },
      to: [{ phone_number: "+15005550006" }],
      text: "help",
    });
    const event = await parse(await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body }));
    expect(event).toMatchObject({ type: "recipient.help", source: "keyword", keyword: "HELP" });
  });

  test("extra fields are tolerated", async () => {
    const body = { ...(inbound as Record<string, unknown>), future_top_level: { a: 1 } };
    await expect(parse(await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body }))).resolves.toMatchObject({
      type: "message.received",
    });
  });

  test("duplicate deliveries share the event ID dedupe key", async () => {
    const first = await parse(await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body: inbound }));
    const retry = await parse(await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body: inbound }));
    expect(retry.dedupeKey).toBe(first.dedupeKey);
  });

  test("an authentic payload without data.id is a payload error", async () => {
    const request = await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body: { data: { event_type: "message.received" } } });
    await expect(parse(request)).rejects.toBeInstanceOf(WebhookPayloadError);
  });
});

describe("Telnyx verification failures", () => {
  test("a tampered body is rejected", async () => {
    const signed = await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body: inbound });
    const raw = await signed.text();
    const tampered = new Request(URL_PUBLIC, { method: "POST", headers: signed.headers, body: raw.replace("Hi from", "Hi frum") });
    const error = await rejection(parse(tampered));
    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect(error).toMatchObject({ reason: "invalid_signature" });
  });

  test("a signature from another key is rejected", async () => {
    const request = await signedTelnyxRequest({ privateKey: otherKeys.privateKey, url: URL_PUBLIC, body: inbound });
    await expect(parse(request)).rejects.toMatchObject({ reason: "invalid_signature" });
  });

  test("a stale timestamp is rejected even with a valid signature", async () => {
    const timestamp = Math.floor(Date.now() / 1000) - 301;
    const request = await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body: inbound, timestamp });
    await expect(parse(request)).rejects.toMatchObject({ reason: "stale_timestamp" });
  });

  test("a future timestamp beyond tolerance is rejected", async () => {
    const timestamp = Math.floor(Date.now() / 1000) + 600;
    const request = await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body: inbound, timestamp });
    await expect(parse(request)).rejects.toMatchObject({ reason: "stale_timestamp" });
  });

  test("toleranceSec and now are configurable", async () => {
    const timestamp = 1_700_000_000;
    const request = await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body: inbound, timestamp });
    await expect(parse(request, 60, () => (timestamp + 30) * 1000)).resolves.toMatchObject({ type: "message.received" });
  });

  test("the timestamp header is part of the signature", async () => {
    const signed = await signedTelnyxRequest({ privateKey: keys.privateKey, url: URL_PUBLIC, body: inbound });
    const headers = new Headers(signed.headers);
    headers.set("telnyx-timestamp", String(Number(headers.get("telnyx-timestamp")) - 1));
    const request = new Request(URL_PUBLIC, { method: "POST", headers, body: await signed.text() });
    await expect(parse(request)).rejects.toMatchObject({ reason: "invalid_signature" });
  });

  test("missing headers are rejected", async () => {
    const request = new Request(URL_PUBLIC, { method: "POST", body: JSON.stringify(inbound) });
    await expect(parse(request)).rejects.toMatchObject({ reason: "missing_signature" });
  });

  test("malformed signatures and keys are rejected without throwing other errors", async () => {
    const now = Date.now();
    const timestamp = String(Math.floor(now / 1000));
    expect(await verifyTelnyxSignature({ publicKey: keys.publicKey, rawBody: "{}", signature: "!!", timestamp, now })).toEqual({
      valid: false,
      reason: "malformed_signature",
    });
    expect(
      await verifyTelnyxSignature({ publicKey: "short", rawBody: "{}", signature: toBase64(new Uint8Array(64)), timestamp, now }),
    ).toEqual({ valid: false, reason: "invalid_credentials" });
    expect(
      await verifyTelnyxSignature({ publicKey: keys.publicKey, rawBody: "{}", signature: toBase64(new Uint8Array(64)), timestamp: "abc", now }),
    ).toEqual({ valid: false, reason: "malformed_signature" });
  });

  test("a non-JSON body with a forged signature is a signature error, not a parse error", async () => {
    const request = new Request(URL_PUBLIC, {
      method: "POST",
      headers: { "telnyx-signature-ed25519": toBase64(new Uint8Array(64)), "telnyx-timestamp": String(Math.floor(Date.now() / 1000)) },
      body: "not json",
    });
    await expect(parse(request)).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});
