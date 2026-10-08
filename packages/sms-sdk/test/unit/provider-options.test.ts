import { describe, expect, test } from "bun:test";
import type { ProviderOptionsSpec } from "../../src/core/adapters.js";
import { createSmsClient } from "../../src/core/client.js";
import { InvalidMessageError, UnsupportedFieldError } from "../../src/core/errors.js";
import { fingerprintMessage, memoryIdempotencyStore } from "../../src/core/idempotency.js";
import type { SmsSendInput } from "../../src/core/types.js";
import { plivo, PLIVO_PROVIDER_OPTIONS } from "../../src/providers/plivo.js";
import { telnyx, TELNYX_PROVIDER_OPTIONS } from "../../src/providers/telnyx.js";
import { twilio, TWILIO_PROVIDER_OPTIONS } from "../../src/providers/twilio.js";
import { vonage, VONAGE_PROVIDER_OPTIONS } from "../../src/providers/vonage.js";
import { mockFetch } from "../../src/testing/fetch.js";
import { memory, rejectedOutcome } from "../../src/testing/memory.js";
import { smsRejection, TWILIO_MESSAGE_SID, TWILIO_SERVICE_SID, TWILIO_SID } from "../helpers.js";

const TO = "+14155550123";
const FROM = "+15005550006";

const twilioAccepted = { status: 201, body: { sid: TWILIO_MESSAGE_SID, status: "queued" } };
const telnyxAccepted = { status: 200, body: { data: { id: "tx-1", to: [{ status: "queued" }] } } };
const plivoAccepted = { status: 202, body: { message: "queued", message_uuid: ["pl-1"], api_id: "api-1" } };
const vonageAccepted = { status: 202, body: { message_uuid: "vn-1" } };

function twilioClient(from: SmsSendInput["from"] = FROM) {
  const fake = mockFetch(twilioAccepted);
  const sms = createSmsClient({
    adapters: [twilio({ accountSid: TWILIO_SID, authToken: "test-token", ...(from === undefined ? {} : { from }), fetch: fake.fetch })],
  });
  return { sms, fake };
}

function jsonBody(body: string): unknown {
  return JSON.parse(body);
}

const SPECS: readonly (readonly [string, ProviderOptionsSpec])[] = [
  ["twilio", TWILIO_PROVIDER_OPTIONS],
  ["telnyx", TELNYX_PROVIDER_OPTIONS],
  ["plivo", PLIVO_PROVIDER_OPTIONS],
  ["vonage", VONAGE_PROVIDER_OPTIONS],
];

describe("provider option specs", () => {
  test.each(SPECS.map(([name, spec]) => [name, spec] as const))("%s: typed wire names are unique and never reserved", (_, spec) => {
    const typedWires = Object.values(spec.options).map((field) => field.wire.toLowerCase());
    const reserved = spec.reserved.map((wire) => wire.toLowerCase());
    expect(new Set(typedWires).size).toBe(typedWires.length);
    expect(typedWires.filter((wire) => reserved.includes(wire))).toEqual([]);
    expect(Object.keys(spec.options)).not.toContain("extra");
  });
});

describe("request mapping", () => {
  test("twilio sends typed options and extra as form parameters", async () => {
    const { sms, fake } = twilioClient({ messagingService: TWILIO_SERVICE_SID });
    await sms.send({
      to: TO,
      body: "Hi",
      providerOptions: {
        twilio: {
          shortenUrls: true,
          smartEncoded: false,
          riskCheck: "disable",
          attempt: 2,
          messageIntent: "otp",
          extra: { TrafficType: "free" },
        },
      },
    });
    const form = new URLSearchParams(fake.calls[0]?.body);
    expect(form.get("ShortenUrls")).toBe("true");
    expect(form.get("SmartEncoded")).toBe("false");
    expect(form.get("RiskCheck")).toBe("disable");
    expect(form.get("Attempt")).toBe("2");
    expect(form.get("MessageIntent")).toBe("otp");
    expect(form.get("TrafficType")).toBe("free");
    expect(form.get("MessagingServiceSid")).toBe(TWILIO_SERVICE_SID);
  });

  test("telnyx sends typed options and extra as JSON fields", async () => {
    const fake = mockFetch(telnyxAccepted);
    const sms = createSmsClient({ adapters: [telnyx({ apiKey: "key", from: FROM, fetch: fake.fetch })] });
    await sms.send({
      to: TO,
      body: "Hi",
      providerOptions: {
        telnyx: {
          autoDetect: true,
          encoding: "ucs2",
          useProfileWebhooks: false,
          webhookFailoverUrl: "https://backup.example.com/sms",
          subject: "Order",
          extra: { future_flag: 3 },
        },
      },
    });
    expect(jsonBody(fake.calls[0]?.body ?? "")).toEqual({
      to: TO,
      from: FROM,
      text: "Hi",
      auto_detect: true,
      encoding: "ucs2",
      use_profile_webhooks: false,
      webhook_failover_url: "https://backup.example.com/sms",
      subject: "Order",
      future_flag: 3,
    });
  });

  test("plivo sends typed options and extra as JSON fields", async () => {
    const fake = mockFetch(plivoAccepted);
    const sms = createSmsClient({ adapters: [plivo({ authId: "MA0000", authToken: "token", from: FROM, fetch: fake.fetch })] });
    await sms.send({
      to: TO,
      body: "Hi",
      providerOptions: { plivo: { log: "number_only", trackable: true, extra: { dlt_entity_id: "123" } } },
    });
    expect(jsonBody(fake.calls[0]?.body ?? "")).toEqual({
      dst: TO,
      type: "sms",
      src: FROM,
      text: "Hi",
      log: "number_only",
      trackable: true,
      dlt_entity_id: "123",
    });
  });

  test("vonage nests sms.* options, typed and extra, inside the sms object", async () => {
    const fake = mockFetch(vonageAccepted);
    const sms = createSmsClient({ adapters: [vonage({ apiKey: "key", apiSecret: "secret", from: FROM, fetch: fake.fetch })] });
    await sms.send({
      to: TO,
      body: "Hi",
      providerOptions: {
        vonage: {
          clientRef: "order-123",
          webhookVersion: "v1",
          trustedRecipient: true,
          encodingType: "unicode",
          entityId: "E1",
          contentId: "C1",
          poolId: "pool-1",
          extra: { "sms.future": "x", top_level_future: false },
        },
      },
    });
    expect(jsonBody(fake.calls[0]?.body ?? "")).toEqual({
      message_type: "text",
      channel: "sms",
      to: "14155550123",
      from: "15005550006",
      text: "Hi",
      client_ref: "order-123",
      webhook_version: "v1",
      trusted_recipient: true,
      sms: { encoding_type: "unicode", entity_id: "E1", content_id: "C1", pool_id: "pool-1", future: "x" },
      top_level_future: false,
    });
  });

  test("a send without providerOptions sends no extra fields", async () => {
    const { sms, fake } = twilioClient();
    await sms.send({ to: TO, body: "Hi" });
    expect(fake.calls[0]?.body).toBe("To=%2B14155550123&From=%2B15005550006&Body=Hi");
  });
});

describe("fail fast before any request", () => {
  test("extra cannot set a field the SDK sets, in any letter case", async () => {
    for (const wire of ["To", "body", "STATUSCALLBACK", "MediaUrl", "ContentSid"]) {
      const { sms, fake } = twilioClient();
      const error = await smsRejection(sms.send({ to: TO, body: "Hi", providerOptions: { twilio: { extra: { [wire]: "x" } } } }));
      expect(error).toBeInstanceOf(UnsupportedFieldError);
      expect(error).toMatchObject({ field: "providerOptions", providerName: "twilio" });
      expect(fake.calls).toHaveLength(0);
    }
  });

  test("extra cannot set a typed option's wire name", async () => {
    const { sms, fake } = twilioClient();
    const error = await smsRejection(sms.send({ to: TO, body: "Hi", providerOptions: { twilio: { extra: { ShortenUrls: true } } } }));
    expect(error).toBeInstanceOf(UnsupportedFieldError);
    expect(error.message).toContain("shortenUrls");
    expect(fake.calls).toHaveLength(0);
  });

  test("reserved collisions are rejected for every adapter", async () => {
    const cases: readonly (readonly [SmsSendInput["providerOptions"], () => ReturnType<typeof mockFetch>, (fetch: ReturnType<typeof mockFetch>["fetch"]) => Parameters<typeof createSmsClient>[0]["adapters"][number]])[] = [
      [{ telnyx: { extra: { webhook_url: "https://x.example" } } }, () => mockFetch(telnyxAccepted), (fetch) => telnyx({ apiKey: "k", from: FROM, fetch })],
      [{ plivo: { extra: { method: "GET" } } }, () => mockFetch(plivoAccepted), (fetch) => plivo({ authId: "MA0", authToken: "t", from: FROM, fetch })],
      [{ vonage: { extra: { failover: "x" } } }, () => mockFetch(vonageAccepted), (fetch) => vonage({ apiKey: "k", apiSecret: "s", from: FROM, fetch })],
      [{ vonage: { extra: { "sms.encoding_type": "text" } } }, () => mockFetch(vonageAccepted), (fetch) => vonage({ apiKey: "k", apiSecret: "s", from: FROM, fetch })],
    ];
    for (const [providerOptions, makeFetch, makeAdapter] of cases) {
      const fake = makeFetch();
      const sms = createSmsClient({ adapters: [makeAdapter(fake.fetch)] });
      const error = await smsRejection(sms.send({ to: TO, body: "Hi", ...(providerOptions === undefined ? {} : { providerOptions }) }));
      expect(error).toBeInstanceOf(UnsupportedFieldError);
      expect(fake.calls).toHaveLength(0);
    }
  });

  test("unknown typed keys and wrong value types are rejected at runtime too", async () => {
    const { sms, fake } = twilioClient();
    // @ts-expect-error unknown Twilio option
    const unknownKey = await smsRejection(sms.send({ to: TO, body: "Hi", providerOptions: { twilio: { shortenUrl: true } } }));
    expect(unknownKey).toBeInstanceOf(UnsupportedFieldError);
    expect(unknownKey.message).toContain("shortenUrl");

    // @ts-expect-error wrong value type
    const wrongType = await smsRejection(sms.send({ to: TO, body: "Hi", providerOptions: { twilio: { smartEncoded: "yes" } } }));
    expect(wrongType).toBeInstanceOf(InvalidMessageError);

    // @ts-expect-error value outside the enum
    const wrongEnum = await smsRejection(sms.send({ to: TO, body: "Hi", providerOptions: { twilio: { riskCheck: "off" } } }));
    expect(wrongEnum).toBeInstanceOf(InvalidMessageError);

    const badPattern = await smsRejection(sms.send({ to: TO, body: "Hi", providerOptions: { twilio: { applicationSid: "nope" } } }));
    expect(badPattern).toBeInstanceOf(InvalidMessageError);

    const badExtra = await smsRejection(
      // @ts-expect-error extra values are strings, numbers, or booleans
      sms.send({ to: TO, body: "Hi", providerOptions: { twilio: { extra: { Tags: { campaign: "x" } } } } }),
    );
    expect(badExtra).toBeInstanceOf(InvalidMessageError);
    expect(fake.calls).toHaveLength(0);
  });

  test("an adapter without a spec rejects an entry under its name", async () => {
    const adapter = memory();
    const sms = createSmsClient({ adapters: [adapter] });
    // @ts-expect-error memory() declares no provider options
    const error = await smsRejection(sms.send({ to: TO, body: "Hi", providerOptions: { memory: { x: 1 } } }));
    expect(error).toBeInstanceOf(UnsupportedFieldError);
    expect(adapter.sent).toHaveLength(0);
  });

  test("invalid options for a fallback adapter also throw before any request", async () => {
    const fake = mockFetch(twilioAccepted);
    const primary = memory();
    const sms = createSmsClient({
      adapters: [primary, twilio({ accountSid: TWILIO_SID, authToken: "t", from: FROM, fetch: fake.fetch })],
      fallback: "on-known-rejection",
    });
    const error = await smsRejection(sms.send({ to: TO, body: "Hi", providerOptions: { twilio: { extra: { From: "+1" } } } }));
    expect(error).toBeInstanceOf(UnsupportedFieldError);
    expect(primary.sent).toHaveLength(0);
  });

  test("twilio shortenUrls needs a Messaging Service sender", async () => {
    const { sms, fake } = twilioClient();
    const error = await smsRejection(sms.send({ to: TO, body: "Hi", providerOptions: { twilio: { shortenUrls: true } } }));
    expect(error).toBeInstanceOf(UnsupportedFieldError);
    expect(fake.calls).toHaveLength(0);
  });

  test("errors and hooks name option keys, never values", async () => {
    const failures: unknown[] = [];
    const fake = mockFetch(twilioAccepted);
    const sms = createSmsClient({
      adapters: [twilio({ accountSid: TWILIO_SID, authToken: "t", from: FROM, fetch: fake.fetch })],
      hooks: { onFailure: (event) => void failures.push(event) },
    });
    const secret = "patient-4155550199-diagnosis";
    const errors = [
      await smsRejection(sms.send({ to: TO, body: "Hi", providerOptions: { twilio: { extra: { Body: secret } } } })),
      await smsRejection(sms.send({ to: TO, body: "Hi", providerOptions: { twilio: { applicationSid: secret } } })),
      // @ts-expect-error unknown key
      await smsRejection(sms.send({ to: TO, body: "Hi", providerOptions: { twilio: { note: secret } } })),
    ];
    const serialized = JSON.stringify([errors.map((error) => [error.message, error.toJSON()]), failures]);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("4155550199");
  });
});

describe("fallback", () => {
  test("each adapter sends only its own entry", async () => {
    const primary = mockFetch({ status: 400, body: { code: 21606, message: "bad sender", status: 400 } });
    const secondary = mockFetch(telnyxAccepted);
    const sms = createSmsClient({
      adapters: [
        twilio({ accountSid: TWILIO_SID, authToken: "t", from: FROM, fetch: primary.fetch }),
        telnyx({ apiKey: "k", from: FROM, fetch: secondary.fetch }),
      ],
      fallback: "on-known-rejection",
    });
    const result = await sms.send({
      to: TO,
      body: "Hi",
      providerOptions: { twilio: { smartEncoded: true }, telnyx: { autoDetect: true } },
    });
    expect(result.provider).toBe("telnyx");
    const twilioForm = new URLSearchParams(primary.calls[0]?.body);
    expect(twilioForm.get("SmartEncoded")).toBe("true");
    expect(twilioForm.has("auto_detect")).toBe(false);
    const telnyxBody = jsonBody(secondary.calls[0]?.body ?? "");
    expect(telnyxBody).toMatchObject({ auto_detect: true });
    expect(telnyxBody).not.toHaveProperty("SmartEncoded");
  });

  test("a fallback adapter without an entry sends no options", async () => {
    const spec: ProviderOptionsSpec = TWILIO_PROVIDER_OPTIONS;
    const primary = memory({ name: "twilio", providerOptions: spec, outcomes: [rejectedOutcome("sender")] });
    const secondary = memory({ name: "backup" });
    const sms = createSmsClient({ adapters: [primary, secondary], fallback: "on-known-rejection" });
    await sms.send({ to: TO, body: "Hi", providerOptions: { twilio: { riskCheck: "disable" } } });
    expect(primary.sent[0]?.message.providerFields).toEqual([{ wire: "RiskCheck", value: "disable" }]);
    expect(secondary.sent[0]?.message.providerFields).toBeUndefined();
  });

  test("entries for adapters the client does not have are ignored", async () => {
    const { sms, fake } = twilioClient();
    await sms.send({ to: TO, body: "Hi", providerOptions: { telnyx: { autoDetect: true } } });
    expect(fake.calls[0]?.body).toBe("To=%2B14155550123&From=%2B15005550006&Body=Hi");
  });
});

describe("validate()", () => {
  test("lists the candidates that have options", () => {
    const sms = createSmsClient({
      adapters: [
        twilio({ accountSid: TWILIO_SID, authToken: "t", from: FROM }),
        telnyx({ apiKey: "k", from: FROM }),
        plivo({ authId: "MA0", authToken: "t", from: FROM }),
      ],
      fallback: "on-known-rejection",
    });
    const result = sms.validate({
      to: TO,
      body: "Hi",
      providerOptions: { twilio: { smartEncoded: true }, plivo: { trackable: true }, vonage: { clientRef: "x" } },
    });
    expect(result.supported).toBe(true);
    expect(result.adapterCandidates).toEqual(["twilio", "telnyx", "plivo"]);
    expect(result.providerOptionsFor).toEqual(["twilio", "plivo"]);
  });

  test("reports invalid options as issues without throwing", () => {
    const sms = createSmsClient({ adapters: [twilio({ accountSid: TWILIO_SID, authToken: "t", from: FROM })] });
    const result = sms.validate({ to: TO, body: "Hi", providerOptions: { twilio: { extra: { To: "+1" } } } });
    expect(result.supported).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ code: "unsupported_field", field: "providerOptions", provider: "twilio" })]);
    expect(result.providerOptionsFor).toEqual([]);
  });
});

describe("idempotency fingerprint", () => {
  const base = {
    to: TO,
    from: null,
    body: "Hi",
    mediaUrls: [],
    sendAt: null,
    validityPeriodSec: null,
    webhookUrl: null,
  } as const;

  test("changes when options change and ignores key order", async () => {
    const without = await fingerprintMessage(base);
    const a = await fingerprintMessage({ ...base, providerOptions: { twilio: { smartEncoded: true, riskCheck: "disable" } } });
    const reordered = await fingerprintMessage({ ...base, providerOptions: { twilio: { riskCheck: "disable", smartEncoded: true } } });
    const b = await fingerprintMessage({ ...base, providerOptions: { twilio: { smartEncoded: false, riskCheck: "disable" } } });
    expect(a).not.toBe(without);
    expect(a).toBe(reordered);
    expect(a).not.toBe(b);
  });

  test("is unchanged for sends without options", async () => {
    // The 0.1.0 canonical form, so records stored by earlier versions still match.
    const legacy = JSON.stringify([TO, null, "Hi", [], null, null, null]);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacy));
    const expected = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    expect(await fingerprintMessage(base)).toBe(expected);
    expect(await fingerprintMessage({ ...base, providerOptions: undefined })).toBe(expected);
  });

  test("reusing a key with different options is a conflict", async () => {
    const fake = mockFetch(twilioAccepted);
    const sms = createSmsClient({
      adapters: [twilio({ accountSid: TWILIO_SID, authToken: "t", from: FROM, fetch: fake.fetch })],
      idempotency: { store: memoryIdempotencyStore() },
    });
    await sms.send({ to: TO, body: "Hi", idempotencyKey: "k1", providerOptions: { twilio: { smartEncoded: true } } });
    const replay = await sms.send({ to: TO, body: "Hi", idempotencyKey: "k1", providerOptions: { twilio: { smartEncoded: true } } });
    expect(replay.replayed).toBe(true);
    const error = await smsRejection(
      sms.send({ to: TO, body: "Hi", idempotencyKey: "k1", providerOptions: { twilio: { smartEncoded: false } } }),
    );
    expect(error.code).toBe("idempotency_conflict");
    expect(fake.calls).toHaveLength(1);
  });
});

describe("types", () => {
  test("only imported adapters and their documented keys type-check", () => {
    const valid: SmsSendInput = {
      to: TO,
      body: "Hi",
      providerOptions: { twilio: { shortenUrls: true }, telnyx: { encoding: "gsm7" }, plivo: { log: "false" }, vonage: { encodingType: "text" } },
    };
    // @ts-expect-error no adapter named acme
    const unknownProvider: SmsSendInput = { to: TO, body: "Hi", providerOptions: { acme: {} } };
    // @ts-expect-error autoDetect is a Telnyx option, not a Twilio one
    const wrongProvider: SmsSendInput = { to: TO, body: "Hi", providerOptions: { twilio: { autoDetect: true } } };
    // @ts-expect-error Vonage encodingType values differ from Telnyx encoding values
    const wrongEnum: SmsSendInput = { to: TO, body: "Hi", providerOptions: { vonage: { encodingType: "gsm7" } } };
    expect([valid, unknownProvider, wrongProvider, wrongEnum]).toHaveLength(4);
  });
});
