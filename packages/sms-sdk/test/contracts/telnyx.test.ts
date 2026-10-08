import { describe, expect, test } from "bun:test";
import { createSmsClient } from "../../src/core/client.js";
import { buildTelnyxRequest, telnyx, telnyxDelivery, telnyxRejectionCategory } from "../../src/providers/telnyx.js";
import { mockFetch } from "../../src/testing/fetch.js";
import { smsAdapterContractCases, type AdapterContractFixtures } from "../../src/testing/contracts.js";

const MESSAGE_ID = "40385f64-5717-4562-b3fc-2c963f66afa6";

export const telnyxFixtures: AdapterContractFixtures = {
  message: {
    to: "+14155550123",
    from: { kind: "phone_number", value: "+15005550006" },
    body: "Your order has shipped.",
    mediaUrls: [],
    webhookUrl: "https://example.com/sms/status",
  },
  request: {
    url: "https://api.telnyx.com/v2/messages",
    headers: { authorization: "Bearer KEY_test", "content-type": "application/json" },
    body: {
      kind: "json",
      value: {
        to: "+14155550123",
        from: "+15005550006",
        text: "Your order has shipped.",
        webhook_url: "https://example.com/sms/status",
      },
    },
  },
  accepted: {
    response: {
      status: 200,
      body: {
        data: {
          id: MESSAGE_ID,
          record_type: "message",
          direction: "outbound",
          to: [{ phone_number: "+14155550123", status: "queued", carrier: "T-Mobile", line_type: "Wireless" }],
          from: { phone_number: "+15005550006" },
          parts: 1,
          future_field: { nested: true },
        },
      },
    },
    providerId: MESSAGE_ID,
    delivery: "queued",
  },
  permanentRejection: {
    response: { status: 400, body: { errors: [{ code: "40300", title: "Blocked due to STOP message", detail: "Messages cannot be sent due to an existing block rule." }] } },
    category: "compliance",
  },
  eligibleRejection: {
    response: { status: 400, body: { errors: [{ code: "40305", title: "Invalid 'from' address" }] } },
    category: "sender",
  },
  rateLimited: {
    response: { status: 429, body: { errors: [{ code: "10011", title: "Too many requests" }] }, headers: { "retry-after": "1" } },
    retryAfterMs: 1_000,
  },
  malformedSuccess: { status: 200, body: { data: { record_type: "message" } } },
  serverError: { status: 500, body: { errors: [{ code: "10007", title: "Unexpected error" }] } },
};

const factory = (fetch: Parameters<typeof telnyx>[0]["fetch"]) =>
  telnyx({ apiKey: "KEY_test", ...(fetch === undefined ? {} : { fetch }) });

describe("telnyx adapter contract", () => {
  for (const check of smsAdapterContractCases(factory, telnyxFixtures)) {
    test(check.name, check.run);
  }
});

describe("telnyx request building", () => {
  test("a messaging service sender uses messaging_profile_id without from", () => {
    expect(
      buildTelnyxRequest(
        { to: "+14155550123", from: { kind: "messaging_service", value: "profile-1" }, body: "hi", mediaUrls: [] },
        undefined,
      ),
    ).toEqual({ to: "+14155550123", messaging_profile_id: "profile-1", text: "hi" });
  });

  test("MMS sets media_urls and type, and the adapter profile is sent with from", () => {
    expect(
      buildTelnyxRequest(
        {
          to: "+14155550123",
          from: { kind: "alphanumeric", value: "Acme" },
          body: "",
          mediaUrls: ["https://example.com/a.png"],
          sendAt: new Date("2030-01-01T00:00:00Z"),
        },
        "profile-2",
      ),
    ).toEqual({
      to: "+14155550123",
      from: "Acme",
      messaging_profile_id: "profile-2",
      media_urls: ["https://example.com/a.png"],
      type: "MMS",
      send_at: "2030-01-01T00:00:00.000Z",
    });
  });

  test("requires an API key", () => {
    expect(() => telnyx({ apiKey: "" })).toThrow("apiKey");
  });

  test("an alphanumeric sender works when a profile is configured", async () => {
    const mock = mockFetch({ status: 200, body: { data: { id: "m1", to: [{ status: "queued" }] } } });
    const sms = createSmsClient({ adapters: [telnyx({ apiKey: "k", messagingProfileId: "p", fetch: mock.fetch })] });
    await expect(sms.send({ to: "+14155550123", body: "hi", from: { senderId: "Acme" } })).resolves.toMatchObject({ providerId: "m1" });
  });
});

describe("telnyx response mapping", () => {
  test.each([
    [401, "10009", "auth"],
    [403, "10010", "auth"],
    [401, "20008", "auth"],
    [429, "10011", "rate_limited"],
    [400, "40318", "rate_limited"],
    [400, "40300", "compliance"],
    [400, "40322", "compliance"],
    [400, "40310", "recipient"],
    [400, "40319", "recipient"],
    [400, "40305", "sender"],
    [400, "40306", "sender"],
    [400, "40321", "sender"],
    [400, "40329", "sender"],
    [400, "40309", "account"],
    [400, "40333", "account"],
    [402, "20100", "account"],
    [422, "10015", "request"],
    [400, "40316", "request"],
    [400, undefined, "request"],
    [401, undefined, "auth"],
    [429, undefined, "rate_limited"],
  ] as const)("HTTP %i code %s is %s", (status, code, category) => {
    expect(telnyxRejectionCategory(status, code)).toBe(category);
  });

  test.each([
    ["queued", "queued"],
    ["sending", "queued"],
    ["sent", "sent"],
    ["delivery_unconfirmed", "sent"],
    ["delivered", "delivered"],
    ["sending_failed", "undelivered"],
    ["delivery_failed", "undelivered"],
    ["expired", "undelivered"],
    ["read", "unknown"],
  ] as const)("status %s maps to delivery %s", (status, delivery) => {
    expect(telnyxDelivery(status)).toBe(delivery);
  });
});
