import { describe, expect, test } from "bun:test";
import { hmac, sha256Hex, toBase64Url, utf8 } from "../../src/core/crypto.js";
import { WebhookPayloadError, WebhookSignatureError } from "../../src/core/errors.js";
import { parseSmsWebhook } from "../../src/webhooks/index.js";
import { signedVonageRequest } from "../../src/testing/webhooks.js";
import { rejection } from "../helpers.js";

const SECRET = "vonage-signature-secret-0123456789";
const URL_PUBLIC = "https://example.com/webhooks/vonage";
const status = {
  message_uuid: "aaaaaaaa-bbbb-4ccc-8ddd-0123456789ab",
  to: "447700900000",
  from: "447700900001",
  timestamp: "2026-10-08T12:00:00Z",
  status: "delivered",
  channel: "sms",
  usage: { currency: "EUR", price: "0.0333" },
};
const inbound = {
  channel: "sms",
  message_uuid: "bbbbbbbb-bbbb-4ccc-8ddd-0123456789ab",
  to: "447700900001",
  from: "447700900000",
  timestamp: "2026-10-08T12:01:00Z",
  text: "Stop",
  sms: { num_messages: "1", keyword: "STOP" },
};

const parse = (request: Request) => parseSmsWebhook({ provider: "vonage", request, credentials: { signatureSecret: SECRET } });

async function jwtRequest(claims: Record<string, unknown>, body: string, alg = "HS256", secret = SECRET): Promise<Request> {
  const header = toBase64Url(utf8(JSON.stringify({ alg, typ: "JWT" })));
  const payload = toBase64Url(utf8(JSON.stringify(claims)));
  const signature = toBase64Url(await hmac("SHA-256", secret, `${header}.${payload}`));
  return new Request(URL_PUBLIC, {
    method: "POST",
    headers: { authorization: `Bearer ${header}.${payload}.${signature}`, "content-type": "application/json" },
    body,
  });
}

describe("parse Vonage Messages API webhooks", () => {
  test("normalizes a delivered status and restores + on numbers", async () => {
    const event = await parse(await signedVonageRequest({ signatureSecret: SECRET, url: URL_PUBLIC, body: status }));
    expect(event).toMatchObject({
      type: "message.delivered",
      provider: "vonage",
      providerId: status.message_uuid,
      providerStatus: "delivered",
      to: "+447700900000",
      from: "+447700900001",
      dedupeKey: `vonage:${status.message_uuid}:delivered`,
    });
    expect(event.occurredAt?.toISOString()).toBe("2026-10-08T12:00:00.000Z");
  });

  test.each([
    ["submitted", undefined, "message.sent"],
    ["rejected", "1240", "message.undelivered"],
    ["undeliverable", "1260", "message.undelivered"],
    ["rejected", "1482", "message.filtered"],
  ] as const)("status %s (error %s) maps to %s", async (providerStatus, code, type) => {
    const body = {
      ...status,
      status: providerStatus,
      ...(code === undefined ? {} : { error: { type: `https://developer.vonage.com/api-errors/messages#${code}`, title: code, detail: "x" } }),
    };
    const event = await parse(await signedVonageRequest({ signatureSecret: SECRET, url: URL_PUBLIC, body }));
    expect(event).toMatchObject({ type, ...(code === undefined ? {} : { errorCode: code }) });
  });

  test("unknown statuses are unrecognized", async () => {
    const event = await parse(await signedVonageRequest({ signatureSecret: SECRET, url: URL_PUBLIC, body: { ...status, status: "read" } }));
    expect(event).toMatchObject({ type: "unrecognized", providerEventType: "read" });
  });

  test("an inbound STOP is keyword-derived (Vonage sends no opt-out flag)", async () => {
    const event = await parse(await signedVonageRequest({ signatureSecret: SECRET, url: URL_PUBLIC, body: inbound }));
    expect(event).toMatchObject({
      type: "recipient.opted_out",
      source: "keyword",
      keyword: "STOP",
      from: "+447700900000",
      to: "+447700900001",
      dedupeKey: `vonage:${inbound.message_uuid}:received`,
    });
  });

  test("an ordinary inbound message", async () => {
    const event = await parse(await signedVonageRequest({ signatureSecret: SECRET, url: URL_PUBLIC, body: { ...inbound, text: "Thanks!" } }));
    expect(event).toMatchObject({ type: "message.received", body: "Thanks!", mediaUrls: [] });
  });

  test("payload_hash must match the delivered bytes, not a re-serialization", async () => {
    const pretty = JSON.stringify(status, null, 2);
    const request = await jwtRequest(
      { iat: Math.floor(Date.now() / 1000), jti: "j1", iss: "Vonage", payload_hash: await sha256Hex(JSON.stringify(status)) },
      pretty,
    );
    const error = await rejection(parse(request));
    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect(error).toMatchObject({ reason: "body_hash_mismatch" });
  });

  test("a duplicate-key body that parses to the signed value is rejected", async () => {
    const compact = JSON.stringify(status);
    // JSON.parse keeps the first key's position and the last value, so this
    // re-serializes to `compact` while a first-wins parser reads "forged".
    const firstKey = Object.keys(status)[0] ?? "";
    const smuggled = `{${JSON.stringify(firstKey)}:"forged",${compact.slice(1)}`;
    expect(JSON.stringify(JSON.parse(smuggled))).toBe(compact);
    const request = await jwtRequest(
      { iat: Math.floor(Date.now() / 1000), jti: "j1", iss: "Vonage", payload_hash: await sha256Hex(compact) },
      smuggled,
    );
    expect(await rejection(parse(request))).toMatchObject({ reason: "body_hash_mismatch" });
  });

  test("payload_hash over the exact pretty-printed bytes is accepted", async () => {
    const pretty = JSON.stringify(status, null, 2);
    const request = await jwtRequest(
      { iat: Math.floor(Date.now() / 1000), jti: "j1", iss: "Vonage", payload_hash: await sha256Hex(pretty) },
      pretty,
    );
    await expect(parse(request)).resolves.toMatchObject({ type: "message.delivered" });
  });

  test("extra fields are tolerated; duplicates share a dedupe key", async () => {
    const body = { ...status, future: { nested: [1, 2] } };
    const first = await parse(await signedVonageRequest({ signatureSecret: SECRET, url: URL_PUBLIC, body }));
    const second = await parse(await signedVonageRequest({ signatureSecret: SECRET, url: URL_PUBLIC, body }));
    expect(second.dedupeKey).toBe(first.dedupeKey);
  });

  test("an authentic payload without message_uuid is a payload error", async () => {
    const request = await signedVonageRequest({ signatureSecret: SECRET, url: URL_PUBLIC, body: { status: "delivered" } });
    await expect(parse(request)).rejects.toBeInstanceOf(WebhookPayloadError);
  });
});

describe("Vonage verification failures", () => {
  test("the wrong signature secret is rejected", async () => {
    const request = await signedVonageRequest({ signatureSecret: "other-secret", url: URL_PUBLIC, body: status });
    const error = await rejection(parse(request));
    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect(error).toMatchObject({ reason: "invalid_signature", providerName: "vonage" });
  });

  test("a tampered body fails the payload hash", async () => {
    const signed = await signedVonageRequest({ signatureSecret: SECRET, url: URL_PUBLIC, body: status });
    const tampered = new Request(URL_PUBLIC, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify({ ...status, status: "rejected" }),
    });
    await expect(parse(tampered)).rejects.toMatchObject({ reason: "body_hash_mismatch" });
  });

  test("a stale iat is rejected", async () => {
    const request = await signedVonageRequest({ signatureSecret: SECRET, url: URL_PUBLIC, body: status, iat: Math.floor(Date.now() / 1000) - 3_600 });
    await expect(parse(request)).rejects.toMatchObject({ reason: "stale_timestamp" });
  });

  test("alg none and other algorithms are rejected", async () => {
    const body = JSON.stringify(status);
    const claims = { iat: Math.floor(Date.now() / 1000), payload_hash: await sha256Hex(body) };
    await expect(parse(await jwtRequest(claims, body, "none"))).rejects.toMatchObject({ reason: "malformed_signature" });
    await expect(parse(await jwtRequest(claims, body, "HS512"))).rejects.toMatchObject({ reason: "malformed_signature" });
  });

  test("missing or malformed Authorization headers are rejected", async () => {
    await expect(parse(new Request(URL_PUBLIC, { method: "POST", body: "{}" }))).rejects.toMatchObject({ reason: "missing_signature" });
    await expect(
      parse(new Request(URL_PUBLIC, { method: "POST", headers: { authorization: "Bearer a.b" }, body: "{}" })),
    ).rejects.toMatchObject({ reason: "malformed_signature" });
  });

  test("a missing iat claim is rejected", async () => {
    const body = JSON.stringify(status);
    await expect(parse(await jwtRequest({ payload_hash: await sha256Hex(body) }, body))).rejects.toMatchObject({
      reason: "malformed_signature",
    });
  });
});
