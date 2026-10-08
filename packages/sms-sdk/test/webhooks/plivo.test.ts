import { describe, expect, test } from "bun:test";
import { WebhookPayloadError, WebhookSignatureError } from "../../src/core/errors.js";
import { hmac, toBase64 } from "../../src/core/crypto.js";
import { parseSmsWebhook } from "../../src/webhooks/index.js";
import { computePlivoSignatureV2 } from "../../src/webhooks/plivo.js";
import { signedPlivoRequest } from "../../src/testing/webhooks.js";
import { rejection } from "../helpers.js";

const AUTH_TOKEN = "plivo-auth-token";
const URL_PUBLIC = "https://example.com/webhooks/plivo";
const statusParams = {
  MessageUUID: "db3ce55a-7f1d-11e1-8ea7-1231380bc196",
  Status: "delivered",
  From: "+15005550006",
  To: "+14155550123",
  Units: "1",
  TotalRate: "0.0050",
  TotalAmount: "0.0050",
  ErrorCode: "000",
  MCC: "310",
  MNC: "260",
};
const inboundParams = { MessageUUID: "b1", From: "+14155550123", To: "+15005550006", Text: "Hi Plivo", Type: "sms" };

const parse = (request: Request, extra: { publicUrl?: string } = {}) =>
  parseSmsWebhook({ provider: "plivo", request, credentials: { authToken: AUTH_TOKEN }, ...extra });

describe("Plivo V2 signature", () => {
  test("is Base64(HMAC-SHA256(token, url without query + nonce))", async () => {
    const expected = toBase64(await hmac("SHA-256", AUTH_TOKEN, `${URL_PUBLIC}12345`));
    expect(await computePlivoSignatureV2({ authToken: AUTH_TOKEN, url: `${URL_PUBLIC}?a=1`, nonce: "12345" })).toBe(expected);
  });
});

describe("parse Plivo callbacks", () => {
  test("normalizes a delivery status", async () => {
    const event = await parse(await signedPlivoRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: statusParams }));
    expect(event).toMatchObject({
      type: "message.delivered",
      provider: "plivo",
      providerId: statusParams.MessageUUID,
      providerStatus: "delivered",
      dedupeKey: `plivo:${statusParams.MessageUUID}:delivered`,
    });
    expect("errorCode" in event).toBe(false);
  });

  test.each([
    ["queued", "message.queued"],
    ["sent", "message.sent"],
    ["undelivered", "message.undelivered"],
    ["failed", "message.undelivered"],
  ] as const)("status %s maps to %s", async (status, type) => {
    const params = { ...statusParams, Status: status, ErrorCode: "30" };
    const event = await parse(await signedPlivoRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params }));
    expect(event).toMatchObject({ type, errorCode: "30" });
  });

  test("WhatsApp read status is unrecognized", async () => {
    const event = await parse(await signedPlivoRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: { ...statusParams, Status: "read" } }));
    expect(event).toMatchObject({ type: "unrecognized", providerEventType: "read" });
  });

  test("normalizes an inbound message and keywords", async () => {
    const event = await parse(await signedPlivoRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: inboundParams }));
    expect(event).toMatchObject({ type: "message.received", body: "Hi Plivo", dedupeKey: "plivo:b1:received" });
    const stop = await parse(await signedPlivoRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: { ...inboundParams, Text: "UNSUBSCRIBE" } }));
    expect(stop).toMatchObject({ type: "recipient.opted_out", source: "keyword", keyword: "UNSUBSCRIBE" });
  });

  test("collects MMS media", async () => {
    const params = { ...inboundParams, Type: "mms", Media0: "https://media.plivo.com/0", Media1: "https://media.plivo.com/1" };
    const event = await parse(await signedPlivoRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params }));
    expect(event.type === "message.received" && event.mediaUrls).toEqual(["https://media.plivo.com/0", "https://media.plivo.com/1"]);
  });

  test("accepts the main-account signature header", async () => {
    const nonce = "998877";
    const signature = await computePlivoSignatureV2({ authToken: AUTH_TOKEN, url: URL_PUBLIC, nonce });
    const request = new Request(URL_PUBLIC, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-plivo-signature-v2": "subaccount-signature-we-cannot-check",
        "x-plivo-signature-ma-v2": signature,
        "x-plivo-signature-v2-nonce": nonce,
      },
      body: new URLSearchParams(statusParams).toString(),
    });
    await expect(parse(request)).resolves.toMatchObject({ type: "message.delivered" });
  });

  test("extra fields are tolerated and duplicates share a dedupe key", async () => {
    const params = { ...statusParams, PowerpackUUID: "pp", FutureField: "1" };
    const first = await parse(await signedPlivoRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params }));
    const second = await parse(await signedPlivoRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params }));
    expect(second.dedupeKey).toBe(first.dedupeKey);
  });

  test("GET callbacks read parameters from the query string", async () => {
    const url = `${URL_PUBLIC}?${new URLSearchParams(statusParams).toString()}`;
    const nonce = "1";
    const signature = await computePlivoSignatureV2({ authToken: AUTH_TOKEN, url, nonce });
    const request = new Request(url, { method: "GET", headers: { "x-plivo-signature-v2": signature, "x-plivo-signature-v2-nonce": nonce } });
    await expect(parse(request)).resolves.toMatchObject({ type: "message.delivered" });
  });

  test("an authentic payload without MessageUUID is a payload error", async () => {
    const request = await signedPlivoRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: { Status: "sent" } });
    await expect(parse(request)).rejects.toBeInstanceOf(WebhookPayloadError);
  });
});

describe("Plivo verification failures", () => {
  test("the wrong auth token is rejected", async () => {
    const request = await signedPlivoRequest({ authToken: "other", url: URL_PUBLIC, params: statusParams });
    const error = await rejection(parse(request));
    expect(error).toBeInstanceOf(WebhookSignatureError);
    expect(error).toMatchObject({ reason: "invalid_signature", providerName: "plivo" });
  });

  test("a changed nonce is rejected", async () => {
    const signed = await signedPlivoRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: statusParams, nonce: "1" });
    const headers = new Headers(signed.headers);
    headers.set("x-plivo-signature-v2-nonce", "2");
    const request = new Request(URL_PUBLIC, { method: "POST", headers, body: await signed.text() });
    await expect(parse(request)).rejects.toMatchObject({ reason: "invalid_signature" });
  });

  test("a different callback path is rejected", async () => {
    const request = await signedPlivoRequest({ authToken: AUTH_TOKEN, url: "https://example.com/other", params: statusParams });
    const moved = new Request(URL_PUBLIC, { method: "POST", headers: request.headers, body: await request.text() });
    await expect(parse(moved)).rejects.toMatchObject({ reason: "invalid_signature" });
  });

  test("missing headers are rejected", async () => {
    const request = new Request(URL_PUBLIC, { method: "POST", body: new URLSearchParams(statusParams).toString() });
    await expect(parse(request)).rejects.toMatchObject({ reason: "missing_signature" });
  });

  test("documented limitation: V2 does not sign the body, so body edits are not detectable", async () => {
    const signed = await signedPlivoRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: statusParams });
    const edited = new Request(URL_PUBLIC, {
      method: "POST",
      headers: signed.headers,
      body: new URLSearchParams({ ...statusParams, Status: "undelivered" }).toString(),
    });
    await expect(parse(edited)).resolves.toMatchObject({ type: "message.undelivered" });
  });

  test("publicUrl is used behind a proxy", async () => {
    const signed = await signedPlivoRequest({ authToken: AUTH_TOKEN, url: URL_PUBLIC, params: statusParams });
    const internal = new Request("http://127.0.0.1:8080/webhooks/plivo", { method: "POST", headers: signed.headers, body: await signed.text() });
    await expect(parse(internal, { publicUrl: URL_PUBLIC })).resolves.toMatchObject({ type: "message.delivered" });
  });
});
