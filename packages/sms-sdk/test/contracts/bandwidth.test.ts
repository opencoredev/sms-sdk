import { describe, expect, test } from "bun:test";
import { buildBandwidthRequest, bandwidth, bandwidthRejectionCategory, interpretBandwidthResponse } from "../../src/providers/bandwidth.js";
import { smsAdapterContractCases, type AdapterContractFixtures } from "../../src/testing/contracts.js";
import { parseSmsWebhook } from "../../src/webhooks/index.js";

const options = { userId: "u1", apiToken: "token", apiSecret: "secret", applicationId: "app-1", from: "+15005550006" as const };
const id = "a-message-id";

const fixtures: AdapterContractFixtures = {
  message: { to: "+14155550123", from: { kind: "phone_number", value: "+15005550006" }, body: "hello", mediaUrls: [] },
  request: {
    url: "https://messaging.bandwidth.com/api/v2/users/u1/messages",
    headers: { authorization: `Basic ${btoa("token:secret")}`, "content-type": "application/json" },
    body: { kind: "json", value: { from: "+15005550006", to: ["+14155550123"], text: "hello", applicationId: "app-1" } },
  },
  accepted: { response: { status: 202, body: { id } }, providerId: id, delivery: "queued" },
  permanentRejection: { response: { status: 400, body: { errorCode: "1001", description: "bad request" } }, category: "request" },
  eligibleRejection: { response: { status: 401, body: { error: "unauthorized" } }, category: "auth" },
  rateLimited: { response: { status: 429, body: { errorCode: "429", description: "slow down" }, headers: { "retry-after": "2" } }, retryAfterMs: 2_000 },
  malformedSuccess: { status: 202, body: {} },
  serverError: { status: 500, body: { description: "server error" } },
  webhooks: {
    parse: (request) => parseSmsWebhook({ provider: "bandwidth", request, credentials: { username: "hook", password: "secret" } }),
    cases: [
      { name: "delivered", request: async () => new Request("https://example.com", { method: "POST", headers: { authorization: `Basic ${btoa("hook:secret")}` }, body: JSON.stringify([{ type: "message-delivered", time: "2026-01-01T00:00:00Z", message: { id, to: ["+14155550123"], from: "+15005550006" } }]) }), expected: { type: "message.delivered", providerId: id } },
      { name: "inbound", request: async () => new Request("https://example.com", { method: "POST", headers: { authorization: `Basic ${btoa("hook:secret")}` }, body: JSON.stringify([{ type: "message-received", message: { id: "in-1", from: "+14155550123", to: ["+15005550006"], text: "STOP" } }]) }), expected: { type: "recipient.opted_out", body: "STOP" } },
    ],
    tampered: async () => new Request("https://example.com", { method: "POST", headers: { authorization: "Basic invalid" }, body: "{}" }),
  },
};

describe("bandwidth adapter contract", () => {
  for (const check of smsAdapterContractCases((fetch) => bandwidth({ ...options, fetch }), fixtures)) test(check.name, check.run);
});

describe("bandwidth specifics", () => {
  test("is SMS-only and converts provider options", () => {
    expect(buildBandwidthRequest({ to: "+14155550123", from: { kind: "phone_number", value: "+15005550006" }, body: "hi", mediaUrls: [], providerFields: [{ wire: "tag", value: "order-1" }] }, "app-1")).toEqual({ from: "+15005550006", to: ["+14155550123"], text: "hi", applicationId: "app-1", tag: "order-1" });
    expect(bandwidth(options).capabilities.mms).toBe(false);
  });

  test.each([[401, "auth"], [403, "auth"], [404, "account"], [429, "rate_limited"], [400, "request"]] as const)("HTTP %i is %s", (status, category) => expect(bandwidthRejectionCategory(status)).toBe(category));

  test("treats a 429 without a Bandwidth error body as unknown", () => {
    for (const text of ["", "<html>Too Many Requests</html>", "{}"]) {
      expect(interpretBandwidthResponse(429, text, new Headers())).toMatchObject({ kind: "unknown" });
    }
    expect(interpretBandwidthResponse(429, JSON.stringify({ type: "rate-limit", description: "slow down" }), new Headers())).toMatchObject({ kind: "rejected", category: "rate_limited" });
  });

  test("requires credentials", () => {
    expect(() => bandwidth({ ...options, apiSecret: "" })).toThrow("apiSecret");
  });
});
