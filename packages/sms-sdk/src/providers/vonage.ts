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
  isRecord,
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

/** JWT auth with a Vonage application ID and its RSA private key (PKCS#8 PEM). */
export type VonageJwtAuthOptions = VonageCommonOptions & {
  readonly applicationId: string;
  readonly privateKey: string;
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
  "Vonage does not document the HTTP status for each Messages API error code; rejections are classified from the documented 401/402/422/429 statuses and the error code in the problem `type`/`title`.",
  "Short codes and MMS (a separate Messages API channel) are not supported by this adapter.",
];

/** Request body for `POST /v1/messages` with channel `sms`. */
export type VonageMessageRequest = {
  message_type: "text";
  channel: "sms";
  to: string;
  from: string;
  text: string;
  ttl?: number;
  webhook_url?: string;
};

/**
 * Creates a Vonage Messages API adapter.
 *
 * Phone numbers are sent without the leading `+`, as Vonage requires.
 *
 * @throws {ConfigurationError} when credentials are empty.
 */
export function vonage(options: VonageOptions): SmsAdapter {
  const baseUrl = (options.baseUrl ?? `https://${options.region ?? "api"}.nexmo.com`).replace(/\/+$/, "");
  const url = `${baseUrl}/v1/messages`;
  const fetcher: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const authorize = createAuthorizer(options);
  const capabilities = options.apiKey !== undefined ? VONAGE_BASIC_CAPABILITIES : VONAGE_JWT_CAPABILITIES;

  return {
    name: "vonage",
    capabilities,
    support: { status: "partial", notes: VONAGE_SUPPORT_NOTES },
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
        return { kind: "unknown", reason: "network", cause: response.cause };
      }
      return interpretVonageResponse(response.status, response.text, response.headers);
    },
  };
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
 * API error code. Unlisted codes are `request`.
 */
export function vonageRejectionCategory(status: number, code: string | undefined): RejectionCategory {
  switch (code) {
    case "1000":
    case "1241":
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
  return status === 429 ? "rate_limited" : "request";
}

/** Extracts a numeric error code from the problem `type` fragment (`...#1420`) or `title`. */
function vonageErrorCode(body: Record<string, unknown>): string | undefined {
  const type = readString(body, "type");
  const fragment = type?.match(/#(\d+)$/)?.[1];
  if (fragment !== undefined) {
    return fragment;
  }
  const title = readCode(body, "title");
  return title !== undefined && /^\d+$/.test(title) ? title : undefined;
}

type Authorization = { readonly kind: "ok"; readonly value: string } | { readonly kind: "error"; readonly message: string };

function createAuthorizer(options: VonageOptions): () => Promise<Authorization> {
  if (options.apiKey !== undefined) {
    if (options.apiKey.length === 0 || options.apiSecret.length === 0) {
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
