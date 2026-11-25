import { describe, expect, test } from "bun:test";
import { ConfigurationError } from "../../src/core/errors.js";
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

  test.each([
    [{}],
    [{ servicePlanId: "plan" }],
    [{ apiToken: "token" }],
    [{ servicePlanId: "", apiToken: "token" }],
    [{ servicePlanId: "plan", apiToken: "" }],
    [{ servicePlanId: 5, apiToken: "token" }],
  ])("throws ConfigurationError for options %j", (options) => {
    // @ts-expect-error -- untyped JavaScript callers can pass anything.
    expect(() => sinch(options)).toThrow(ConfigurationError);
  });

  test("does not claim a bare rate limit is safe to retry", () => {
    expect(interpretSinchResponse(429, "", new Headers())).toMatchObject({ kind: "unknown", reason: "unexpected_status" });
  });

  test.each([
    ["delivered", undefined, "delivered"],
    ["failed", undefined, "undelivered"],
    ["pending", undefined, "queued"],
    ["rejected", "40003", "filtered"],
    ["rejected", "40004", "undelivered"],
    ["rejected", undefined, "undelivered"],
  ] as const)("maps %s (code %s) delivery", (status, code, expected) => {
    expect(sinchDelivery(status, code)).toBe(expected);
  });
});
