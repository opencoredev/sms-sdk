import { describe, expect, test } from "bun:test";
import { buildSinchRequest, interpretSinchResponse, sinch, sinchDelivery } from "../../src/providers/sinch.js";

const message = { to: "+15551234567", from: { kind: "phone_number", value: "+15557654321" }, body: "hello", mediaUrls: [] } as const;

describe("Sinch adapter", () => {
  test("builds a single-recipient SMS batch", () => {
    expect(buildSinchRequest(message)).toEqual({ from: "+15557654321", to: ["+15551234567"], body: "hello" });
  });

  test("sends bearer-authenticated JSON to the service-plan endpoint", async () => {
    let request: RequestInit | undefined;
    const adapter = sinch({ servicePlanId: "plan/one", apiToken: "token", from: "+15557654321", fetch: async (url, init) => { expect(url).toBe("https://sms.api.sinch.com/xms/v1/plan%2Fone/batches"); request = init; return new Response(JSON.stringify({ id: "batch-1" }), { status: 202 }); } });
    const outcome = await adapter.send(message, { signal: new AbortController().signal, attempt: 1 });
    expect(outcome).toEqual({ kind: "accepted", providerId: "batch-1", delivery: "queued" });
    expect(request?.headers).toMatchObject({ Authorization: "Bearer token", "Content-Type": "application/json" });
  });

  test("does not claim a bare rate limit is safe to retry", () => {
    expect(interpretSinchResponse(429, "", new Headers())).toMatchObject({ kind: "unknown", reason: "unexpected_status" });
  });

  test.each([["delivered", "delivered"], ["failed", "undelivered"], ["pending", "queued"], ["rejected", "filtered"]] as const)("maps %s delivery", (status, expected) => {
    expect(sinchDelivery(status)).toBe(expected);
  });
});
