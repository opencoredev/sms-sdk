import { describe, expect, test } from "bun:test";
import { parseBandwidthWebhook } from "../../src/webhooks/bandwidth.js";

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
    expect(event).toMatchObject({ type: "message.delivered", provider: "bandwidth", providerId: "msg-1", to: "+15551234567", dedupeKey: "bandwidth:msg-1:message-delivered" });
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
});
