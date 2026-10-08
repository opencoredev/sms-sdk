/**
 * Telnyx adapter for the Messaging API v2 (`POST /v2/messages`).
 *
 * @see https://developers.telnyx.com/api/messaging/send-message
 * @packageDocumentation
 */

import type {
  AdapterMessage,
  AdapterSendOutcome,
  Delivery,
  RejectionCategory,
  SmsAdapter,
  SmsCapabilities,
  SmsFrom,
  ValidationIssue,
} from "../core/adapters.js";
import { ConfigurationError } from "../core/errors.js";
import {
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

/** Options for {@link telnyx}. */
export type TelnyxOptions = {
  /** API v2 key, sent as a Bearer token. */
  readonly apiKey: string;
  /** Default sender: a Telnyx number, short code, alphanumeric ID, or `{ messagingService: profileId }` for a number pool. */
  readonly from?: SmsFrom;
  /**
   * Messaging profile ID sent with every message. Telnyx requires it for
   * alphanumeric sender IDs.
   */
  readonly messagingProfileId?: string;
  /** API origin. Default `https://api.telnyx.com`. */
  readonly baseUrl?: string;
  /** Custom `fetch`, for tests or runtimes without a global one. */
  readonly fetch?: FetchLike;
};

/** Static capabilities of the Telnyx adapter. */
export const TELNYX_CAPABILITIES: SmsCapabilities = {
  sendText: true,
  mms: true,
  scheduling: true,
  validityPeriod: null,
  webhookUrlOverride: true,
  inbound: true,
  deliveryReceipts: true,
  senderTypes: ["long_code", "toll_free", "short_code", "alphanumeric", "messaging_service"],
  nativeIdempotency: false,
};

/** Request body for `POST /v2/messages`. */
export type TelnyxMessageRequest = {
  to: string;
  from?: string;
  messaging_profile_id?: string;
  text?: string;
  media_urls?: string[];
  type?: "SMS" | "MMS";
  webhook_url?: string;
  send_at?: string;
};

/**
 * Creates a Telnyx adapter.
 *
 * Sends JSON to `POST /v2/messages` with `Authorization: Bearer <apiKey>`.
 * A `{ messagingService }` sender is sent as `messaging_profile_id` with no
 * `from`, which uses the profile's number pool.
 *
 * @throws {ConfigurationError} when `apiKey` is empty.
 */
export function telnyx(options: TelnyxOptions): SmsAdapter {
  if (typeof options.apiKey !== "string" || options.apiKey.length === 0) {
    throw new ConfigurationError("Telnyx apiKey is required.");
  }
  const baseUrl = (options.baseUrl ?? "https://api.telnyx.com").replace(/\/+$/, "");
  const url = `${baseUrl}/v2/messages`;
  const fetcher: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const authorization = `Bearer ${options.apiKey}`;

  return {
    name: "telnyx",
    capabilities: TELNYX_CAPABILITIES,
    support: { status: "supported", notes: [] },
    ...(options.from === undefined ? {} : { defaultFrom: options.from }),

    validate(message) {
      return validateTelnyxMessage(message, options.messagingProfileId);
    },

    async send(message, context) {
      const response = await exchange(fetcher, url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(buildTelnyxRequest(message, options.messagingProfileId)),
        signal: context.signal,
      });
      if (response.kind === "failed") {
        return { kind: "unknown", reason: "network", cause: response.cause };
      }
      return interpretTelnyxResponse(response.status, response.text, response.headers);
    },
  };
}

/** Builds the JSON body for `POST /v2/messages`. */
export function buildTelnyxRequest(message: AdapterMessage, messagingProfileId: string | undefined): TelnyxMessageRequest {
  const request: TelnyxMessageRequest = { to: message.to };
  if (message.from.kind === "messaging_service") {
    request.messaging_profile_id = message.from.value;
  } else {
    request.from = message.from.value;
    if (messagingProfileId !== undefined) {
      request.messaging_profile_id = messagingProfileId;
    }
  }
  if (message.body.length > 0) {
    request.text = message.body;
  }
  if (message.mediaUrls.length > 0) {
    request.media_urls = [...message.mediaUrls];
    request.type = "MMS";
  }
  if (message.webhookUrl !== undefined) {
    request.webhook_url = message.webhookUrl;
  }
  if (message.sendAt !== undefined) {
    request.send_at = message.sendAt.toISOString();
  }
  return request;
}

function validateTelnyxMessage(message: AdapterMessage, messagingProfileId: string | undefined): ValidationIssue[] {
  if (message.from.kind === "alphanumeric" && messagingProfileId === undefined) {
    return [
      {
        code: "invalid_sender",
        field: "from",
        message: "Telnyx requires messagingProfileId on the adapter to send from an alphanumeric sender ID.",
      },
    ];
  }
  return [];
}

/** Maps a Telnyx HTTP response to an adapter outcome. */
export function interpretTelnyxResponse(status: number, text: string, headers: Headers): AdapterSendOutcome {
  const requestId = headers.get("x-request-id");
  const body = parseJson(text);

  if (status >= 200 && status < 300) {
    const data = isRecord(body) && isRecord(body["data"]) ? body["data"] : undefined;
    const id = data === undefined ? undefined : readString(data, "id");
    if (data === undefined || id === undefined) {
      return {
        kind: "unknown",
        reason: "malformed_response",
        details: providerInfo({ provider: "telnyx", httpStatus: status, requestId }),
      };
    }
    return { kind: "accepted", providerId: id, delivery: telnyxDelivery(firstRecipientStatus(data)) };
  }

  if (status >= 400 && status < 500) {
    const firstError = firstTelnyxError(body);
    const code = firstError === undefined ? undefined : readCode(firstError, "code");
    const message = firstError === undefined ? undefined : (readString(firstError, "detail") ?? readString(firstError, "title"));
    const category = telnyxRejectionCategory(status, code);
    const retryAfterMs = category === "rate_limited" ? parseRetryAfter(headers.get("retry-after")) : undefined;
    return {
      kind: "rejected",
      category,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      details: providerInfo({ provider: "telnyx", httpStatus: status, code, message, requestId }),
    };
  }

  return unknownForStatus("telnyx", status, requestId);
}

/**
 * Rejection category for a Telnyx 4xx, from the error codes in Telnyx's
 * published error catalog. Unlisted codes are `request`.
 */
export function telnyxRejectionCategory(status: number, code: string | undefined): RejectionCategory {
  switch (code) {
    case "10009":
    case "10010":
    case "20001":
    case "20002":
    case "20003":
    case "20006":
    case "20008":
      return "auth";
    case "10011":
    case "40318":
      return "rate_limited";
    case "40300":
    case "40322":
      return "compliance";
    case "40310":
    case "40301":
    case "40319":
      return "recipient";
    case "40305":
    case "40306":
    case "40308":
    case "40315":
    case "40320":
    case "40321":
    case "40329":
    case "40330":
      return "sender";
    case "20013":
    case "20100":
    case "40309":
    case "40312":
    case "40314":
    case "40331":
    case "40333":
      return "account";
    default:
      break;
  }
  if (status === 401 || status === 403) {
    return "auth";
  }
  return status === 429 ? "rate_limited" : "request";
}

/** Delivery value for a Telnyx recipient `status`. */
export function telnyxDelivery(status: string | undefined): Delivery {
  switch (status) {
    case "queued":
    case "sending":
      return "queued";
    case "sent":
    case "delivery_unconfirmed":
      return "sent";
    case "delivered":
      return "delivered";
    case "sending_failed":
    case "delivery_failed":
    case "expired":
      return "undelivered";
    default:
      return "unknown";
  }
}

function firstRecipientStatus(data: Record<string, unknown>): string | undefined {
  const recipients = data["to"];
  if (!Array.isArray(recipients)) {
    return undefined;
  }
  const first: unknown = recipients[0];
  return isRecord(first) ? readString(first, "status") : undefined;
}

function firstTelnyxError(body: unknown): Record<string, unknown> | undefined {
  if (!isRecord(body) || !Array.isArray(body["errors"])) {
    return undefined;
  }
  const first: unknown = body["errors"][0];
  return isRecord(first) ? first : undefined;
}
