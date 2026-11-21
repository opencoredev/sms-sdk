import { hmac, timingSafeEqual, toBase64 } from "../core/crypto.js";
import { ConfigurationError, WebhookPayloadError, WebhookSignatureError } from "../core/errors.js";
import { isRecord, readCode, readString } from "../core/http.js";
import { inboundEvent, type MessageStatusType, type SmsEvent, type SmsEventBase } from "./events.js";
import {
  hasBasicAuthorization,
  onlyEvent,
  parseDate,
  readHeaderString,
  readWebhookRequest,
  requireBasicCredentials,
  requireTolerance,
  skipVerification,
  snapshotWebhookOptions,
  type BasicCallbackCredentials,
  type WebhookCommonOptions,
  type WebhookRequestSnapshot,
} from "./shared.js";
import type { WebhookVerification } from "./telnyx.js";

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
export type SinchWebhookVerification = WebhookVerification;

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
  let webhookSecret: unknown;
  let rawBody: unknown;
  let signature: unknown;
  let nonce: unknown;
  let timestamp: unknown;
  let toleranceSec: unknown;
  let now: unknown;
  try {
    if (!isRecord(input)) {
      throw new ConfigurationError("Sinch webhook webhookSecret must be a non-empty string.");
    }
    webhookSecret = input.webhookSecret;
    rawBody = input.rawBody;
    signature = input.signature;
    nonce = input.nonce;
    timestamp = input.timestamp;
    toleranceSec = input.toleranceSec;
    now = input.now;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("Sinch signature verification requires valid options.");
  }
  if (typeof webhookSecret !== "string" || webhookSecret.length === 0) {
    throw new ConfigurationError("Sinch webhook webhookSecret must be a non-empty string.");
  }
  const tolerance = requireTolerance(toleranceSec as number | undefined, SINCH_DEFAULT_TOLERANCE_SEC);
  if (now !== undefined && (typeof now !== "number" || !Number.isFinite(now))) {
    throw new ConfigurationError("Sinch signature verification now must be a finite number.");
  }
  if (typeof rawBody !== "string") {
    throw new ConfigurationError("Sinch signature verification rawBody must be a string.");
  }
  if (
    typeof signature !== "string" ||
    typeof nonce !== "string" ||
    typeof timestamp !== "string" ||
    signature.length === 0
  ) {
    return { valid: false, reason: "missing_signature" };
  }
  if (!/^\d+$/.test(timestamp)) {
    return { valid: false, reason: "malformed_signature" };
  }
  const nowSec = Math.floor((now ?? Date.now()) / 1000);
  if (!(Math.abs(nowSec - Number(timestamp)) <= tolerance)) {
    return { valid: false, reason: "stale_timestamp" };
  }
  const expected = toBase64(await hmac("SHA-256", webhookSecret, `${rawBody}.${nonce}.${timestamp}`));
  return timingSafeEqual(expected, signature) ? { valid: true } : { valid: false, reason: "invalid_signature" };
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
export async function parseSinchWebhooks(rawOptions: SinchWebhookOptions): Promise<SmsEvent[]> {
  const options = snapshotWebhookOptions<SinchWebhookOptions>(
    rawOptions,
    ["request", "credentials", "toleranceSec", "unsafeSkipVerification", "detectKeywords", "now"],
    ["kind", "username", "password", "webhookSecret"],
  );
  const skip = skipVerification(options);
  const req = await readWebhookRequest(options.request, "sinch");
  const { rawBody } = req;
  if (!skip) {
    await verifySinchRequest(options, req);
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new WebhookPayloadError("The sinch webhook body is not valid JSON.", { provider: "sinch" });
  }
  return interpretSinchEvents(body, options.detectKeywords ?? true);
}

async function verifySinchRequest(options: SinchWebhookOptions, req: WebhookRequestSnapshot): Promise<void> {
  const { credentials } = options;
  const { rawBody, headers } = req;
  if (!isRecord(credentials)) {
    throw new ConfigurationError('Sinch webhook credentials must specify kind: "basic" or "hmac".');
  }
  switch (credentials.kind) {
    case "basic": {
      requireBasicCredentials(credentials);
      const header = readHeaderString(headers, "authorization", "sinch");
      if (!hasBasicAuthorization(header, credentials)) {
        throw new WebhookSignatureError("Sinch webhook Basic authorization failed.", {
          reason: header === null ? "missing_signature" : "invalid_signature",
          provider: "sinch",
        });
      }
      return;
    }
    case "hmac": {
      if (typeof credentials.webhookSecret !== "string" || credentials.webhookSecret.length === 0) {
        throw new ConfigurationError("Sinch HMAC webhook credentials require a non-empty webhookSecret.");
      }
      const verification = await verifySinchSignature({
        webhookSecret: credentials.webhookSecret,
        rawBody,
        signature: readHeaderString(headers, "x-sinch-webhook-signature", "sinch"),
        nonce: readHeaderString(headers, "x-sinch-webhook-signature-nonce", "sinch"),
        timestamp: readHeaderString(headers, "x-sinch-webhook-signature-timestamp", "sinch"),
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
      void _exhaustive;
      throw new ConfigurationError('Sinch webhook credentials must specify kind: "basic" or "hmac".');
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
