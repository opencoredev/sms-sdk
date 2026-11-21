import { describe, expect, test } from "bun:test";
import { hmac, toBase64 } from "../../src/core/crypto.js";
import { WebhookPayloadError } from "../../src/core/errors.js";
import { parseSmsWebhooks } from "../../src/webhooks/index.js";
import { parseSinchWebhook } from "../../src/webhooks/sinch.js";

const secret = "sinch-test-secret";
async function signed(body: unknown): Promise<Request> {
  const raw = JSON.stringify(body); const nonce = "nonce-1"; const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = toBase64(await hmac("SHA-256", secret, `${raw}.${nonce}.${timestamp}`));
  return new Request("https://example.test/sinch", { method: "POST", body: raw, headers: { "x-sinch-webhook-signature": signature, "x-sinch-webhook-signature-nonce": nonce, "x-sinch-webhook-signature-timestamp": timestamp } });
}

describe("Sinch webhooks", () => {
  test("verifies and normalizes inbound SMS", async () => {
    const event = await parseSinchWebhook({ request: await signed({ type: "mo_text", id: "msg-1", from: "15551234567", to: "15557654321", body: "STOP", received_at: "2026-10-08T12:00:00Z" }), credentials: { kind: "hmac", webhookSecret: secret } });
    expect(event).toMatchObject({ type: "recipient.opted_out", provider: "sinch", providerId: "msg-1", from: "+15551234567", to: "+15557654321" });
  });

  test("normalizes recipient delivery reports", async () => {
    const event = await parseSinchWebhook({ request: await signed({ type: "recipient_delivery_report_sms", batch_id: "batch-1", recipient: "15551234567", status: "Delivered", code: 0 }), credentials: { kind: "hmac", webhookSecret: secret } });
    expect(event).toMatchObject({ type: "message.delivered", providerId: "batch-1", to: "+15551234567", errorCode: "0" });
  });

  test("rejects a forged callback", async () => {
    const request = await signed({ type: "mo_text", id: "msg-1", from: "1", to: "2", body: "hello" });
    const headers = new Headers(request.headers); headers.set("x-sinch-webhook-signature", "forged");
    await expect(parseSinchWebhook({ request: new Request(request, { headers }), credentials: { kind: "hmac", webhookSecret: secret } })).rejects.toMatchObject({ code: "webhook_signature" });
  });

  test("verifies Basic callback credentials", async () => {
    const body = JSON.stringify({ type: "recipient_delivery_report_sms", batch_id: "batch-2", recipient: "15551234567", status: "Delivered" });
    const credentials = { kind: "basic", username: "sinch-cb", password: "pw" } as const;
    const ok = new Request("https://example.test/sinch", { method: "POST", body, headers: { authorization: `Basic ${btoa("sinch-cb:pw")}` } });
    expect(await parseSinchWebhook({ request: ok, credentials })).toMatchObject({ type: "message.delivered", providerId: "batch-2" });
    const missing = new Request("https://example.test/sinch", { method: "POST", body });
    await expect(parseSinchWebhook({ request: missing, credentials })).rejects.toMatchObject({ code: "webhook_signature", reason: "missing_signature" });
  });

  test("rejects an unsigned callback when HMAC is configured", async () => {
    const request = new Request("https://example.test/sinch", { method: "POST", body: JSON.stringify({ type: "mo_text", id: "m", from: "1", to: "2", body: "STOP" }) });
    await expect(parseSinchWebhook({ request, credentials: { kind: "hmac", webhookSecret: secret } })).rejects.toMatchObject({ code: "webhook_signature", reason: "missing_signature" });
  });

  test("parseSmsWebhooks returns one event per recipient delivery report", async () => {
    const body = {
      type: "recipient_delivery_report_sms",
      batch_id: "batch-9",
      recipient_delivery_report: [
        { recipient: "15551230001", status: "Delivered", code: 0 },
        { recipient: "15551230002", status: "Failed", code: 402 },
        { recipient: "15551230003", status: "Dispatched", code: 0 },
      ],
    };
    const events = await parseSmsWebhooks({ provider: "sinch", request: await signed(body), credentials: { kind: "hmac", webhookSecret: secret } });
    expect(events.map((event) => event.type)).toEqual(["message.delivered", "message.undelivered", "message.sent"]);
    expect(events.map((event) => (event.type === "unrecognized" || event.type.startsWith("recipient.") ? undefined : event.to))).toEqual([
      "+15551230001",
      "+15551230002",
      "+15551230003",
    ]);
    expect(new Set(events.map((event) => event.dedupeKey)).size).toBe(3);
    expect(events[1]).toMatchObject({ providerId: "batch-9", errorCode: "402" });
  });

  test("the single-event parser refuses to drop recipient reports", async () => {
    const body = {
      type: "recipient_delivery_report_sms",
      batch_id: "batch-9",
      recipient_delivery_report: [
        { recipient: "15551230001", status: "Delivered" },
        { recipient: "15551230002", status: "Delivered" },
      ],
    };
    await expect(parseSinchWebhook({ request: await signed(body), credentials: { kind: "hmac", webhookSecret: secret } })).rejects.toBeInstanceOf(WebhookPayloadError);
  });

  test("parseSmsWebhooks wraps a single report in a one-element array", async () => {
    const body = { type: "recipient_delivery_report_sms", batch_id: "batch-1", recipient: "15551234567", status: "Delivered" };
    const events = await parseSmsWebhooks({ provider: "sinch", request: await signed(body), credentials: { kind: "hmac", webhookSecret: secret } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "message.delivered", providerId: "batch-1" });
  });
});
