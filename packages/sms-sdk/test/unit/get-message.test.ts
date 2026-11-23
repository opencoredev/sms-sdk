import { describe, expect, test } from "bun:test";
import type { SmsAdapter } from "../../src/core/adapters.js";
import { createSmsClient } from "../../src/core/client.js";
import { ConfigurationError, MessageLookupError, SmsError } from "../../src/core/errors.js";
import { bandwidth } from "../../src/providers/bandwidth.js";
import { plivo } from "../../src/providers/plivo.js";
import { sinch } from "../../src/providers/sinch.js";
import { telnyx } from "../../src/providers/telnyx.js";
import { twilio } from "../../src/providers/twilio.js";
import { vonage } from "../../src/providers/vonage.js";
import { mockFetch } from "../../src/testing/fetch.js";
import { acceptedOutcome, memory } from "../../src/testing/memory.js";
import { rejection, TWILIO_MESSAGE_SID, TWILIO_SID } from "../helpers.js";

const message = { to: "+14155550123", body: "Your code is 123456." } as const;

function withoutLookup(adapter: SmsAdapter): SmsAdapter {
  const { getMessage: _unused, ...rest } = adapter;
  return rest;
}

describe("sms.getMessage", () => {
  test("finds a message sent through the client, on the adapter that accepted it", async () => {
    const primary = memory({ name: "primary", outcomes: [acceptedOutcome("p-1", "queued")] });
    const backup = memory({ name: "backup" });
    const sms = createSmsClient({ adapters: [primary, backup] });
    const result = await sms.send(message);
    expect(await sms.getMessage(result.providerId, { adapter: result.provider })).toEqual({
      provider: "primary",
      providerId: "p-1",
      delivery: "queued",
      providerStatus: "queued",
    });
  });

  test("defaults to the primary adapter", async () => {
    const mock = mockFetch({ status: 200, body: { sid: TWILIO_MESSAGE_SID, status: "delivered" } });
    const sms = createSmsClient({ adapters: [twilio({ accountSid: TWILIO_SID, authToken: "t", fetch: mock.fetch }), memory()] });
    await expect(sms.getMessage(TWILIO_MESSAGE_SID)).resolves.toMatchObject({ provider: "twilio", delivery: "delivered" });
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0]?.method).toBe("GET");
  });

  test("returns undefined when the provider has no such message", async () => {
    const sms = createSmsClient({ adapters: [memory()] });
    await expect(sms.getMessage("missing")).resolves.toBeUndefined();
  });

  test("throws MessageLookupError when the provider cannot answer, and it is never resend-safe", async () => {
    const mock = mockFetch({ status: 503, body: { message: "Service Unavailable" } });
    const sms = createSmsClient({ adapters: [twilio({ accountSid: TWILIO_SID, authToken: "t", fetch: mock.fetch })] });
    const error = await rejection(sms.getMessage(TWILIO_MESSAGE_SID));
    expect(error).toBeInstanceOf(MessageLookupError);
    expect(error).toBeInstanceOf(SmsError);
    expect(error).toMatchObject({
      code: "message_lookup_failed",
      reason: "server_error",
      retrySafe: false,
      providerName: "twilio",
      providerId: TWILIO_MESSAGE_SID,
      provider: { provider: "twilio", httpStatus: 503 },
    });
  });

  test("maps a 401 to reason auth", async () => {
    const mock = mockFetch({ status: 401, body: { code: 20003, message: "Authenticate" } });
    const sms = createSmsClient({ adapters: [twilio({ accountSid: TWILIO_SID, authToken: "t", fetch: mock.fetch })] });
    await expect(sms.getMessage(TWILIO_MESSAGE_SID)).rejects.toMatchObject({ reason: "auth", provider: { code: "20003" } });
  });

  test("applies the client timeout", async () => {
    const mock = mockFetch({ hangUntilAborted: true });
    const sms = createSmsClient({ adapters: [twilio({ accountSid: TWILIO_SID, authToken: "t", fetch: mock.fetch })], timeoutMs: 20 });
    await expect(sms.getMessage(TWILIO_MESSAGE_SID)).rejects.toMatchObject({ reason: "timeout" });
  });

  test("honors the caller's signal", async () => {
    const mock = mockFetch({ hangUntilAborted: true });
    const sms = createSmsClient({ adapters: [twilio({ accountSid: TWILIO_SID, authToken: "t", fetch: mock.fetch })] });
    const controller = new AbortController();
    const pending = sms.getMessage(TWILIO_MESSAGE_SID, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "aborted" });
  });

  test("an already-aborted signal makes no request", async () => {
    const mock = mockFetch({ status: 200, body: {} });
    const sms = createSmsClient({ adapters: [twilio({ accountSid: TWILIO_SID, authToken: "t", fetch: mock.fetch })] });
    const controller = new AbortController();
    controller.abort();
    await expect(sms.getMessage(TWILIO_MESSAGE_SID, { signal: controller.signal })).rejects.toMatchObject({ reason: "aborted" });
    expect(mock.calls).toHaveLength(0);
  });

  test("an adapter that throws is a lookup failure, not a crash", async () => {
    const broken: SmsAdapter = {
      ...memory({ name: "broken" }),
      getMessage: async () => {
        throw new Error("boom");
      },
    };
    const sms = createSmsClient({ adapters: [broken] });
    await expect(sms.getMessage("x")).rejects.toMatchObject({ code: "message_lookup_failed", reason: "adapter_exception" });
  });

  test("escapes the provider ID in the request path", async () => {
    const mock = mockFetch({ status: 404, body: {} });
    const sms = createSmsClient({ adapters: [twilio({ accountSid: TWILIO_SID, authToken: "t", fetch: mock.fetch })] });
    await sms.getMessage("../../Calls");
    expect(mock.calls[0]?.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages/..%2F..%2FCalls.json`);
  });

  test.each([
    ["an empty providerId", "", undefined],
    ["an unknown adapter", "id", "nope"],
  ])("throws ConfigurationError for %s", async (_name, providerId, adapter) => {
    const sms = createSmsClient({ adapters: [memory()] });
    await expect(sms.getMessage(providerId, adapter === undefined ? {} : { adapter })).rejects.toBeInstanceOf(ConfigurationError);
  });

  test("throws ConfigurationError for an adapter without getMessage", async () => {
    const sms = createSmsClient({ adapters: [withoutLookup(memory())] });
    await expect(sms.getMessage("id")).rejects.toBeInstanceOf(ConfigurationError);
  });

  test("capabilities() reports which adapters can look messages up", () => {
    const sms = createSmsClient({ adapters: [memory({ name: "a" }), withoutLookup(memory({ name: "b" }))] });
    expect(sms.capabilities().map((info) => [info.name, info.messageLookup])).toEqual([
      ["a", true],
      ["b", false],
    ]);
  });

  test("every built-in adapter implements getMessage", () => {
    const fetch = mockFetch({ status: 500 }).fetch;
    const adapters: SmsAdapter[] = [
      twilio({ accountSid: TWILIO_SID, authToken: "t", fetch }),
      telnyx({ apiKey: "k", fetch }),
      plivo({ authId: "MA1", authToken: "t", fetch }),
      vonage({ apiKey: "k", apiSecret: "s", fetch }),
      bandwidth({ userId: "u", apiToken: "t", apiSecret: "s", applicationId: "a", fetch }),
      sinch({ servicePlanId: "p", apiToken: "t", fetch }),
    ];
    expect(adapters.filter((adapter) => adapter.getMessage === undefined).map((adapter) => adapter.name)).toEqual([]);
  });
});

describe("provider status mapping", () => {
  test.each([
    [200, { totalCount: 1, messages: [{ messageId: "other", messageStatus: "DELIVERED" }] }, undefined],
    [200, { totalCount: 1, messages: [{ messageId: "m-1", messageStatus: "DELIVERED", errorCode: 0 }] }, "delivered"],
    [200, { totalCount: 1, messages: [{ messageId: "m-1", messageStatus: "SENDING" }] }, "queued"],
  ] as const)("Bandwidth %i %j", async (status, body, delivery) => {
    const mock = mockFetch({ status, body });
    const sms = createSmsClient({ adapters: [bandwidth({ userId: "u", apiToken: "t", apiSecret: "s", applicationId: "a", fetch: mock.fetch })] });
    const found = await sms.getMessage("m-1");
    expect(found?.delivery).toBe(delivery);
    expect(found?.errorCode).toBeUndefined();
  });

  test("a Sinch batch without reports yet is found with delivery unknown", async () => {
    const mock = mockFetch({ status: 200, body: { type: "delivery_report_sms", batch_id: "b", statuses: [] } });
    const sms = createSmsClient({ adapters: [sinch({ servicePlanId: "p", apiToken: "t", fetch: mock.fetch })] });
    await expect(sms.getMessage("b")).resolves.toEqual({ provider: "sinch", providerId: "b", delivery: "unknown" });
  });

  test("a Plivo rejected message maps to undelivered and keeps its error code", async () => {
    const mock = mockFetch({ status: 200, body: { api_id: "a", message_uuid: "u", message_state: "rejected", error_code: "450" } });
    const sms = createSmsClient({ adapters: [plivo({ authId: "MA1", authToken: "t", fetch: mock.fetch })] });
    await expect(sms.getMessage("u")).resolves.toMatchObject({ delivery: "undelivered", errorCode: "450" });
  });

  test("Plivo lookup omits placeholder 000 error code even on failed status", async () => {
    const mock = mockFetch({ status: 200, body: { api_id: "a", message_uuid: "u", message_state: "failed", error_code: "000" } });
    const sms = createSmsClient({ adapters: [plivo({ authId: "MA1", authToken: "t", fetch: mock.fetch })] });
    const result = await sms.getMessage("u");
    expect(result).toMatchObject({ delivery: "undelivered" });
    expect(result?.errorCode).toBeUndefined();
  });

  test("Twilio, Telnyx, and Vonage lookups map carrier filtering error codes to filtered", async () => {
    const twMock = mockFetch({ status: 200, body: { sid: TWILIO_MESSAGE_SID, status: "undelivered", error_code: 30007 } });
    const twSms = createSmsClient({ adapters: [twilio({ accountSid: TWILIO_SID, authToken: "t", fetch: twMock.fetch })] });
    await expect(twSms.getMessage(TWILIO_MESSAGE_SID)).resolves.toMatchObject({ delivery: "filtered", errorCode: "30007" });

    const txMock = mockFetch({
      status: 200,
      body: { data: { id: "tx1", to: [{ status: "delivery_failed" }], errors: [{ code: "40003" }] } },
    });
    const txSms = createSmsClient({ adapters: [telnyx({ apiKey: "k", fetch: txMock.fetch })] });
    await expect(txSms.getMessage("tx1")).resolves.toMatchObject({ delivery: "filtered", errorCode: "40003" });

    const vgMock = mockFetch({
      status: 200,
      body: { records: [{ message_id: "vg1", status: "rejected", error_code: "1470" }] },
    });
    const vgSms = createSmsClient({
      adapters: [vonage({ apiKey: "k", apiSecret: "s", fetch: vgMock.fetch })],
    });
    await expect(vgSms.getMessage("vg1")).resolves.toMatchObject({ delivery: "filtered", errorCode: "1470" });
  });
});
