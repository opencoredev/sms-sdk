/**
 * Vonage adapter for the Messages API v1 (`POST /v1/messages`, channel `sms`).
 *
 * This adapter uses the Messages API, not the older SMS API
 * (`rest.nexmo.com/sms/json`). The Messages API returns a definite HTTP
 * status per request, signs status and inbound webhooks with a JWT by default,
 * and supports both Basic and JWT auth. The two APIs use different callback
 * formats and signing models; this SDK does not mix them.
 *
 * @see https://developer.vonage.com/en/api/messages
 * @packageDocumentation
 */

import type {
  AdapterMessage,
  AdapterSendOutcome,
  Delivery,
  LookupContext,
  MessageLookupOutcome,
  ProviderOptionValue,
  ProviderOptionsOf,
  ProviderOptionsSpec,
  RejectionCategory,
  SmsAdapter,
  SmsCapabilities,
  SmsFrom,
  ValidationIssue,
} from "../core/adapters.js";
import { pemToDer, toBase64Url, utf8 } from "../core/crypto.js";
import { ConfigurationError } from "../core/errors.js";
import {
  basicAuthorization,
  exchange,
  foundMessage,
  isRecord,
  lookupFailureForStatus,
  malformedLookup,
  parseJson,
  parseRetryAfter,
  providerInfo,
  readCode,
  readString,
  unknownForStatus,
  type FetchLike,
} from "../core/http.js";

/** Vonage API region hosts. */
export type VonageRegion = "api" | "api-eu" | "api-us" | "api-ap";

type VonageCommonOptions = {
  /** Default sender: a Vonage number (E.164) or an alphanumeric sender ID. */
  readonly from?: SmsFrom;
  /** API region host. Default `"api"` (`https://api.nexmo.com`). */
  readonly region?: VonageRegion;
  /** API origin override. Takes precedence over `region`. */
  readonly baseUrl?: string;
  /** Custom `fetch`, for tests or runtimes without a global one. */
  readonly fetch?: FetchLike;
};

/**
 * Basic auth with the account API key and secret. Vonage documents that Basic
 * auth does not support webhooks and fails with 401 when the number is linked
 * to an application, so this mode disables `webhookUrl` and receipts.
 */
export type VonageBasicAuthOptions = VonageCommonOptions & {
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly applicationId?: never;
  readonly privateKey?: never;
};

/** API key and secret for the Reports API, which accepts only Basic auth. */
export type VonageReportsCredentials = { readonly apiKey: string; readonly apiSecret: string };

/** JWT auth with a Vonage application ID and its RSA private key (PKCS#8 PEM). */
export type VonageJwtAuthOptions = VonageCommonOptions & {
  readonly applicationId: string;
  readonly privateKey: string;
  /**
   * Enables `getMessage`, which reads the Reports API. That API accepts only
   * the account API key and secret, not an application JWT. Without it a
   * JWT-auth adapter has no `getMessage`.
   */
  readonly reportsCredentials?: VonageReportsCredentials;
  readonly apiKey?: never;
  readonly apiSecret?: never;
};

/** Options for {@link vonage}. Pass either `apiKey` + `apiSecret` or `applicationId` + `privateKey`. */
export type VonageOptions = VonageBasicAuthOptions | VonageJwtAuthOptions;

/** Capabilities with JWT auth (application-linked numbers, webhooks enabled). */
export const VONAGE_JWT_CAPABILITIES: SmsCapabilities = {
  sendText: true,
  mms: false,
  scheduling: false,
  validityPeriod: { minSec: 20, maxSec: 604_800 },
  webhookUrlOverride: true,
  inbound: true,
  deliveryReceipts: true,
  senderTypes: ["long_code", "toll_free", "alphanumeric"],
  nativeIdempotency: false,
};

/** Capabilities with Basic auth, which Vonage documents as not supporting webhooks. */
export const VONAGE_BASIC_CAPABILITIES: SmsCapabilities = {
  ...VONAGE_JWT_CAPABILITIES,
  webhookUrlOverride: false,
  inbound: false,
  deliveryReceipts: false,
};

/** Notes explaining why Vonage is marked `partial`. */
export const VONAGE_SUPPORT_NOTES: readonly string[] = [
  "Vonage does not document the HTTP status for each Messages API error code; rejections are classified from the documented 401/402/422 statuses and the error code in the problem `type`/`title`; a 429 is a rate limit only with a documented throttling code.",
  "Short codes and MMS (a separate Messages API channel) are not supported by this adapter.",
  "The Messages API has no message lookup; getMessage reads the Reports API (`GET /v2/reports/records`, product MESSAGES) with the API key and secret, and only once Vonage has a record for the message.",
];

/**
 * Messages API SMS parameters accepted in `providerOptions.vonage`, from the
 * Messages OpenAPI spec (`OutboundSMSText`). Wire names that start with
 * `sms.` are sent inside the `sms` object, in `extra` too. Parameters the SDK
 * sets are reserved, as is `failover`, which would send extra messages on
 * other channels outside the SDK's outcome tracking. Not typed:
 * `trusted_sender` (deprecated by Vonage in favor of `trusted_recipient`).
 *
 * @see https://developer.vonage.com/en/api/messages
 */
export const VONAGE_PROVIDER_OPTIONS = {
  options: {
    /** `client_ref`: your reference, up to 100 characters, returned in every status webhook. */
    clientRef: { type: "string", wire: "client_ref", maxLength: 100 },
    /** `webhook_version`: status webhook format for this message. `parseSmsWebhook` reads `"v1"`. */
    webhookVersion: { type: "enum", wire: "webhook_version", values: ["v0.1", "v1"] },
    /** `trusted_recipient`: skip Fraud Defender protections for this message (Fraud Defender Premium only). */
    trustedRecipient: { type: "boolean", wire: "trusted_recipient" },
    /** `sms.encoding_type`: `"text"`, `"unicode"`, or `"auto"` (default, detect from the text). */
    encodingType: { type: "enum", wire: "sms.encoding_type", values: ["text", "unicode", "auto"] },
    /** `sms.content_id`: regulatory content (template) ID required in some countries. */
    contentId: { type: "string", wire: "sms.content_id" },
    /** `sms.entity_id`: regulatory entity ID required in some countries. */
    entityId: { type: "string", wire: "sms.entity_id" },
    /** `sms.pool_id`: Number Pool to pick the sender from. `from` is still sent and used if the pool cannot be. */
    poolId: { type: "string", wire: "sms.pool_id" },
  },
  reserved: ["message_type", "channel", "to", "from", "text", "ttl", "webhook_url", "failover", "sms"],
  nestedPrefixes: ["sms."],
} as const satisfies ProviderOptionsSpec;

/** Vonage-specific send options: `providerOptions.vonage`. */
export type VonageSendOptions = ProviderOptionsOf<typeof VONAGE_PROVIDER_OPTIONS>;

declare module "../index.js" {
  interface SmsProviderOptions {
    /** Vonage Messages API SMS parameters. Applies only when the `vonage` adapter sends. */
    readonly vonage?: VonageSendOptions;
  }
}

const [SMS_OBJECT_PREFIX] = VONAGE_PROVIDER_OPTIONS.nestedPrefixes;

/** Request body for `POST /v1/messages` with channel `sms`. Provider options add their own keys. */
export type VonageMessageRequest = {
  [option: string]: ProviderOptionValue | Record<string, ProviderOptionValue> | undefined;
  message_type: "text";
  channel: "sms";
  to: string;
  from: string;
  text: string;
  ttl?: number;
  webhook_url?: string;
  /** SMS settings from `sms.*` provider options. */
  sms?: Record<string, ProviderOptionValue>;
};

/**
 * Creates a Vonage Messages API adapter.
 *
 * Phone numbers are sent without the leading `+`, as Vonage requires.
 * `getMessage` exists with Basic auth, or with JWT auth plus
 * `reportsCredentials`.
 *
 * @throws {ConfigurationError} when credentials are empty.
 */
export function vonage(options: VonageOptions): SmsAdapter {
  if (!isRecord(options)) {
    throw new ConfigurationError("Vonage options must be an object.");
  }
  if (options.baseUrl !== undefined && typeof options.baseUrl !== "string") {
    throw new ConfigurationError("Vonage baseUrl must be a string.");
  }
  const baseUrl = (options.baseUrl ?? `https://${options.region ?? "api"}.nexmo.com`).replace(/\/+$/, "");
  const url = `${baseUrl}/v1/messages`;
  const fetcher: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const authorize = createAuthorizer(options);
  const capabilities = options.apiKey !== undefined ? VONAGE_BASIC_CAPABILITIES : VONAGE_JWT_CAPABILITIES;
  const reports = reportsAccess(options);

  return {
    name: "vonage",
    capabilities,
    support: { status: "partial", notes: VONAGE_SUPPORT_NOTES },
    providerOptions: VONAGE_PROVIDER_OPTIONS,
    ...(options.from === undefined ? {} : { defaultFrom: options.from }),

    validate(message) {
      return validateVonageMessage(message);
    },

    async send(message, context) {
      const authorization = await authorize();
      if (authorization.kind === "error") {
        return {
          kind: "rejected",
          category: "auth",
          details: providerInfo({ provider: "vonage", message: authorization.message }),
        };
      }
      const response = await exchange(fetcher, url, {
        method: "POST",
        headers: {
          Authorization: authorization.value,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(buildVonageRequest(message)),
        signal: context.signal,
      });
      if (response.kind === "failed") {
        return { kind: "unknown", reason: response.reason, cause: response.cause };
      }
      return interpretVonageResponse(response.status, response.text, response.headers);
    },

    ...(reports === undefined
      ? {}
      : {
          async getMessage(providerId: string, context: LookupContext): Promise<MessageLookupOutcome> {
            const query = new URLSearchParams({
              account_id: reports.apiKey,
              product: "MESSAGES",
              direction: "outbound",
              id: providerId,
            }).toString();
            const response = await exchange(fetcher, `${baseUrl}/v2/reports/records?${query}`, {
              method: "GET",
              headers: { Authorization: reports.authorization, Accept: "application/json" },
              signal: context.signal,
            });
            if (response.kind === "failed") {
              return { kind: "failed", reason: response.reason, cause: response.cause };
            }
            return interpretVonageLookup(providerId, response.status, response.text, response.headers);
          },
        }),
  };
}

type ReportsAccess = { readonly apiKey: string; readonly authorization: string };

function reportsAccess(options: VonageOptions): ReportsAccess | undefined {
  const credentials = options.apiKey !== undefined ? options : options.reportsCredentials;
  if (credentials === undefined) {
    return undefined;
  }
  if (
    !isRecord(credentials) ||
    typeof credentials.apiKey !== "string" ||
    credentials.apiKey.length === 0 ||
    typeof credentials.apiSecret !== "string" ||
    credentials.apiSecret.length === 0
  ) {
    throw new ConfigurationError("Vonage apiKey and apiSecret are required.");
  }
  return { apiKey: credentials.apiKey, authorization: basicAuthorization(credentials.apiKey, credentials.apiSecret) };
}

/**
 * Maps a Reports API records response to a lookup outcome. No record with
 * this message ID is `not_found`; Vonage adds records shortly after sending.
 */
export function interpretVonageLookup(providerId: string, status: number, text: string, headers: Headers): MessageLookupOutcome {
  const requestId = headers.get("x-request-id");
  const body = parseJson(text);
  if (status >= 200 && status < 300) {
    const records = isRecord(body) ? body["records"] : undefined;
    if (!Array.isArray(records)) {
      return malformedLookup("vonage", status, requestId);
    }
    const match: unknown = records.find(
      (record: unknown) =>
        isRecord(record) && (readString(record, "message_id") === providerId || readString(record, "message_uuid") === providerId),
    );
    if (!isRecord(match)) {
      return { kind: "not_found" };
    }
    const providerStatus = readString(match, "status");
    const errorCode = readCode(match, "error_code");
    return foundMessage({
      provider: "vonage",
      providerId,
      delivery: vonageDelivery(providerStatus, errorCode),
      providerStatus,
      errorCode,
    });
  }
  if (status === 404) {
    return { kind: "not_found" };
  }
  return lookupFailureForStatus({
    provider: "vonage",
    status,
    requestId,
    message: isRecord(body) ? (readString(body, "detail") ?? readString(body, "title")) : undefined,
  });
}

const VONAGE_FILTERED_CODES = new Set(["1210", "1470", "1472", "1480", "1481", "1482", "1483"]);

/** Delivery value for a Vonage message `status`, such as `submitted` or `undeliverable`. Case-insensitive. */
export function vonageDelivery(status: string | undefined, errorCode?: string): Delivery {
  switch (status?.toLowerCase()) {
    case "submitted":
      return "sent";
    case "delivered":
    case "read":
      return "delivered";
    case "rejected":
    case "undeliverable":
      return errorCode !== undefined && VONAGE_FILTERED_CODES.has(errorCode) ? "filtered" : "undelivered";
    case "failed":
    case "expired":
      return "undelivered";
    default:
      return "unknown";
  }
}

/** Builds the JSON body for `POST /v1/messages`. */
export function buildVonageRequest(message: AdapterMessage): VonageMessageRequest {
  const request: VonageMessageRequest = {
    message_type: "text",
    channel: "sms",
    to: message.to.replace(/^\+/, ""),
    from: message.from.kind === "phone_number" ? message.from.value.replace(/^\+/, "") : message.from.value,
    text: message.body,
  };
  if (message.validityPeriodSec !== undefined) {
    request.ttl = message.validityPeriodSec;
  }
  if (message.webhookUrl !== undefined) {
    request.webhook_url = message.webhookUrl;
  }
  for (const field of message.providerFields ?? []) {
    if (field.wire.startsWith(SMS_OBJECT_PREFIX)) {
      request.sms = { ...request.sms, [field.wire.slice(SMS_OBJECT_PREFIX.length)]: field.value };
    } else {
      request[field.wire] = field.value;
    }
  }
  return request;
}

function validateVonageMessage(message: AdapterMessage): ValidationIssue[] {
  if (message.body.length === 0) {
    return [{ code: "empty_body", field: "body", message: "Vonage SMS requires a non-empty text body." }];
  }
  return [];
}

/** Maps a Vonage Messages API HTTP response to an adapter outcome. */
export function interpretVonageResponse(status: number, text: string, headers: Headers): AdapterSendOutcome {
  const requestId = headers.get("x-request-id");
  const body = parseJson(text);

  if (status >= 200 && status < 300) {
    const uuid = isRecord(body) ? readString(body, "message_uuid") : undefined;
    if (uuid === undefined) {
      return {
        kind: "unknown",
        reason: "malformed_response",
        details: providerInfo({ provider: "vonage", httpStatus: status, requestId }),
      };
    }
    return { kind: "accepted", providerId: uuid, delivery: "queued" };
  }

  if (status >= 400 && status < 500) {
    const code = isRecord(body) ? vonageErrorCode(body) : undefined;
    const message = isRecord(body) ? (readString(body, "detail") ?? readString(body, "title")) : undefined;
    const category = vonageRejectionCategory(status, code);
    if (status === 429 && category !== "rate_limited") {
      // Only a documented rate-limit error proves the message was not created.
      // A bare 429, for example from a proxy, is unknown.
      return unknownForStatus("vonage", status, requestId);
    }
    const retryAfterMs = category === "rate_limited" ? parseRetryAfter(headers.get("retry-after")) : undefined;
    return {
      kind: "rejected",
      category,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      details: providerInfo({ provider: "vonage", httpStatus: status, code, message, requestId }),
    };
  }

  return unknownForStatus("vonage", status, requestId);
}

/**
 * Rejection category for a Vonage 4xx, from the HTTP status and the Messages
 * API error code. Unlisted codes are `request`. Only codes 1000, 1241, and
 * `throttled` are `rate_limited`; the HTTP status alone proves nothing.
 */
export function vonageRejectionCategory(status: number, code: string | undefined): RejectionCategory {
  switch (code) {
    case "1000":
    case "1241":
    case "throttled":
      return "rate_limited";
    case "1170":
    case "1430":
      return "recipient";
    case "1240":
    case "1476":
      return "compliance";
    case "1120":
    case "1420":
      return "sender";
    case "1060":
    case "1080":
    case "1160":
    case "1290":
    case "1460":
      return "account";
    default:
      break;
  }
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 402) {
    return "account";
  }
  return "request";
}

/**
 * Extracts the error code from the problem `type` fragment (`...#1420`, or
 * `...#throttled` from Vonage's generic error list) or a numeric `title`.
 */
function vonageErrorCode(body: Record<string, unknown>): string | undefined {
  const type = readString(body, "type");
  const fragment = type?.match(/#(\d+|throttled)$/)?.[1];
  if (fragment !== undefined) {
    return fragment;
  }
  const title = readCode(body, "title");
  return title !== undefined && /^\d+$/.test(title) ? title : undefined;
}

type Authorization = { readonly kind: "ok"; readonly value: string } | { readonly kind: "error"; readonly message: string };

function createAuthorizer(options: VonageOptions): () => Promise<Authorization> {
  if (options.apiKey !== undefined) {
    if (
      typeof options.apiKey !== "string" ||
      options.apiKey.length === 0 ||
      typeof options.apiSecret !== "string" ||
      options.apiSecret.length === 0
    ) {
      throw new ConfigurationError("Vonage apiKey and apiSecret are required.");
    }
    const value = basicAuthorization(options.apiKey, options.apiSecret);
    return async () => ({ kind: "ok", value });
  }

  if (typeof options.applicationId !== "string" || options.applicationId.length === 0) {
    throw new ConfigurationError("Vonage applicationId is required for JWT auth.");
  }
  const der = pemToDer(options.privateKey);
  if (der === undefined) {
    throw new ConfigurationError("Vonage privateKey must be a PKCS#8 PEM private key.");
  }
  const applicationId = options.applicationId;
  const keyPromise = crypto.subtle
    .importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"])
    .then(
      (key) => ({ kind: "ok" as const, key }),
      () => ({ kind: "error" as const }),
    );

  return async () => {
    const imported = await keyPromise;
    if (imported.kind === "error") {
      return { kind: "error", message: "The Vonage private key could not be imported as an RSA PKCS#8 key." };
    }
    const token = await signVonageJwt({ applicationId, key: imported.key, now: Date.now() });
    return { kind: "ok", value: `Bearer ${token}` };
  };
}

/**
 * Signs an RS256 application JWT with the claims Vonage documents:
 * `application_id`, `iat`, `jti`, and `exp` (15 minutes, the documented default).
 */
export async function signVonageJwt(input: {
  readonly applicationId: string;
  readonly key: CryptoKey;
  readonly now: number;
}): Promise<string> {
  const iat = Math.floor(input.now / 1000);
  const header = toBase64Url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const payload = toBase64Url(
    utf8(JSON.stringify({ application_id: input.applicationId, iat, jti: crypto.randomUUID(), exp: iat + 900 })),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", input.key, utf8(signingInput));
  return `${signingInput}.${toBase64Url(new Uint8Array(signature))}`;
}
