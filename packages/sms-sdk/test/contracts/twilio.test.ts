import { describe, expect, test } from "bun:test";
import { createSmsClient } from "../../src/core/client.js";
import { HandoffUnknownError, ProviderAuthError, ProviderRateLimitedError, ProviderRejectedError } from "../../src/core/errors.js";
import { buildTwilioForm, twilio, twilioDelivery, twilioRejectionCategory } from "../../src/providers/twilio.js";
import { mockFetch } from "../../src/testing/fetch.js";
import { smsAdapterContractCases, runSmsAdapterContract, type AdapterContractFixtures } from "../../src/testing/contracts.js";
import { signedTwilioRequest } from "../../src/testing/webhooks.js";
import { parseSmsWebhook } from "../../src/webhooks/index.js";
import { rejection, TWILIO_MESSAGE_SID, TWILIO_SERVICE_SID, TWILIO_SID } from "../helpers.js";

const AUTH = `Basic ${btoa(`${TWILIO_SID}:test-token`)}`;

export const twilioFixtures: AdapterContractFixtures = {
  message: {
    to: "+14155550123",
    from: { kind: "phone_number", value: "+15005550006" },
    body: "Your order has shipped.",
    mediaUrls: [],
    webhookUrl: "https://example.com/sms/status",
    validityPeriodSec: 600,
  },
  request: {
    url: `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    headers: { authorization: AUTH, "content-type": "application/x-www-form-urlencoded" },
    body: {
      kind: "form",
      params: {
        To: "+14155550123",
        From: "+15005550006",
        Body: "Your order has shipped.",
        StatusCallback: "https://example.com/sms/status",
        ValidityPeriod: "600",
      },
    },
  },
  accepted: {
    response: {
      status: 201,
      body: { sid: TWILIO_MESSAGE_SID, status: "queued", api_version: "2010-04-01", unknown_future_field: true },
    },
    providerId: TWILIO_MESSAGE_SID,
    delivery: "queued",
  },
  permanentRejection: {
    response: { status: 400, body: { code: 21211, message: "Invalid 'To' Phone Number", more_info: "https://www.twilio.com/docs/errors/21211", status: 400 } },
    category: "recipient",
  },
  eligibleRejection: {
    response: { status: 400, body: { code: 21606, message: "'From' number is not a valid message-capable Twilio number", status: 400 } },
    category: "sender",
  },
  rateLimited: {
    response: { status: 429, body: { code: 20429, message: "Too Many Requests", status: 429 }, headers: { "retry-after": "2" } },
    retryAfterMs: 2_000,
  },
  malformedSuccess: { status: 201, body: { status: "queued" } },
  serverError: { status: 503, body: { message: "Service Unavailable", status: 503 } },
  webhooks: {
    parse: (request) => parseSmsWebhook({ provider: "twilio", request, credentials: { authToken: "test-token" } }),
    cases: [
      {
        name: "status callback",
        request: () =>
          signedTwilioRequest({
            authToken: "test-token",
            url: "https://example.com/twilio",
            params: { MessageSid: TWILIO_MESSAGE_SID, MessageStatus: "delivered", SmsStatus: "delivered" },
          }),
        expected: { type: "message.delivered", providerId: TWILIO_MESSAGE_SID },
      },
      {
        name: "inbound STOP with Advanced Opt-Out",
        request: () =>
          signedTwilioRequest({
            authToken: "test-token",
            url: "https://example.com/twilio",
            params: { MessageSid: TWILIO_MESSAGE_SID, From: "+14155550123", To: "+15005550006", Body: "STOP", OptOutType: "STOP" },
          }),
        expected: { type: "recipient.opted_out", source: "provider" },
      },
    ],
    tampered: async () => {
      const signed = await signedTwilioRequest({
        authToken: "test-token",
        url: "https://example.com/twilio",
        params: { MessageSid: TWILIO_MESSAGE_SID, MessageStatus: "sent" },
      });
      return new Request(signed.url, {
        method: "POST",
        headers: signed.headers,
        body: new URLSearchParams({ MessageSid: TWILIO_MESSAGE_SID, MessageStatus: "delivered" }).toString(),
      });
    },
  },
};

const factory = (fetch: Parameters<typeof twilio>[0]["fetch"]) =>
  twilio({ accountSid: TWILIO_SID, authToken: "test-token", ...(fetch === undefined ? {} : { fetch }) });

describe("twilio adapter contract", () => {
  for (const check of smsAdapterContractCases(factory, twilioFixtures)) {
    test(check.name, check.run);
  }

  test("runSmsAdapterContract reports every check passing", async () => {
    const report = await runSmsAdapterContract(factory, twilioFixtures);
    expect(report.results.filter((result) => !result.passed)).toEqual([]);
    expect(report.adapter).toBe("twilio");
  });

  test("runSmsAdapterContract reports a wrong fixture as a failure", async () => {
    const report = await runSmsAdapterContract(factory, {
      ...twilioFixtures,
      accepted: { ...twilioFixtures.accepted, providerId: "SMwrong" },
    });
    expect(report.passed).toBe(false);
    expect(report.results.find((result) => !result.passed)?.error).toContain("providerId");
  });
});

describe("twilio request building", () => {
  test("uses MessagingServiceSid for a messaging service sender and schedules", () => {
    const form = buildTwilioForm({
      to: "+14155550123",
      from: { kind: "messaging_service", value: TWILIO_SERVICE_SID },
      body: "hi",
      mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
      sendAt: new Date("2030-01-01T10:00:00Z"),
    });
    expect(form.get("MessagingServiceSid")).toBe(TWILIO_SERVICE_SID);
    expect(form.has("From")).toBe(false);
    expect(form.getAll("MediaUrl")).toEqual(["https://example.com/a.png", "https://example.com/b.png"]);
    expect(form.get("SendAt")).toBe("2030-01-01T10:00:00.000Z");
    expect(form.get("ScheduleType")).toBe("fixed");
  });

  test("omits Body for media-only messages", () => {
    const form = buildTwilioForm({
      to: "+14155550123",
      from: { kind: "short_code", value: "12345" },
      body: "",
      mediaUrls: ["https://example.com/a.png"],
    });
    expect(form.has("Body")).toBe(false);
    expect(form.get("From")).toBe("12345");
  });

  test("API key auth uses the key SID and secret", async () => {
    const mock = mockFetch({ status: 201, body: { sid: TWILIO_MESSAGE_SID, status: "queued" } });
    const adapter = twilio({ accountSid: TWILIO_SID, apiKeySid: "SKkey", apiKeySecret: "secret", from: "+15005550006", fetch: mock.fetch });
    await createSmsClient({ adapters: [adapter] }).send({ to: "+14155550123", body: "hi" });
    expect(mock.calls[0]?.headers["authorization"]).toBe(`Basic ${btoa("SKkey:secret")}`);
  });

  test("rejects a malformed account SID at construction", () => {
    expect(() => twilio({ accountSid: "AC123", authToken: "t" })).toThrow("accountSid");
    expect(() => twilio({ accountSid: TWILIO_SID, authToken: "" })).toThrow("authToken");
  });
});

describe("twilio response mapping", () => {
  test.each([
    [401, 20003, "auth"],
    [429, 20429, "rate_limited"],
    [400, 21211, "recipient"],
    [400, 21614, "recipient"],
    [400, 21610, "compliance"],
    [400, 21212, "sender"],
    [400, 21606, "sender"],
    [400, 21612, "sender"],
    [400, 21659, "sender"],
    [400, 21660, "sender"],
    [400, 21703, "sender"],
    [400, 21408, "account"],
    [400, 21608, "account"],
    [400, 21602, "request"],
    [400, 21617, "request"],
    [400, 99999, "request"],
    [403, undefined, "auth"],
    [404, 20404, "request"],
  ] as const)("HTTP %i code %s is %s", (status, code, category) => {
    expect(twilioRejectionCategory(status, code === undefined ? undefined : String(code))).toBe(category);
  });

  test.each([
    ["queued", "queued"],
    ["accepted", "queued"],
    ["scheduled", "queued"],
    ["sending", "queued"],
    ["sent", "sent"],
    ["delivered", "delivered"],
    ["undelivered", "undelivered"],
    ["failed", "undelivered"],
    ["something_new", "unknown"],
  ] as const)("status %s maps to delivery %s", (status, delivery) => {
    expect(twilioDelivery(status)).toBe(delivery);
  });

  test("a 201 with an SID of the wrong shape is unknown", async () => {
    const mock = mockFetch({ status: 201, body: { sid: "not-a-sid" } });
    const sms = createSmsClient({ adapters: [twilio({ accountSid: TWILIO_SID, authToken: "t", from: "+15005550006", fetch: mock.fetch })] });
    const error = await rejection(sms.send({ to: "+14155550123", body: "hi" }));
    expect(error).toBeInstanceOf(HandoffUnknownError);
    expect(error).toMatchObject({ reason: "malformed_response" });
  });

  test.each([
    [401, { code: 20003, message: "Authenticate", status: 401 }, ProviderAuthError],
    [429, { code: 20429, message: "Too Many Requests", status: 429 }, ProviderRateLimitedError],
    [400, { code: 21610, message: "Attempt to send to unsubscribed recipient", status: 400 }, ProviderRejectedError],
    [500, { message: "Internal", status: 500 }, HandoffUnknownError],
    [502, "<html>Bad gateway</html>", HandoffUnknownError],
    [302, "", HandoffUnknownError],
  ] as const)("HTTP %i throws the right error class through the client", async (status, body, errorClass) => {
    const mock = mockFetch({ status, body });
    const sms = createSmsClient({
      adapters: [twilio({ accountSid: TWILIO_SID, authToken: "t", from: "+15005550006", fetch: mock.fetch })],
      retry: { maxAttempts: 1 },
    });
    const error = await rejection(sms.send({ to: "+14155550123", body: "hi" }));
    expect(error).toBeInstanceOf(errorClass);
  });

  test("keeps the request ID and redacted provider message", async () => {
    const mock = mockFetch({
      status: 400,
      body: { code: 21211, message: "The 'To' number +14155550123 is not a valid phone number.", status: 400 },
      headers: { "twilio-request-id": "RQ123" },
    });
    const sms = createSmsClient({ adapters: [twilio({ accountSid: TWILIO_SID, authToken: "t", from: "+15005550006", fetch: mock.fetch })] });
    const error = await rejection(sms.send({ to: "+14155550123", body: "hi" }));
    expect(error).toMatchObject({
      provider: { provider: "twilio", httpStatus: 400, code: "21211", requestId: "RQ123", message: "The 'To' number +1********23 is not a valid phone number." },
    });
  });
});
