import { beforeAll, describe, expect, test } from "bun:test";
import { createSmsClient } from "../../src/core/client.js";
import { fromBase64, toBase64, utf8 } from "../../src/core/crypto.js";
import { ConfigurationError, ProviderAuthError } from "../../src/core/errors.js";
import {
  buildVonageRequest,
  vonage,
  VONAGE_BASIC_CAPABILITIES,
  VONAGE_JWT_CAPABILITIES,
  vonageRejectionCategory,
} from "../../src/providers/vonage.js";
import { mockFetch } from "../../src/testing/fetch.js";
import { smsAdapterContractCases, type AdapterContractFixtures } from "../../src/testing/contracts.js";
import { signedVonageRequest } from "../../src/testing/webhooks.js";
import { parseSmsWebhook } from "../../src/webhooks/index.js";
import { describeRateLimitProof } from "../helpers.js";

const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-0123456789ab";
const SECRET = "vonage-signature-secret";
const WEBHOOK_URL = "https://example.com/webhooks/vonage";

const vonageFixtures: AdapterContractFixtures = {
  message: {
    to: "+447700900000",
    from: { kind: "phone_number", value: "+447700900001" },
    body: "Your order has shipped.",
    mediaUrls: [],
    validityPeriodSec: 3_600,
  },
  request: {
    url: "https://api.nexmo.com/v1/messages",
    headers: { authorization: `Basic ${btoa("key:secret")}`, "content-type": "application/json" },
    body: {
      kind: "json",
      value: { message_type: "text", channel: "sms", to: "447700900000", from: "447700900001", text: "Your order has shipped.", ttl: 3_600 },
    },
  },
  accepted: { response: { status: 202, body: { message_uuid: UUID } }, providerId: UUID, delivery: "queued" },
  permanentRejection: {
    response: {
      status: 422,
      body: { type: "https://developer.vonage.com/api-errors/messages#1430", title: "Invalid recipient", detail: "The `to` parameter is invalid for the given channel.", instance: "i1" },
    },
    category: "recipient",
  },
  eligibleRejection: {
    response: { status: 402, body: { type: "https://developer.vonage.com/api-errors#low-balance", title: "Low balance", detail: "This request could not be performed due to your account balance being low." } },
    category: "account",
  },
  rateLimited: {
    response: { status: 429, body: { type: "https://developer.vonage.com/api-errors#throttled", title: "Rate Limit Hit" }, headers: { "retry-after": "1" } },
    retryAfterMs: 1_000,
  },
  malformedSuccess: { status: 202, body: { workflow_id: "w1" } },
  serverError: { status: 500, body: { title: "Internal Error" } },
  webhooks: {
    parse: (request) => parseSmsWebhook({ provider: "vonage", request, credentials: { signatureSecret: SECRET } }),
    cases: [
      {
        name: "delivered status",
        request: () =>
          signedVonageRequest({
            signatureSecret: SECRET,
            url: WEBHOOK_URL,
            body: { message_uuid: UUID, to: "447700900000", from: "447700900001", timestamp: "2026-10-08T12:00:00Z", status: "delivered", channel: "sms" },
          }),
        expected: { type: "message.delivered", providerId: UUID, to: "+447700900000" },
      },
    ],
    tampered: async () => {
      const signed = await signedVonageRequest({ signatureSecret: SECRET, url: WEBHOOK_URL, body: { message_uuid: UUID, status: "submitted" } });
      return new Request(WEBHOOK_URL, { method: "POST", headers: signed.headers, body: JSON.stringify({ message_uuid: UUID, status: "delivered" }) });
    },
  },
};

const factory = (fetch: Parameters<typeof vonage>[0]["fetch"]) =>
  vonage({ apiKey: "key", apiSecret: "secret", ...(fetch === undefined ? {} : { fetch }) });

describe("vonage adapter contract (Basic auth)", () => {
  for (const check of smsAdapterContractCases(factory, vonageFixtures)) {
    test(check.name, check.run);
  }
});

describe("vonage JWT auth", () => {
  let privatePem: string;
  let publicKey: CryptoKey;

  beforeAll(async () => {
    const pair = await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    );
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
    const lines = toBase64(pkcs8).match(/.{1,64}/g) ?? [];
    privatePem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
    publicKey = pair.publicKey;
  });

  test("signs an RS256 JWT with application_id, iat, jti, and exp", async () => {
    const mock = mockFetch({ status: 202, body: { message_uuid: UUID } });
    const adapter = vonage({ applicationId: "app-123", privateKey: privatePem, from: "+447700900001", fetch: mock.fetch });
    await createSmsClient({ adapters: [adapter] }).send({ to: "+447700900000", body: "hi" });

    const token = mock.calls[0]?.headers["authorization"]?.replace(/^Bearer /, "") ?? "";
    const [header, payload, signature] = token.split(".");
    if (header === undefined || payload === undefined || signature === undefined) throw new Error("not a JWT");
    const decode = (part: string): unknown => JSON.parse(new TextDecoder().decode(fromBase64(part)));
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload);
    expect(claims).toMatchObject({ application_id: "app-123", iat: expect.any(Number), jti: expect.any(String), exp: expect.any(Number) });
    const signatureBytes = fromBase64(signature);
    if (signatureBytes === undefined) throw new Error("bad signature encoding");
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, signatureBytes, utf8(`${header}.${payload}`))).toBe(true);
  });

  test("accepts a PEM with escaped newlines from an environment variable", async () => {
    const mock = mockFetch({ status: 202, body: { message_uuid: UUID } });
    const escaped = privatePem.replaceAll("\n", "\\n");
    const adapter = vonage({ applicationId: "app-123", privateKey: escaped, from: "+447700900001", fetch: mock.fetch });
    await expect(createSmsClient({ adapters: [adapter] }).send({ to: "+447700900000", body: "hi" })).resolves.toMatchObject({ providerId: UUID });
  });

  test("an unusable key is an auth rejection with no request", async () => {
    const mock = mockFetch({ status: 202, body: { message_uuid: UUID } });
    const adapter = vonage({
      applicationId: "app-123",
      privateKey: "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
      from: "+447700900001",
      fetch: mock.fetch,
    });
    await expect(createSmsClient({ adapters: [adapter] }).send({ to: "+447700900000", body: "hi" })).rejects.toBeInstanceOf(ProviderAuthError);
    expect(mock.calls).toHaveLength(0);
  });

  test("JWT auth enables webhooks; Basic auth does not", () => {
    expect(vonage({ applicationId: "a", privateKey: privatePem }).capabilities).toBe(VONAGE_JWT_CAPABILITIES);
    expect(vonage({ apiKey: "k", apiSecret: "s" }).capabilities).toBe(VONAGE_BASIC_CAPABILITIES);
    expect(VONAGE_BASIC_CAPABILITIES.deliveryReceipts).toBe(false);
    expect(VONAGE_JWT_CAPABILITIES.webhookUrlOverride).toBe(true);
  });

  test("rejects missing credentials at construction", () => {
    expect(() => vonage({ apiKey: "", apiSecret: "s" })).toThrow(ConfigurationError);
    expect(() => vonage({ applicationId: "", privateKey: privatePem })).toThrow(ConfigurationError);
    expect(() => vonage({ applicationId: "a", privateKey: "" })).toThrow(ConfigurationError);
  });
});

describeRateLimitProof({
  provider: "vonage",
  adapter: (fetch) => vonage({ apiKey: "k", apiSecret: "s", from: "+447700900001", fetch }),
  to: "+447700900000",
  documented: { status: 429, body: { type: "https://developer.vonage.com/api-errors/messages#1000", title: "1000", detail: "Throttled" } },
  bare: [
    ["HTML page", { status: 429, body: "<html><body>429 Too Many Requests</body></html>", headers: { "retry-after": "1" } }],
    ["empty body", { status: 429 }],
    ["foreign JSON", { status: 429, body: { message: "rate limit exceeded" } }],
    ["problem JSON with another code", { status: 429, body: { type: "https://developer.vonage.com/api-errors/messages#1020", title: "Invalid params" } }],
  ],
});

describe("vonage specifics", () => {
  test("strips + from numbers, keeps alphanumeric senders, and sets webhook_url", () => {
    expect(
      buildVonageRequest({
        to: "+447700900000",
        from: { kind: "alphanumeric", value: "Acme" },
        body: "hi",
        mediaUrls: [],
        webhookUrl: "https://example.com/status",
      }),
    ).toEqual({ message_type: "text", channel: "sms", to: "447700900000", from: "Acme", text: "hi", webhook_url: "https://example.com/status" });
  });

  test("uses the regional host", async () => {
    const mock = mockFetch({ status: 202, body: { message_uuid: UUID } });
    const adapter = vonage({ apiKey: "k", apiSecret: "s", region: "api-eu", from: "+447700900001", fetch: mock.fetch });
    await createSmsClient({ adapters: [adapter] }).send({ to: "+447700900000", body: "hi" });
    expect(mock.calls[0]?.url).toBe("https://api-eu.nexmo.com/v1/messages");
  });

  test.each([
    [401, undefined, "auth"],
    [402, undefined, "account"],
    [429, undefined, "request"],
    [429, "throttled", "rate_limited"],
    [422, "1241", "rate_limited"],
    [422, "1000", "rate_limited"],
    [422, "1420", "sender"],
    [422, "1120", "sender"],
    [422, "1430", "recipient"],
    [422, "1240", "compliance"],
    [422, "1160", "account"],
    [422, "1020", "request"],
    [400, undefined, "request"],
  ] as const)("HTTP %i code %s is %s", (status, code, category) => {
    expect(vonageRejectionCategory(status, code)).toBe(category);
  });

  test("reads the error code from a numeric title", async () => {
    const mock = mockFetch({ status: 422, body: { title: "1420", detail: "Invalid sender" } });
    const adapter = vonage({ apiKey: "k", apiSecret: "s", from: "+447700900001", fetch: mock.fetch });
    await expect(createSmsClient({ adapters: [adapter] }).send({ to: "+447700900000", body: "hi" })).rejects.toMatchObject({
      category: "sender",
      provider: { code: "1420" },
    });
  });
});
