import { describe, expect, test } from "bun:test";
import { hmac, toBase64 } from "../../src/core/crypto.js";
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
});
