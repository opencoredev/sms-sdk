import { fromBase64, hmac, sha256Hex, timingSafeEqual, toBase64Url } from "../core/crypto.js";
import { WebhookPayloadError, WebhookSignatureError } from "../core/errors.js";
import { isRecord, readCode, readString } from "../core/http.js";
import { inboundEvent, type MessageStatusType, type SmsEvent, type SmsEventBase } from "./events.js";
import { parseDate, type WebhookCommonOptions } from "./shared.js";
import type { WebhookVerification } from "./telnyx.js";

/**
 * Default maximum age of the JWT `iat` claim, in seconds. Vonage does not
 * document a window; 300 seconds is this SDK's choice.
 */
export const VONAGE_DEFAULT_TOLERANCE_SEC = 300;

/** Messages API error codes for spam, fraud, or content filtering; mapped to `message.filtered`. */
const VONAGE_FILTERED_CODES = new Set(["1210", "1470", "1472", "1480", "1481", "1482", "1483"]);

/** Options for {@link parseVonageWebhook}. */
export type VonageWebhookOptions = WebhookCommonOptions & {
  /** The signature secret for the API key that signs the webhooks (Dashboard settings). */
  readonly credentials: { readonly signatureSecret: string };
  /** Maximum age of the JWT `iat` claim, in seconds. Default 300. */
  readonly toleranceSec?: number;
};

/**
 * Verifies a Vonage Messages API signed webhook: an HS256 JWT in
 * `Authorization: Bearer`, signed with the signature secret, with a fresh
 * `iat` and, when present, a `payload_hash` equal to the SHA-256 hex of the body.
 *
 * The hash is checked against the exact delivered bytes, as Vonage documents
 * ("a SHA-256 hash of the payload"). A re-serialized body is never accepted:
 * different bytes can parse to the same value, so it would not prove the body
 * is the one Vonage signed.
 */
export async function verifyVonageSignature(input: {
  readonly signatureSecret: string;
  readonly authorization: string | null;
  readonly rawBody: string;
  readonly toleranceSec?: number;
  readonly now?: number;
}): Promise<WebhookVerification> {
  const token = input.authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (token === undefined || token.length === 0) {
    return { valid: false, reason: "missing_signature" };
  }
  const parts = token.split(".");
  const [headerPart, payloadPart, signaturePart] = parts;
  if (parts.length !== 3 || headerPart === undefined || payloadPart === undefined || signaturePart === undefined) {
    return { valid: false, reason: "malformed_signature" };
  }

  const header = decodeJsonPart(headerPart);
  if (!isRecord(header) || header["alg"] !== "HS256") {
    return { valid: false, reason: "malformed_signature" };
  }
  const expected = toBase64Url(await hmac("SHA-256", input.signatureSecret, `${headerPart}.${payloadPart}`));
  if (!timingSafeEqual(expected, signaturePart)) {
    return { valid: false, reason: "invalid_signature" };
  }

  const claims = decodeJsonPart(payloadPart);
  const iat = isRecord(claims) ? claims["iat"] : undefined;
  if (!isRecord(claims) || typeof iat !== "number") {
    return { valid: false, reason: "malformed_signature" };
  }
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSec - iat) > (input.toleranceSec ?? VONAGE_DEFAULT_TOLERANCE_SEC)) {
    return { valid: false, reason: "stale_timestamp" };
  }

  const payloadHash = readString(claims, "payload_hash")?.toLowerCase();
  if (payloadHash !== undefined && !timingSafeEqual(await sha256Hex(input.rawBody), payloadHash)) {
    return { valid: false, reason: "body_hash_mismatch" };
  }
  return { valid: true };
}

/**
 * Verifies and normalizes a Vonage Messages API webhook (SMS status or inbound).
 *
 * @throws {WebhookSignatureError} when verification fails.
 * @throws {WebhookPayloadError} when required fields are missing.
 */
export async function parseVonageWebhook(options: VonageWebhookOptions): Promise<SmsEvent> {
  const rawBody = await options.request.text();

  if (options.unsafeSkipVerification !== true) {
    const verification = await verifyVonageSignature({
      signatureSecret: options.credentials.signatureSecret,
      authorization: options.request.headers.get("authorization"),
      rawBody,
      ...(options.toleranceSec === undefined ? {} : { toleranceSec: options.toleranceSec }),
      now: (options.now ?? Date.now)(),
    });
    if (!verification.valid) {
      throw new WebhookSignatureError(`Vonage webhook verification failed (${verification.reason}).`, {
        reason: verification.reason,
        provider: "vonage",
      });
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new WebhookPayloadError("The vonage webhook body is not valid JSON.", { provider: "vonage" });
  }
  return interpretVonageEvent(body, options.detectKeywords ?? true);
}

/** Normalizes a verified Vonage Messages API payload. */
export function interpretVonageEvent(body: unknown, detectKeywords: boolean): SmsEvent {
  if (!isRecord(body)) {
    throw new WebhookPayloadError("The vonage webhook body is not an object.", { provider: "vonage" });
  }
  const messageUuid = readString(body, "message_uuid");
  if (messageUuid === undefined) {
    throw new WebhookPayloadError("The vonage webhook is missing message_uuid.", { provider: "vonage" });
  }
  const occurredAt = parseDate(readString(body, "timestamp"));
  const from = normalizeNumber(readString(body, "from"));
  const to = normalizeNumber(readString(body, "to"));
  const status = readString(body, "status");

  if (status === undefined) {
    const text = body["text"];
    if (typeof text !== "string" || from === undefined || to === undefined) {
      throw new WebhookPayloadError("The vonage webhook has neither status nor an inbound text, from, and to.", {
        provider: "vonage",
      });
    }
    const base = eventBase(`vonage:${messageUuid}:received`, body, occurredAt);
    return inboundEvent({ base, providerId: messageUuid, from, to, body: text, mediaUrls: [], providerSignal: undefined, detectKeywords });
  }

  const base = eventBase(`vonage:${messageUuid}:${status}`, body, occurredAt);
  const errorCode = vonageWebhookErrorCode(body["error"]);
  const type = vonageStatusType(status, errorCode);
  if (type === undefined) {
    return { ...base, type: "unrecognized", providerEventType: status };
  }
  return {
    ...base,
    type,
    providerId: messageUuid,
    providerStatus: status,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

function vonageStatusType(status: string, errorCode: string | undefined): MessageStatusType | undefined {
  switch (status) {
    case "submitted":
      return "message.sent";
    case "delivered":
      return "message.delivered";
    case "rejected":
    case "undeliverable":
      return errorCode !== undefined && VONAGE_FILTERED_CODES.has(errorCode) ? "message.filtered" : "message.undelivered";
    default:
      return undefined;
  }
}

function vonageWebhookErrorCode(error: unknown): string | undefined {
  if (!isRecord(error)) {
    return undefined;
  }
  const fragment = readString(error, "type")?.match(/#(\d+)$/)?.[1];
  return fragment ?? readCode(error, "title");
}

function eventBase(dedupeKey: string, raw: unknown, occurredAt: Date | undefined): SmsEventBase {
  return { provider: "vonage", dedupeKey, raw, ...(occurredAt === undefined ? {} : { occurredAt }) };
}

/** Vonage omits the `+`; restore it for digit-only numbers so they match E.164. */
function normalizeNumber(value: string | undefined): string | undefined {
  return value !== undefined && /^[1-9]\d{1,14}$/.test(value) ? `+${value}` : value;
}

function decodeJsonPart(part: string): unknown {
  const bytes = fromBase64(part);
  if (bytes === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return undefined;
  }
}


