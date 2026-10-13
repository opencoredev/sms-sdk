/** Sinch SMS REST API adapter (`POST /xms/v1/{servicePlanId}/batches`). */
import type { AdapterMessage, AdapterSendOutcome, Delivery, ProviderOptionValue, ProviderOptionsOf, ProviderOptionsSpec, RejectionCategory, SmsAdapter, SmsCapabilities, SmsFrom, ValidationIssue } from "../core/adapters.js";
import { ConfigurationError } from "../core/errors.js";
import { exchange, isRecord, parseJson, parseRetryAfter, providerInfo, readCode, readString, unknownForStatus, type FetchLike } from "../core/http.js";

export type SinchOptions = {
  readonly servicePlanId: string;
  readonly apiToken: string;
  readonly from?: SmsFrom;
  readonly baseUrl?: string;
  readonly fetch?: FetchLike;
};

export const SINCH_CAPABILITIES: SmsCapabilities = {
  sendText: true, mms: false, scheduling: true, validityPeriod: { minSec: 1, maxSec: 2_592_000 },
  webhookUrlOverride: true, inbound: true, deliveryReceipts: true,
  senderTypes: ["long_code", "toll_free", "short_code", "alphanumeric"], nativeIdempotency: false,
};

export const SINCH_SUPPORT_NOTES: readonly string[] = [
  "Sinch documents Basic and OAuth 2.0 callback authentication for SMS and sets up HMAC through your account manager without publishing its format. The webhook parser requires Basic credentials or an HMAC secret; OAuth 2.0 callbacks are not supported.",
  "Sinch reports are per-recipient and can be retried or reordered; deduplicate using the batch, recipient, and status key.",
];

export const SINCH_PROVIDER_OPTIONS = {
  options: {
    deliveryReport: { type: "enum", wire: "delivery_report", values: ["none", "per_recipient", "per_recipient_final", "summary", "full"] },
    clientReference: { type: "string", wire: "client_reference", maxLength: 128 },
    maxNumberOfMessageParts: { type: "integer", wire: "max_number_of_message_parts", min: 1, max: 255 },
  },
  reserved: ["from", "to", "body", "send_at", "expire_at", "callback_url"],
} as const satisfies ProviderOptionsSpec;

export type SinchSendOptions = ProviderOptionsOf<typeof SINCH_PROVIDER_OPTIONS>;

declare module "../index.js" {
  interface SmsProviderOptions { readonly sinch?: SinchSendOptions; }
}

export type SinchBatchRequest = {
  [option: string]: ProviderOptionValue | string[] | undefined;
  from: string;
  to: string[];
  body: string;
  send_at?: string;
  expire_at?: string;
  callback_url?: string;
};

export function sinch(options: SinchOptions): SmsAdapter {
  if (options.servicePlanId.length === 0) throw new ConfigurationError("Sinch servicePlanId is required.");
  if (options.apiToken.length === 0) throw new ConfigurationError("Sinch apiToken is required.");
  const baseUrl = (options.baseUrl ?? "https://sms.api.sinch.com").replace(/\/+$/, "");
  const url = `${baseUrl}/xms/v1/${encodeURIComponent(options.servicePlanId)}/batches`;
  const fetcher: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    name: "sinch", capabilities: SINCH_CAPABILITIES, support: { status: "partial", notes: SINCH_SUPPORT_NOTES }, providerOptions: SINCH_PROVIDER_OPTIONS,
    ...(options.from === undefined ? {} : { defaultFrom: options.from }),
    validate: validateSinchMessage,
    async send(message, context) {
      const response = await exchange(fetcher, url, {
        method: "POST", headers: { Authorization: `Bearer ${options.apiToken}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(buildSinchRequest(message)), signal: context.signal,
      });
      if (response.kind === "failed") return { kind: "unknown", reason: "network", cause: response.cause };
      return interpretSinchResponse(response.status, response.text, response.headers);
    },
  };
}

export function buildSinchRequest(message: AdapterMessage): SinchBatchRequest {
  const request: SinchBatchRequest = { from: message.from.value, to: [message.to], body: message.body };
  if (message.sendAt !== undefined) request.send_at = message.sendAt.toISOString();
  if (message.validityPeriodSec !== undefined) request.expire_at = new Date(Date.now() + message.validityPeriodSec * 1000).toISOString();
  if (message.webhookUrl !== undefined) request.callback_url = message.webhookUrl;
  for (const field of message.providerFields ?? []) request[field.wire] = field.value;
  return request;
}

function validateSinchMessage(message: AdapterMessage): ValidationIssue[] {
  return message.body.length === 0 ? [{ code: "empty_body", field: "body", message: "Sinch SMS requires a non-empty text body." }] : [];
}

export function interpretSinchResponse(status: number, text: string, headers: Headers): AdapterSendOutcome {
  const body = parseJson(text); const requestId = headers.get("x-request-id");
  if (status >= 200 && status < 300) {
    const id = isRecord(body) ? readString(body, "id") : undefined;
    if (id === undefined) return { kind: "unknown", reason: "malformed_response", details: providerInfo({ provider: "sinch", httpStatus: status, requestId }) };
    return { kind: "accepted", providerId: id, delivery: "queued" };
  }
  if (status >= 400 && status < 500) {
    const error = isRecord(body) ? body : undefined;
    const code = error === undefined ? undefined : readCode(error, "code");
    const message = error === undefined ? undefined : (readString(error, "text") ?? readString(error, "message"));
    const category = sinchRejectionCategory(status, code);
    if (status === 429 && category !== "rate_limited") return unknownForStatus("sinch", status, requestId);
    const retryAfterMs = category === "rate_limited" ? parseRetryAfter(headers.get("retry-after")) : undefined;
    return { kind: "rejected", category, ...(retryAfterMs === undefined ? {} : { retryAfterMs }), details: providerInfo({ provider: "sinch", httpStatus: status, code, message, requestId }) };
  }
  return unknownForStatus("sinch", status, requestId);
}

export function sinchRejectionCategory(status: number, code: string | undefined): RejectionCategory {
  if (status === 401 || status === 403) return "auth";
  if (status === 429 && (code === "429" || code === "TOO_MANY_REQUESTS")) return "rate_limited";
  if (code === "40002" || code === "40003") return "recipient";
  if (code === "40004" || code === "40005") return "sender";
  if (code === "40301" || code === "40302") return "account";
  return "request";
}

export function sinchDelivery(status: string | undefined): Delivery {
  switch (status?.toLowerCase()) {
    case "queued": case "pending": return "queued";
    case "sent": case "accepted": return "sent";
    case "delivered": return "delivered";
    case "failed": case "undelivered": case "expired": return "undelivered";
    case "filtered": case "rejected": return "filtered";
    default: return "unknown";
  }
}
