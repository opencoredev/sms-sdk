/**
 * Plivo adapter for the Message API (`POST /v1/Account/{auth_id}/Message/`).
 *
 * @see https://www.plivo.com/docs/messaging/api/message/send-a-message
 * @packageDocumentation
 */

import type {
  AdapterMessage,
  AdapterSendOutcome,
  RejectionCategory,
  SmsAdapter,
  SmsCapabilities,
  SmsFrom,
} from "../core/adapters.js";
import { ConfigurationError } from "../core/errors.js";
import {
  basicAuthorization,
  exchange,
  isRecord,
  parseJson,
  parseRetryAfter,
  providerInfo,
  readString,
  unknownForStatus,
  type FetchLike,
} from "../core/http.js";

/** Options for {@link plivo}. */
export type PlivoOptions = {
  /** Auth ID, used as the Basic auth username and in the URL path. */
  readonly authId: string;
  /** Auth Token, used as the Basic auth password and to verify webhooks. */
  readonly authToken: string;
  /** Default sender: a Plivo number, short code, alphanumeric ID, or `{ messagingService: powerpackUuid }`. */
  readonly from?: SmsFrom;
  /** API origin. Default `https://api.plivo.com`. */
  readonly baseUrl?: string;
  /** Custom `fetch`, for tests or runtimes without a global one. */
  readonly fetch?: FetchLike;
};

/** Static capabilities of the Plivo adapter. */
export const PLIVO_CAPABILITIES: SmsCapabilities = {
  sendText: true,
  mms: true,
  scheduling: false,
  validityPeriod: { minSec: 5, maxSec: 10_799 },
  webhookUrlOverride: true,
  inbound: true,
  deliveryReceipts: true,
  senderTypes: ["long_code", "toll_free", "short_code", "alphanumeric", "messaging_service"],
  nativeIdempotency: false,
};

/** Notes explaining why Plivo is marked `partial`. */
export const PLIVO_SUPPORT_NOTES: readonly string[] = [
  "Plivo does not document its API error body, so 4xx rejections other than 401 and 429 are classified as `request` (no fallback).",
  "Plivo documents no timestamp in callback signatures, so webhook replay protection relies on your deduplication.",
];

/** Request body for the Plivo Message API. */
export type PlivoMessageRequest = {
  src?: string;
  powerpack_uuid?: string;
  dst: string;
  text?: string;
  type: "sms" | "mms";
  media_urls?: string[];
  url?: string;
  method?: "POST";
  message_expiry?: number;
};

/**
 * Creates a Plivo adapter.
 *
 * Sends JSON to `POST /v1/Account/{authId}/Message/` with HTTP Basic auth. A
 * `{ messagingService }` sender is sent as `powerpack_uuid`.
 *
 * @throws {ConfigurationError} when credentials are empty.
 */
export function plivo(options: PlivoOptions): SmsAdapter {
  if (typeof options.authId !== "string" || options.authId.length === 0) {
    throw new ConfigurationError("Plivo authId is required.");
  }
  if (typeof options.authToken !== "string" || options.authToken.length === 0) {
    throw new ConfigurationError("Plivo authToken is required.");
  }
  const baseUrl = (options.baseUrl ?? "https://api.plivo.com").replace(/\/+$/, "");
  const url = `${baseUrl}/v1/Account/${encodeURIComponent(options.authId)}/Message/`;
  const fetcher: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const authorization = basicAuthorization(options.authId, options.authToken);

  return {
    name: "plivo",
    capabilities: PLIVO_CAPABILITIES,
    support: { status: "partial", notes: PLIVO_SUPPORT_NOTES },
    ...(options.from === undefined ? {} : { defaultFrom: options.from }),

    async send(message, context) {
      const response = await exchange(fetcher, url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(buildPlivoRequest(message)),
        signal: context.signal,
      });
      if (response.kind === "failed") {
        return { kind: "unknown", reason: "network", cause: response.cause };
      }
      return interpretPlivoResponse(response.status, response.text, response.headers);
    },
  };
}

/** Builds the JSON body for the Plivo Message API. */
export function buildPlivoRequest(message: AdapterMessage): PlivoMessageRequest {
  const request: PlivoMessageRequest = {
    dst: message.to,
    type: message.mediaUrls.length > 0 ? "mms" : "sms",
  };
  if (message.from.kind === "messaging_service") {
    request.powerpack_uuid = message.from.value;
  } else {
    request.src = message.from.value;
  }
  if (message.body.length > 0) {
    request.text = message.body;
  }
  if (message.mediaUrls.length > 0) {
    request.media_urls = [...message.mediaUrls];
  }
  if (message.webhookUrl !== undefined) {
    request.url = message.webhookUrl;
    request.method = "POST";
  }
  if (message.validityPeriodSec !== undefined) {
    request.message_expiry = message.validityPeriodSec;
  }
  return request;
}

/** Maps a Plivo HTTP response to an adapter outcome. */
export function interpretPlivoResponse(status: number, text: string, headers: Headers): AdapterSendOutcome {
  const body = parseJson(text);
  const requestId = isRecord(body) ? readString(body, "api_id") : undefined;

  if (status >= 200 && status < 300) {
    const uuids = isRecord(body) ? body["message_uuid"] : undefined;
    const first: unknown = Array.isArray(uuids) ? uuids[0] : undefined;
    if (typeof first !== "string" || first.length === 0) {
      return {
        kind: "unknown",
        reason: "malformed_response",
        details: providerInfo({ provider: "plivo", httpStatus: status, requestId }),
      };
    }
    return { kind: "accepted", providerId: first, delivery: "queued" };
  }

  if (status >= 400 && status < 500) {
    const message = isRecord(body) ? readString(body, "error") : undefined;
    const category = plivoRejectionCategory(status);
    const retryAfterMs = category === "rate_limited" ? parseRetryAfter(headers.get("retry-after")) : undefined;
    return {
      kind: "rejected",
      category,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      details: providerInfo({ provider: "plivo", httpStatus: status, message, requestId }),
    };
  }

  return unknownForStatus("plivo", status, requestId);
}

/** Rejection category for a Plivo 4xx, from the HTTP status codes Plivo documents. */
export function plivoRejectionCategory(status: number): RejectionCategory {
  if (status === 401) {
    return "auth";
  }
  if (status === 429) {
    return "rate_limited";
  }
  return "request";
}
