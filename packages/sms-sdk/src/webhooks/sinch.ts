import { hmac, timingSafeEqual, toBase64 } from "../core/crypto.js";
import { WebhookPayloadError, WebhookSignatureError, type WebhookFailureReason } from "../core/errors.js";
import { isRecord, readCode, readString } from "../core/http.js";
import { inboundEvent, type MessageStatusType, type SmsEvent, type SmsEventBase } from "./events.js";
import {
  hasBasicAuthorization,
  onlyEvent,
  parseDate,
  readWebhookBody,
  skipVerification,
  type BasicCallbackCredentials,
  type WebhookCommonOptions,
} from "./shared.js";

/** Default allowed clock skew for HMAC timestamps, in seconds. */
export const SINCH_DEFAULT_TOLERANCE_SEC = 300;

/**
 * How Sinch authenticates callbacks to your URL. Sinch's SMS docs describe
 * Basic credentials provisioned on the callback URL, and HMAC set up through
 * your account manager.
 */
export type SinchWebhookCredentials =
  | ({ readonly kind: "basic" } & BasicCallbackCredentials)
  | { readonly kind: "hmac"; readonly webhookSecret: string };

/** Options for {@link parseSinchWebhook}. */
export type SinchWebhookOptions = WebhookCommonOptions & {
  readonly credentials: SinchWebhookCredentials;
  /** Allowed clock skew for HMAC timestamps, in seconds. Default 300. */
  readonly toleranceSec?: number;
};

/** Result of {@link verifySinchSignature}. */
export type SinchWebhookVerification =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: WebhookFailureReason };

/**
 * Verifies a Sinch HMAC callback signature: base64 HMAC-SHA256 of
 * `rawBody.nonce.timestamp`, within `toleranceSec` of `now`.
 */
export async function verifySinchSignature(input: {
  readonly webhookSecret: string;
  readonly rawBody: string;
  readonly signature: string | null;
  readonly nonce: string | null;
  readonly timestamp: string | null;
  readonly toleranceSec?: number;
  readonly now?: number;
}): Promise<SinchWebhookVerification> {
  if (input.signature === null || input.nonce === null || input.timestamp === null || input.signature.length === 0) {
    return { valid: false, reason: "missing_signature" };
  }
  if (!/^\d+$/.test(input.timestamp)) {
    return { valid: false, reason: "malformed_signature" };
  }
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSec - Number(input.timestamp)) > (input.toleranceSec ?? SINCH_DEFAULT_TOLERANCE_SEC)) {
    return { valid: false, reason: "stale_timestamp" };
  }
  const expected = toBase64(await hmac("SHA-256", input.webhookSecret, `${input.rawBody}.${input.nonce}.${input.timestamp}`));
  return timingSafeEqual(expected, input.signature) ? { valid: true } : { valid: false, reason: "invalid_signature" };
}

/**
 * Parses a Sinch callback that carries one event.
 *
 * @throws {WebhookPayloadError} when the callback carries several recipient
 * reports. Use {@link parseSinchWebhooks} (or `parseSmsWebhooks`) for those.
 */
export async function parseSinchWebhook(options: SinchWebhookOptions): Promise<SmsEvent> {
  return onlyEvent("sinch", await parseSinchWebhooks(options));
}

/**
 * Parses a Sinch callback into every event it carries: one per entry of
 * `recipient_delivery_report`, or a single event otherwise.
 */
export async function parseSinchWebhooks(options: SinchWebhookOptions): Promise<SmsEvent[]> {
  const skip = skipVerification(options);
  const rawBody = await readWebhookBody(options.request, "sinch");
  if (!skip) {
    await verifySinchRequest(options, rawBody);
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new WebhookPayloadError("The sinch webhook body is not valid JSON.", { provider: "sinch" });
  }
  return interpretSinchEvents(body, options.detectKeywords ?? true);
}

async function verifySinchRequest(options: SinchWebhookOptions, rawBody: string): Promise<void> {
  const { credentials, request } = options;
  switch (credentials.kind) {
    case "basic": {
      const header = request.headers.get("authorization");
      if (!hasBasicAuthorization(header, credentials)) {
        throw new WebhookSignatureError("Sinch webhook Basic authorization failed.", {
          reason: header === null ? "missing_signature" : "invalid_signature",
          provider: "sinch",
        });
      }
      return;
    }
    case "hmac": {
      const verification = await verifySinchSignature({
        webhookSecret: credentials.webhookSecret,
        rawBody,
        signature: request.headers.get("x-sinch-webhook-signature"),
        nonce: request.headers.get("x-sinch-webhook-signature-nonce"),
        timestamp: request.headers.get("x-sinch-webhook-signature-timestamp"),
        ...(options.toleranceSec === undefined ? {} : { toleranceSec: options.toleranceSec }),
        now: (options.now ?? Date.now)(),
      });
      if (!verification.valid) {
        throw new WebhookSignatureError(`Sinch webhook verification failed (${verification.reason}).`, {
          reason: verification.reason,
          provider: "sinch",
        });
      }
      return;
    }
    default: {
      const _exhaustive: never = credentials;
      return _exhaustive;
    }
  }
}

/** Normalizes a verified Sinch payload into one event per inbound message or recipient report. */
export function interpretSinchEvents(body: unknown, detectKeywords: boolean): SmsEvent[] {
  if (!isRecord(body)) {
    throw new WebhookPayloadError("The sinch webhook must be a JSON object.", { provider: "sinch" });
  }
  const type = readString(body, "type") ?? "";
  const batchId = readString(body, "batch_id") ?? readString(body, "batchId");
  const inboundId = readString(body, "id") ?? readString(body, "message_id");
  const occurredAt = parseDate(readString(body, "at") ?? readString(body, "received_at"));
  const base: SmsEventBase = {
    provider: "sinch",
    dedupeKey: `sinch:${batchId ?? inboundId ?? "unknown"}:${type}`,
    raw: body,
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };

  if (type === "mo_text" || type === "mo_binary" || type === "inbound_sms") {
    const from = readString(body, "from");
    const to = readString(body, "to");
    const text = readString(body, "body");
    if (from === undefined || to === undefined || inboundId === undefined || text === undefined) {
      throw new WebhookPayloadError("The sinch inbound webhook is missing id, from, to, or body.", { provider: "sinch" });
    }
    return [
      inboundEvent({
        base: { ...base, dedupeKey: `sinch:${inboundId}:received` },
        providerId: inboundId,
        from: normalizePhone(from),
        to: normalizePhone(to),
        body: text,
        mediaUrls: [],
        providerSignal: undefined,
        detectKeywords,
      }),
    ];
  }

  const nested: unknown = body["recipient_delivery_report"];
  const reports: readonly unknown[] = Array.isArray(nested) ? nested : [body];
  if (reports.length === 0) {
    return [{ ...base, type: "unrecognized", providerEventType: type || "unknown" }];
  }
  return reports.map((report) => reportEvent({ report, base, type, batchId }));
}

function reportEvent(input: {
  readonly report: unknown;
  readonly base: SmsEventBase;
  readonly type: string;
  readonly batchId: string | undefined;
}): SmsEvent {
  const { report, base, type } = input;
  if (!isRecord(report)) {
    return { ...base, type: "unrecognized", providerEventType: type || "unknown" };
  }
  const batchId = input.batchId ?? readString(report, "batch_id");
  const status = readString(report, "status");
  const recipient = readString(report, "recipient");
  const code = readCode(report, "code");
  if (batchId === undefined || status === undefined) {
    return { ...base, type: "unrecognized", providerEventType: type || "unknown" };
  }
  const reportOccurredAt = parseDate(readString(report, "at")) ?? base.occurredAt;
  const reportBase: SmsEventBase = {
    ...base,
    dedupeKey: `sinch:${batchId}:${recipient ?? "summary"}:${status}`,
    ...(reportOccurredAt === undefined ? {} : { occurredAt: reportOccurredAt }),
  };
  const mapped = sinchStatus(status, code);
  if (mapped === undefined) {
    return { ...reportBase, type: "unrecognized", providerEventType: status };
  }
  return {
    ...reportBase,
    type: mapped,
    providerId: batchId,
    providerStatus: status,
    ...(recipient === undefined ? {} : { to: normalizePhone(recipient) }),
    ...(code === undefined ? {} : { errorCode: code }),
  };
}

function sinchStatus(status: string, code: string | undefined): MessageStatusType | undefined {
  switch (status.toLowerCase()) {
    case "queued":
    case "pending":
      return "message.queued";
    case "dispatched":
    case "sent":
    case "accepted":
      return "message.sent";
    case "delivered":
      return "message.delivered";
    case "aborted":
    case "failed":
    case "undelivered":
    case "expired":
      return "message.undelivered";
    case "filtered":
    case "rejected":
      return code === "40003" ? "message.filtered" : "message.undelivered";
    default:
      return undefined;
  }
}

function normalizePhone(value: string): string {
  return value.startsWith("+") ? value : `+${value}`;
}
