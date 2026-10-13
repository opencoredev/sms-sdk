/**
 * Bandwidth Messaging API v2 SMS adapter.
 *
 * @see https://dev.bandwidth.com/docs/messaging
 * @packageDocumentation
 */

import type {
  AdapterMessage,
  AdapterSendOutcome,
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

const MAX_TEXT_LENGTH = 2048;

export type BandwidthOptions = {
  /** Bandwidth account/user ID used in the API path. */
  readonly userId: string;
  /** API token used as the Basic-auth username. */
  readonly apiToken: string;
  /** API secret used as the Basic-auth password. */
  readonly apiSecret: string;
  /** Bandwidth application ID associated with the sending number. */
  readonly applicationId: string;
  /** Default Bandwidth long code, toll-free number, or short code. */
  readonly from?: SmsFrom;
  /** API origin. Default `https://messaging.bandwidth.com`. */
  readonly baseUrl?: string;
  /** Custom `fetch`, for tests or runtimes without a global one. */
  readonly fetch?: FetchLike;
};

export const BANDWIDTH_CAPABILITIES: SmsCapabilities = {
  sendText: true,
  mms: false,
  scheduling: false,
  validityPeriod: null,
  webhookUrlOverride: false,
  inbound: true,
  deliveryReceipts: true,
  senderTypes: ["long_code", "toll_free", "short_code"],
  nativeIdempotency: false,
};

export const BANDWIDTH_SUPPORT_NOTES: readonly string[] = [
  "Bandwidth does not sign messaging callbacks; authenticate the webhook endpoint with application-level controls and deduplicate events using `dedupeKey`.",
  "The adapter intentionally supports the SMS endpoint only; Bandwidth MMS media is not enabled through this adapter.",
];

export const BANDWIDTH_PROVIDER_OPTIONS = {
  options: {
    /** Provider-side tracking tag, returned in callbacks. */
    tag: { type: "string", wire: "tag", maxLength: 1024 },
    /** Carrier delivery priority. */
    priority: { type: "enum", wire: "priority", values: ["default", "high"] },
  },
  reserved: ["from", "to", "text", "applicationId", "media", "expirationTime"],
} as const satisfies ProviderOptionsSpec;

export type BandwidthSendOptions = ProviderOptionsOf<typeof BANDWIDTH_PROVIDER_OPTIONS>;

declare module "../core/types.js" {
  interface SmsProviderOptions {
    readonly bandwidth?: BandwidthSendOptions;
  }
}

export type BandwidthMessageRequest = {
  [option: string]: string | string[] | undefined;
  from: string;
  to: string[];
  text: string;
  applicationId: string;
  media?: string[];
};

export function bandwidth(options: BandwidthOptions): SmsAdapter {
  requireValue(options.userId, "userId");
  requireValue(options.apiToken, "apiToken");
  requireValue(options.apiSecret, "apiSecret");
  requireValue(options.applicationId, "applicationId");
  const baseUrl = (options.baseUrl ?? "https://messaging.bandwidth.com").replace(/\/+$/, "");
  const url = `${baseUrl}/api/v2/users/${encodeURIComponent(options.userId)}/messages`;
  const fetcher: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const authorization = basicAuthorization(options.apiToken, options.apiSecret);

  return {
    name: "bandwidth",
    capabilities: BANDWIDTH_CAPABILITIES,
    support: { status: "partial", notes: BANDWIDTH_SUPPORT_NOTES },
    providerOptions: BANDWIDTH_PROVIDER_OPTIONS,
    ...(options.from === undefined ? {} : { defaultFrom: options.from }),
    validate(message): readonly ValidationIssue[] {
      if (message.from.kind === "messaging_service" || message.from.kind === "alphanumeric") {
        return [{ code: "invalid_sender", field: "from", provider: "bandwidth", message: "Bandwidth SMS requires a phone number or short code sender." }];
      }
      if (message.body.length > MAX_TEXT_LENGTH) {
        return [{ code: "invalid_field", field: "body", provider: "bandwidth", message: `Bandwidth SMS text must be at most ${MAX_TEXT_LENGTH} characters.` }];
      }
      return [];
    },
    async send(message, context) {
      const response = await exchange(fetcher, url, {
        method: "POST",
        headers: { Authorization: authorization, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(buildBandwidthRequest(message, options.applicationId)),
        signal: context.signal,
      });
      if (response.kind === "failed") return { kind: "unknown", reason: "network", cause: response.cause };
      return interpretBandwidthResponse(response.status, response.text, response.headers);
    },
  };
}

export function buildBandwidthRequest(message: AdapterMessage, applicationId: string): BandwidthMessageRequest {
  const request: BandwidthMessageRequest = {
    from: message.from.value,
    to: [message.to],
    text: message.body,
    applicationId,
  };
  for (const field of message.providerFields ?? []) request[field.wire] = String(field.value);
  return request;
}

export function interpretBandwidthResponse(status: number, text: string, headers: Headers): AdapterSendOutcome {
  const body = parseJson(text);
  const record = isRecord(body) ? body : undefined;
  const providerId = record === undefined ? undefined : readString(record, "id");
  const requestId = headers.get("x-request-id") ?? headers.get("x-correlation-id");
  if (status >= 200 && status < 300) {
    if (providerId === undefined) return { kind: "unknown", reason: "malformed_response", details: providerInfo({ provider: "bandwidth", httpStatus: status, requestId }) };
    return { kind: "accepted", providerId, delivery: "queued" };
  }
  if (status >= 400 && status < 500) {
    // A 429 counts as Bandwidth's rate limit only when Bandwidth wrote the body.
    // A proxy or CDN 429 proves nothing about whether the message was created.
    if (status === 429 && !isBandwidthErrorBody(record)) return unknownForStatus("bandwidth", status, requestId);
    const category = bandwidthRejectionCategory(status);
    const retryAfterMs = category === "rate_limited" ? parseRetryAfter(headers.get("retry-after")) : undefined;
    const message = record === undefined ? undefined : readString(record, "description") ?? readString(record, "error");
    const code = record === undefined ? undefined : readCode(record, "errorCode") ?? readCode(record, "code");
    return { kind: "rejected", category, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), details: providerInfo({ provider: "bandwidth", httpStatus: status, code, message, requestId }) };
  }
  return unknownForStatus("bandwidth", status, requestId);
}

export function bandwidthRejectionCategory(status: number): RejectionCategory {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 404) return "account";
  return "request";
}

function isBandwidthErrorBody(record: Record<string, unknown> | undefined): boolean {
  return record !== undefined && (readString(record, "description") !== undefined || readString(record, "type") !== undefined);
}

function requireValue(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) throw new ConfigurationError(`Bandwidth ${field} is required.`);
}
