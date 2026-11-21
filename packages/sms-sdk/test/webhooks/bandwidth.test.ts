import { describe, expect, test } from "bun:test";
import { WebhookPayloadError } from "../../src/core/errors.js";
import { parseBandwidthWebhook } from "../../src/webhooks/bandwidth.js";
import { parseSmsWebhook, parseSmsWebhooks } from "../../src/webhooks/index.js";

const credentials = { username: "bw-callback", password: "bw-secret" };
const authorization = `Basic ${btoa("bw-callback:bw-secret")}`;

function callback(body: unknown, headers: Record<string, string> = { authorization }): Request {
  return new Request("https://example.test/bandwidth", { method: "POST", body: JSON.stringify(body), headers });
}

const delivered = [
  { type: "message-delivered", time: "2026-10-08T12:00:00Z", to: "+15551234567", message: { id: "msg-1", from: "+15557654321", to: ["+15551234567"] } },
];

describe("Bandwidth webhooks", () => {
  test("verifies Basic authorization and normalizes a delivery callback", async () => {
    const event = await parseBandwidthWebhook({ request: callback(delivered), credentials });
    expect(event).toMatchObject({ type: "message.delivered", provider: "bandwidth", providerId: "msg-1", to: "+15551234567", dedupeKey: "bandwidth:msg-1:+15551234567:message-delivered" });
  });

  test("normalizes an inbound STOP as an opt-out", async () => {
    const inbound = [{ type: "message-received", time: "2026-10-08T12:00:00Z", message: { id: "msg-2", from: "+15551234567", to: ["+15557654321"], text: "STOP" } }];
    const event = await parseBandwidthWebhook({ request: callback(inbound), credentials });
    expect(event).toMatchObject({ type: "recipient.opted_out", provider: "bandwidth", from: "+15551234567" });
  });

  test("rejects a callback without Authorization", async () => {
    await expect(parseBandwidthWebhook({ request: callback(delivered, {}), credentials })).rejects.toMatchObject({ code: "webhook_signature", reason: "missing_signature" });
  });

  test("rejects a callback with the wrong credentials", async () => {
    const headers = { authorization: `Basic ${btoa("bw-callback:wrong")}` };
    await expect(parseBandwidthWebhook({ request: callback(delivered, headers), credentials })).rejects.toMatchObject({ code: "webhook_signature", reason: "invalid_signature" });
  });

  test("parseSmsWebhooks returns every event in a multi-event callback, in order", async () => {
    const batch = [
      { type: "message-sending", time: "2026-10-08T12:00:00Z", to: "+15551234567", message: { id: "msg-1", from: "+15557654321", to: ["+15551234567"] } },
      { type: "message-delivered", time: "2026-10-08T12:00:01Z", to: "+15551234567", message: { id: "msg-1", from: "+15557654321", to: ["+15551234567"] } },
      { type: "message-failed", time: "2026-10-08T12:00:02Z", to: "+15551230000", errorCode: 4720, message: { id: "msg-3", from: "+15557654321", to: ["+15551230000"] } },
    ];
    const events = await parseSmsWebhooks({ provider: "bandwidth", request: callback(batch), credentials });
    expect(events.map((event) => event.type)).toEqual(["message.queued", "message.delivered", "message.undelivered"]);
    expect(events.map((event) => event.dedupeKey)).toEqual([
      "bandwidth:msg-1:+15551234567:message-sending",
      "bandwidth:msg-1:+15551234567:message-delivered",
      "bandwidth:msg-3:+15551230000:message-failed",
    ]);
    expect(events[2]).toMatchObject({ providerId: "msg-3", to: "+15551230000", errorCode: "4720" });
  });

  test("parseSmsWebhooks gives distinct dedupeKeys when a batch shares message.id across recipients", async () => {
    const batch = [
      { type: "message-delivered", time: "2026-10-08T12:00:00Z", to: "+15551111111", message: { id: "msg-group-1", from: "+15557654321", to: ["+15551111111", "+15552222222"] } },
      { type: "message-delivered", time: "2026-10-08T12:00:01Z", to: "+15552222222", message: { id: "msg-group-1", from: "+15557654321", to: ["+15551111111", "+15552222222"] } },
    ];
    const events = await parseSmsWebhooks({ provider: "bandwidth", request: callback(batch), credentials });
    expect(events.map((event) => event.dedupeKey)).toEqual([
      "bandwidth:msg-group-1:+15551111111:message-delivered",
      "bandwidth:msg-group-1:+15552222222:message-delivered",
    ]);
    expect(new Set(events.map((event) => event.dedupeKey)).size).toBe(2);
  });

  test("parseSmsWebhooks returns a one-element array for a single event", async () => {
    const events = await parseSmsWebhooks({ provider: "bandwidth", request: callback(delivered), credentials });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "message.delivered", providerId: "msg-1" });
  });

  test("the single-event parser refuses to drop events from a multi-event callback", async () => {
    const batch = [delivered[0], { ...delivered[0], message: { id: "msg-2", from: "+15557654321", to: ["+15551234567"] } }];
    const error = await parseSmsWebhook({ provider: "bandwidth", request: callback(batch), credentials }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(WebhookPayloadError);
    expect(String(error)).toContain("parseSmsWebhooks");
  });

  test.each([[[]], [{}], [[1]]])("rejects a malformed body %j as a payload error", async (body) => {
    await expect(parseSmsWebhooks({ provider: "bandwidth", request: callback(body), credentials })).rejects.toBeInstanceOf(WebhookPayloadError);
  });

  test("an inbound MMS whose text is STOP keeps its media URLs", async () => {
    const inbound = [
      {
        type: "message-received",
        time: "2026-10-08T12:00:00Z",
        message: { id: "msg-4", from: "+15551234567", to: ["+15557654321"], text: "STOP", media: ["https://messaging.bandwidth.com/media/a.jpg"] },
      },
    ];
    const event = await parseBandwidthWebhook({ request: callback(inbound), credentials });
    expect(event).toMatchObject({ type: "recipient.opted_out", mediaUrls: ["https://messaging.bandwidth.com/media/a.jpg"] });
  });
});
