import { fromBase64, utf8 } from "../core/crypto.js";
import { WebhookPayloadError, WebhookSignatureError, type WebhookFailureReason } from "../core/errors.js";
import { isRecord, readCode, readString } from "../core/http.js";
import { inboundEvent, type MessageStatusType, type SmsEvent, type SmsEventBase } from "./events.js";
import { parseDate, type WebhookCommonOptions } from "./shared.js";

/** Default replay window for `telnyx-timestamp`, matching Telnyx's guidance of 5 minutes. */
export const TELNYX_DEFAULT_TOLERANCE_SEC = 300;

/** Error codes Telnyx documents as spam or content filtering; mapped to `message.filtered`. */
const TELNYX_FILTERED_CODES = new Set(["40002", "40003", "40322"]);

/** Options for {@link parseTelnyxWebhook}. */
export type TelnyxWebhookOptions = WebhookCommonOptions & {
  /** The account's base64 Ed25519 public key (Mission Control: Keys & Credentials, Public Key). */
  readonly credentials: { readonly publicKey: string };
  /** Maximum age of `telnyx-timestamp`, in seconds. Default 300. */
  readonly toleranceSec?: number;
};

/** Result of a signature check: valid, or the reason it failed. */
export type WebhookVerification = { readonly valid: true } | { readonly valid: false; readonly reason: WebhookFailureReason };

/**
 * Verifies a Telnyx Ed25519 webhook signature over `${timestamp}|${rawBody}`,
 * and rejects timestamps more than `toleranceSec` from `now`.
 */
export async function verifyTelnyxSignature(input: {
  readonly publicKey: string;
  readonly rawBody: string;
  readonly signature: string | null;
  readonly timestamp: string | null;
  readonly toleranceSec?: number;
  readonly now?: number;
}): Promise<WebhookVerification> {
  if (input.signature === null || input.timestamp === null || input.signature.length === 0) {
    return { valid: false, reason: "missing_signature" };
  }
  if (!/^\d+$/.test(input.timestamp)) {
    return { valid: false, reason: "malformed_signature" };
  }
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSec - Number(input.timestamp)) > (input.toleranceSec ?? TELNYX_DEFAULT_TOLERANCE_SEC)) {
    return { valid: false, reason: "stale_timestamp" };
  }
  const keyBytes = fromBase64(input.publicKey);
  if (keyBytes === undefined || keyBytes.length !== 32) {
    return { valid: false, reason: "invalid_credentials" };
  }
  const signatureBytes = fromBase64(input.signature);
  if (signatureBytes === undefined || signatureBytes.length !== 64) {
    return { valid: false, reason: "malformed_signature" };
  }

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    return { valid: false, reason: "invalid_credentials" };
  }
  const valid = await crypto.subtle.verify("Ed25519", key, signatureBytes, utf8(`${input.timestamp}|${input.rawBody}`));
  return valid ? { valid: true } : { valid: false, reason: "invalid_signature" };
}

/**
 * Verifies and normalizes a Telnyx messaging webhook (`message.received`,
 * `message.sent`, `message.finalized`).
 *
 * @throws {WebhookSignatureError} when verification fails.
 * @throws {WebhookPayloadError} when required fields are missing.
 */
export async function parseTelnyxWebhook(options: TelnyxWebhookOptions): Promise<SmsEvent> {
  const rawBody = await options.request.text();

  if (options.unsafeSkipVerification !== true) {
    const verification = await verifyTelnyxSignature({
      publicKey: options.credentials.publicKey,
      rawBody,
      signature: options.request.headers.get("telnyx-signature-ed25519"),
      timestamp: options.request.headers.get("telnyx-timestamp"),
      ...(options.toleranceSec === undefined ? {} : { toleranceSec: options.toleranceSec }),
      now: (options.now ?? Date.now)(),
    });
    if (!verification.valid) {
      throw new WebhookSignatureError(`Telnyx webhook verification failed (${verification.reason}).`, {
        reason: verification.reason,
        provider: "telnyx",
      });
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new WebhookPayloadError("The telnyx webhook body is not valid JSON.", { provider: "telnyx" });
  }
  return interpretTelnyxEvent(body, options.detectKeywords ?? true);
}

/** Normalizes a verified Telnyx event envelope. */
export function interpretTelnyxEvent(body: unknown, detectKeywords: boolean): SmsEvent {
  const data = isRecord(body) && isRecord(body["data"]) ? body["data"] : undefined;
  const eventId = data === undefined ? undefined : readString(data, "id");
  const eventType = data === undefined ? undefined : readString(data, "event_type");
  if (data === undefined || eventId === undefined || eventType === undefined) {
    throw new WebhookPayloadError("The telnyx webhook is missing data.id or data.event_type.", { provider: "telnyx" });
  }
  const occurredAt = parseDate(readString(data, "occurred_at"));
  const base: SmsEventBase = {
    provider: "telnyx",
    dedupeKey: `telnyx:${eventId}`,
    raw: body,
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };

  if (eventType !== "message.received" && eventType !== "message.sent" && eventType !== "message.finalized") {
    return { ...base, type: "unrecognized", providerEventType: eventType };
  }

  const payload = isRecord(data["payload"]) ? data["payload"] : undefined;
  const messageId = payload === undefined ? undefined : readString(payload, "id");
  if (payload === undefined || messageId === undefined) {
    throw new WebhookPayloadError("The telnyx webhook is missing data.payload.id.", { provider: "telnyx" });
  }
  const from = isRecord(payload["from"]) ? readString(payload["from"], "phone_number") : undefined;
  const firstTo = firstRecord(payload["to"]);
  const to = firstTo === undefined ? undefined : readString(firstTo, "phone_number");

  if (eventType === "message.received") {
    if (from === undefined || to === undefined) {
      throw new WebhookPayloadError("The telnyx inbound webhook is missing from or to.", { provider: "telnyx" });
    }
    return inboundEvent({
      base,
      providerId: messageId,
      from,
      to,
      body: readString(payload, "text") ?? "",
      mediaUrls: mediaUrls(payload["media"]),
      providerSignal: undefined,
      detectKeywords,
    });
  }

  const status = firstTo === undefined ? undefined : readString(firstTo, "status");
  const firstError = firstRecord(payload["errors"]);
  const errorCode = firstError === undefined ? undefined : readCode(firstError, "code");
  const type = status === undefined ? undefined : telnyxStatusType(status, errorCode);
  if (status === undefined || type === undefined) {
    return { ...base, type: "unrecognized", providerEventType: `${eventType}:${status ?? "no_status"}` };
  }
  return {
    ...base,
    type,
    providerId: messageId,
    providerStatus: status,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

function telnyxStatusType(status: string, errorCode: string | undefined): MessageStatusType | undefined {
  switch (status) {
    case "queued":
    case "sending":
      return "message.queued";
    case "sent":
    case "delivery_unconfirmed":
      return "message.sent";
    case "delivered":
      return "message.delivered";
    case "sending_failed":
    case "delivery_failed":
    case "expired":
      return errorCode !== undefined && TELNYX_FILTERED_CODES.has(errorCode) ? "message.filtered" : "message.undelivered";
    default:
      return undefined;
  }
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const first: unknown = value[0];
  return isRecord(first) ? first : undefined;
}

function mediaUrls(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item: unknown) => {
    const url = isRecord(item) ? readString(item, "url") : undefined;
    return url === undefined ? [] : [url];
  });
}
