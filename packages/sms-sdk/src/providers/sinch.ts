/**
 * Sinch SMS REST API adapter (`POST /xms/v1/{servicePlanId}/batches`).
 *
 * @see https://developers.sinch.com/docs/sms/api-reference/sms/batches/send
 * @packageDocumentation
 */

import type {
  AdapterMessage,
  AdapterSendOutcome,
  Delivery,
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
import { ConfigurationError } from "../core/errors.js";
import {
  exchange,
  foundMessage,
  freezeCapabilities,
  freezeProviderOptionsSpec,
  isRecord,
  lookupFailureForStatus,
  malformedLookup,
  parseJson,
  parseRetryAfter,
  providerInfo,
  readCode,
  readString,
  resolveBaseUrl,
  resolveFetcher,
  unknownForStatus,
  type FetchLike,
  freezeSender,
} from "../core/http.js";

/** Options for {@link sinch}. */
export type SinchOptions = {
  /** Service plan ID, used in the API path. */
  readonly servicePlanId: string;
  /** API token, sent as a Bearer token. */
  readonly apiToken: string;
  /** Default sender: a Sinch number, short code, or alphanumeric ID. */
  readonly from?: SmsFrom;
  /** API origin. Default `https://sms.api.sinch.com`. Use a regional origin such as `https://eu.sms.api.sinch.com`. */
  readonly baseUrl?: string;
  /** Custom `fetch`, for tests or runtimes without a global one. */
  readonly fetch?: FetchLike;
};

/** Static capabilities of the Sinch adapter. */
export const SINCH_CAPABILITIES: SmsCapabilities = freezeCapabilities({
  sendText: true,
  mms: false,
  scheduling: true,
  validityPeriod: { minSec: 1, maxSec: 2_592_000 },
  webhookUrlOverride: true,
  inbound: true,
  deliveryReceipts: true,
  senderTypes: ["long_code", "toll_free", "short_code", "alphanumeric"],
  nativeIdempotency: false,
});

/** Notes explaining why Sinch is marked `partial`. */
export const SINCH_SUPPORT_NOTES: readonly string[] = Object.freeze([
  "Sinch documents Basic and OAuth 2.0 callback authentication for SMS and sets up HMAC through your account manager without publishing its format. The webhook parser requires Basic credentials or an HMAC secret; OAuth 2.0 callbacks are not supported.",
  "Sinch reports are per-recipient and can be retried or reordered; deduplicate using the batch, recipient, and status key.",
]);

/** Sinch batch parameters accepted in `providerOptions.sinch`. Parameters the SDK sets are reserved. */
export const SINCH_PROVIDER_OPTIONS = freezeProviderOptionsSpec({
  options: {
    /** `delivery_report`: which delivery reports Sinch sends for this batch. */
    deliveryReport: {
      type: "enum",
      wire: "delivery_report",
      values: ["none", "per_recipient", "per_recipient_final", "summary", "full"],
    },
    /** `client_reference`: your reference, returned in delivery reports. */
    clientReference: { type: "string", wire: "client_reference", maxLength: 128 },
    /** `max_number_of_message_parts`: Sinch rejects longer messages instead of splitting them further. */
    maxNumberOfMessageParts: { type: "integer", wire: "max_number_of_message_parts", min: 1, max: 255 },
  },
  reserved: ["from", "to", "body", "send_at", "expire_at", "callback_url"],
} as const satisfies ProviderOptionsSpec);

/** Sinch-specific send options: `providerOptions.sinch`. */
export type SinchSendOptions = ProviderOptionsOf<typeof SINCH_PROVIDER_OPTIONS>;

declare module "../index.js" {
  interface SmsProviderOptions {
    /** Sinch batch parameters. Applies only when the `sinch` adapter sends. */
    readonly sinch?: SinchSendOptions;
  }
}

/** Request body for `POST /xms/v1/{servicePlanId}/batches`. Provider options add their own keys. */
export type SinchBatchRequest = {
  [option: string]: ProviderOptionValue | string[] | undefined;
  from: string;
  to: string[];
  body: string;
  send_at?: string;
  expire_at?: string;
  callback_url?: string;
};

/**
 * Creates a Sinch adapter. Each send is a single-recipient batch; the batch
 * ID is the `providerId`. `getMessage` reads the batch's summary delivery
 * report, `GET /xms/v1/{servicePlanId}/batches/{batchId}/delivery_report`.
 *
 * @throws {ConfigurationError} when `servicePlanId` or `apiToken` is missing or empty.
 */
export function sinch(options: SinchOptions): SmsAdapter {
  if (!isRecord(options)) {
    throw new ConfigurationError("Sinch options must be an object.");
  }
  let rawServicePlanId: unknown;
  let rawApiToken: unknown;
  let rawBaseUrl: unknown;
  let rawFetch: unknown;
  let rawFrom: SmsFrom | undefined;
  try {
    rawServicePlanId = options.servicePlanId;
    rawApiToken = options.apiToken;
    rawBaseUrl = options.baseUrl;
    rawFetch = options.fetch;
    rawFrom = freezeSender(options.from);
  } catch {
    throw new ConfigurationError("Sinch options could not be read.");
  }
  const servicePlanId = requireValue(rawServicePlanId, "servicePlanId");
  const apiToken = requireValue(rawApiToken, "apiToken");
  const baseUrl = resolveBaseUrl(rawBaseUrl as string | undefined, "https://sms.api.sinch.com", "Sinch");
  const url = `${baseUrl}/xms/v1/${encodeURIComponent(servicePlanId)}/batches`;
  const fetcher: FetchLike = resolveFetcher(rawFetch as FetchLike | undefined, "Sinch");
  const authorization = `Bearer ${apiToken}`;

  return {
    name: "sinch",
    capabilities: SINCH_CAPABILITIES,
    support: { status: "partial", notes: SINCH_SUPPORT_NOTES },
    providerOptions: SINCH_PROVIDER_OPTIONS,
    ...(rawFrom === undefined ? {} : { defaultFrom: rawFrom }),

    validate(message) {
      return validateSinchMessage(message);
    },

    async send(message, context) {
      const response = await exchange(fetcher, url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(buildSinchRequest(message)),
        signal: context.signal,
      });
      if (response.kind === "failed") {
        return { kind: "unknown", reason: response.reason, cause: response.cause };
      }
      return interpretSinchResponse(response.status, response.text, response.headers);
    },

    async getMessage(providerId, context) {
      const response = await exchange(fetcher, `${url}/${encodeURIComponent(providerId)}/delivery_report?type=summary`, {
        method: "GET",
        headers: { Authorization: authorization, Accept: "application/json" },
        signal: context.signal,
      });
      if (response.kind === "failed") {
        return { kind: "failed", reason: response.reason, cause: response.cause };
      }
      return interpretSinchLookup(providerId, response.status, response.text, response.headers);
    },
  };
}

/** Builds the JSON body for a single-recipient batch. */
export function buildSinchRequest(message: AdapterMessage): SinchBatchRequest {
  const request: SinchBatchRequest = { from: message.from.value, to: [message.to], body: message.body };
  if (message.sendAt !== undefined) {
    request.send_at = message.sendAt.toISOString();
  }
  if (message.validityPeriodSec !== undefined) {
    request.expire_at = new Date(Date.now() + message.validityPeriodSec * 1000).toISOString();
  }
  if (message.webhookUrl !== undefined) {
    request.callback_url = message.webhookUrl;
  }
  for (const field of message.providerFields ?? []) {
    request[field.wire] = field.value;
  }
  return request;
}

function validateSinchMessage(message: AdapterMessage): ValidationIssue[] {
  if (message.body.length === 0) {
    return [{ code: "empty_body", field: "body", message: "Sinch SMS requires a non-empty text body." }];
  }
  return [];
}

/** Maps a Sinch batch-create HTTP response to an adapter outcome. */
export function interpretSinchResponse(status: number, text: string, headers: Headers): AdapterSendOutcome {
  const body = parseJson(text);
  const requestId = headers.get("x-request-id");

  if (status >= 200 && status < 300) {
    const id = isRecord(body) ? readString(body, "id") : undefined;
    if (id === undefined) {
      return {
        kind: "unknown",
        reason: "malformed_response",
        details: providerInfo({ provider: "sinch", httpStatus: status, requestId }),
      };
    }
    // A created batch carries no per-recipient status yet.
    return { kind: "accepted", providerId: id, delivery: "queued" };
  }

  if (status >= 400 && status < 500) {
    const error = isRecord(body) ? body : undefined;
    const code = error === undefined ? undefined : readCode(error, "code");
    const message = error === undefined ? undefined : (readString(error, "text") ?? readString(error, "message"));
    const category = sinchRejectionCategory(status, code);
    if (status === 429 && category !== "rate_limited") {
      // Only a documented rate-limit error proves the message was not created.
      // A bare 429, for example from a proxy, is unknown.
      return unknownForStatus("sinch", status, requestId);
    }
    const retryAfterMs = category === "rate_limited" ? parseRetryAfter(headers.get("retry-after")) : undefined;
    return {
      kind: "rejected",
      category,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      details: providerInfo({ provider: "sinch", httpStatus: status, code, message, requestId }),
    };
  }

  return unknownForStatus("sinch", status, requestId);
}

/**
 * Maps a Sinch summary delivery report to a lookup outcome. A batch with no
 * reports yet is found with delivery `unknown`. A 404 is `not_found`.
 */
export function interpretSinchLookup(providerId: string, status: number, text: string, headers: Headers): MessageLookupOutcome {
  const body = parseJson(text);
  const requestId = headers.get("x-request-id");
  if (status >= 200 && status < 300) {
    const statuses = isRecord(body) ? body["statuses"] : undefined;
    if (!Array.isArray(statuses)) {
      return malformedLookup("sinch", status, requestId);
    }
    // Each send is a single-recipient batch, so the summary has at most one status.
    const first: unknown = statuses[0];
    const providerStatus = isRecord(first) ? readString(first, "status") : undefined;
    const errorCode = isRecord(first) ? readCode(first, "code") : undefined;
    return foundMessage({
      provider: "sinch",
      providerId,
      delivery: sinchDelivery(providerStatus, errorCode),
      providerStatus,
      errorCode,
    });
  }
  if (status === 404) {
    return { kind: "not_found" };
  }
  const error = isRecord(body) ? body : undefined;
  return lookupFailureForStatus({
    provider: "sinch",
    status,
    requestId,
    code: error === undefined ? undefined : readCode(error, "code"),
    message: error === undefined ? undefined : (readString(error, "text") ?? readString(error, "message")),
  });
}

/** Rejection category for a Sinch 4xx. Unlisted codes are `request`. */
export function sinchRejectionCategory(status: number, code: string | undefined): RejectionCategory {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429 && (code === "429" || code === "TOO_MANY_REQUESTS")) {
    return "rate_limited";
  }
  switch (code) {
    case "40002":
    case "40003":
      return "recipient";
    case "40004":
    case "40005":
      return "sender";
    case "40301":
    case "40302":
      return "account";
    default:
      return "request";
  }
}

/**
 * Delivery value for a Sinch delivery status, such as `Delivered` or `Dispatched`.
 * Case-insensitive; matches Sinch webhook normalization where `Rejected` / `Filtered`
 * maps to `filtered` only for error code `40003` and `undelivered` otherwise.
 */
export function sinchDelivery(status: string | undefined, code?: string | undefined): Delivery {
  switch (status?.toLowerCase()) {
    case "queued":
    case "pending":
      return "queued";
    case "dispatched":
    case "sent":
    case "accepted":
      return "sent";
    case "delivered":
      return "delivered";
    case "aborted":
    case "failed":
    case "undelivered":
    case "expired":
      return "undelivered";
    case "filtered":
    case "rejected":
      return code === "40003" ? "filtered" : "undelivered";
    default:
      return "unknown";
  }
}

function requireValue(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigurationError(`Sinch ${field} is required.`);
  }
  return value;
}
