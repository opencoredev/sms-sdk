import { describe, expect, test } from "bun:test";
import { createSmsClient } from "../../src/core/client.js";
import { buildPlivoRequest, plivo, plivoRejectionCategory } from "../../src/providers/plivo.js";
import { mockFetch } from "../../src/testing/fetch.js";
import { smsAdapterContractCases, type AdapterContractFixtures } from "../../src/testing/contracts.js";
import { signedPlivoRequest } from "../../src/testing/webhooks.js";
import { parseSmsWebhook } from "../../src/webhooks/index.js";
import { describeRateLimitProof } from "../helpers.js";

const AUTH_ID = "MAXXXXXXXXXXXXXXXXXX";
const AUTH_TOKEN = "plivo-token";
const WEBHOOK_URL = "https://example.com/webhooks/plivo";
const UUID = "db3ce55a-7f1d-11e1-8ea7-1231380bc196";

const plivoFixtures: AdapterContractFixtures = {
  message: {
    to: "+14155550123",
    from: { kind: "phone_number", value: "+15005550006" },
    body: "Your order has shipped.",
    mediaUrls: [],
    webhookUrl: "https://example.com/sms/status",
    validityPeriodSec: 3_600,
  },
  request: {
    url: `https://api.plivo.com/v1/Account/${AUTH_ID}/Message/`,
    headers: { authorization: `Basic ${btoa(`${AUTH_ID}:${AUTH_TOKEN}`)}`, "content-type": "application/json" },
    body: {
      kind: "json",
      value: {
        src: "+15005550006",
        dst: "+14155550123",
        text: "Your order has shipped.",
        type: "sms",
        url: "https://example.com/sms/status",
        method: "POST",
        message_expiry: 3_600,
      },
    },
  },
  accepted: {
    response: { status: 202, body: { message: "message(s) queued", message_uuid: [UUID], api_id: "db342550-7f1d-11e1-8ea7-1231380bc196" } },
    providerId: UUID,
    delivery: "queued",
  },
  permanentRejection: {
    response: { status: 400, body: { api_id: "a1", error: "invalid dst number" } },
    category: "request",
  },
  eligibleRejection: {
    response: { status: 401, body: { api_id: "a2", error: "authentication failed" } },
    category: "auth",
  },
  rateLimited: {
    response: { status: 429, body: { api_id: "a3", error: "too many requests" }, headers: { "retry-after": "3" } },
    retryAfterMs: 3_000,
  },
  malformedSuccess: { status: 202, body: { message: "message(s) queued", message_uuid: [] } },
  serverError: { status: 500, body: { api_id: "a4", error: "server error" } },
  webhooks: {
    parse: (request) => parseSmsWebhook({ provider: "plivo", request, credentials: { authToken: AUTH_TOKEN } }),
    cases: [
      {
        name: "delivery status",
        request: () =>
          signedPlivoRequest({
            authToken: AUTH_TOKEN,
            url: WEBHOOK_URL,
            params: { MessageUUID: UUID, Status: "delivered", From: "+15005550006", To: "+14155550123", ErrorCode: "000" },
          }),
        expected: { type: "message.delivered", providerId: UUID, dedupeKey: `plivo:${UUID}:delivered` },
      },
      {
        name: "inbound message",
        request: () =>
          signedPlivoRequest({ authToken: AUTH_TOKEN, url: WEBHOOK_URL, params: { MessageUUID: "in-1", From: "+14155550123", To: "+15005550006", Text: "hello" } }),
        expected: { type: "message.received", body: "hello" },
      },
    ],
    tampered: async () => {
      const signed = await signedPlivoRequest({ authToken: AUTH_TOKEN, url: WEBHOOK_URL, params: { MessageUUID: UUID, Status: "sent" } });
      const headers = new Headers(signed.headers);
      headers.set("x-plivo-signature-v2-nonce", "tampered");
      return new Request(WEBHOOK_URL, { method: "POST", headers, body: await signed.text() });
    },
  },
};

const factory = (fetch: Parameters<typeof plivo>[0]["fetch"]) =>
  plivo({ authId: AUTH_ID, authToken: AUTH_TOKEN, ...(fetch === undefined ? {} : { fetch }) });

describe("plivo adapter contract", () => {
  for (const check of smsAdapterContractCases(factory, plivoFixtures)) {
    test(check.name, check.run);
  }
});

describeRateLimitProof({
  provider: "plivo",
  adapter: (fetch) => plivo({ authId: AUTH_ID, authToken: AUTH_TOKEN, from: "+15005550006", fetch }),
  to: "+14155550123",
  documented: { status: 429, body: { api_id: "a3", error: "too many requests" } },
  bare: [
    ["HTML page", { status: 429, body: "<html><body>429 Too Many Requests</body></html>", headers: { "retry-after": "1" } }],
    ["empty body", { status: 429 }],
    ["foreign JSON", { status: 429, body: { message: "rate limit exceeded" } }],
    ["error without api_id", { status: 429, body: { error: "too many requests" } }],
  ],
});

describe("plivo specifics", () => {
  test("a messaging service sender is a Powerpack UUID; MMS sets type and media", () => {
    expect(
      buildPlivoRequest({
        to: "+14155550123",
        from: { kind: "messaging_service", value: "pp-uuid" },
        body: "",
        mediaUrls: ["https://example.com/a.png"],
      }),
    ).toEqual({ powerpack_uuid: "pp-uuid", dst: "+14155550123", type: "mms", media_urls: ["https://example.com/a.png"] });
  });

  test.each([
    [401, "auth"],
    [429, "rate_limited"],
    [400, "request"],
    [404, "request"],
    [403, "request"],
  ] as const)("HTTP %i is %s", (status, category) => {
    expect(plivoRejectionCategory(status)).toBe(category);
  });

  test("is marked partial with reasons", () => {
    const adapter = plivo({ authId: AUTH_ID, authToken: AUTH_TOKEN });
    expect(adapter.support.status).toBe("partial");
    expect(adapter.support.notes.length).toBeGreaterThan(0);
  });

  test("a 400 is never failed over", async () => {
    const primary = mockFetch({ status: 400, body: { error: "invalid" } });
    const secondary = mockFetch({ status: 202, body: { message_uuid: ["x"] } });
    const sms = createSmsClient({
      adapters: [
        plivo({ authId: AUTH_ID, authToken: AUTH_TOKEN, from: "+15005550006", fetch: primary.fetch }),
        { ...plivo({ authId: "MA2", authToken: "t2", from: "+15005550007", fetch: secondary.fetch }), name: "plivo-backup" },
      ],
      fallback: "on-known-rejection",
    });
    await expect(sms.send({ to: "+14155550123", body: "hi" })).rejects.toMatchObject({ category: "request" });
    expect(secondary.calls).toHaveLength(0);
  });

  test("requires credentials", () => {
    expect(() => plivo({ authId: "", authToken: "t" })).toThrow("authId");
    expect(() => plivo({ authId: "MA", authToken: "" })).toThrow("authToken");
  });
});
