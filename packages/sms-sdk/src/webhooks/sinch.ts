import { hmac, timingSafeEqual, toBase64 } from "../core/crypto.js";
import { WebhookPayloadError, WebhookSignatureError, type WebhookFailureReason } from "../core/errors.js";
import { isRecord, readCode, readString } from "../core/http.js";
import { inboundEvent, type MessageStatusType, type SmsEvent, type SmsEventBase } from "./events.js";
import { hasBasicAuthorization, parseDate, type BasicCallbackCredentials, type WebhookCommonOptions } from "./shared.js";

export const SINCH_DEFAULT_TOLERANCE_SEC = 300;
/**
 * How Sinch authenticates callbacks to your URL. Sinch's SMS docs describe
 * Basic credentials provisioned on the callback URL, and HMAC set up through
 * your account manager.
 */
export type SinchWebhookCredentials =
  | ({ readonly kind: "basic" } & BasicCallbackCredentials)
  | { readonly kind: "hmac"; readonly webhookSecret: string };

export type SinchWebhookOptions = WebhookCommonOptions & {
  readonly credentials: SinchWebhookCredentials;
  /** Allowed clock skew for HMAC timestamps, in seconds. Default 300. */
  readonly toleranceSec?: number;
};
export type SinchWebhookVerification = { readonly valid: true } | { readonly valid: false; readonly reason: WebhookFailureReason };

export async function verifySinchSignature(input: { readonly webhookSecret: string; readonly rawBody: string; readonly signature: string | null; readonly nonce: string | null; readonly timestamp: string | null; readonly toleranceSec?: number; readonly now?: number }): Promise<SinchWebhookVerification> {
  if (input.signature === null || input.nonce === null || input.timestamp === null || input.signature.length === 0) return { valid: false, reason: "missing_signature" };
  if (!/^\d+$/.test(input.timestamp)) return { valid: false, reason: "malformed_signature" };
  const nowSec = Math.floor((input.now ?? Date.now()) / 1000);
  if (Math.abs(nowSec - Number(input.timestamp)) > (input.toleranceSec ?? SINCH_DEFAULT_TOLERANCE_SEC)) return { valid: false, reason: "stale_timestamp" };
  const expected = toBase64(await hmac("SHA-256", input.webhookSecret, `${input.rawBody}.${input.nonce}.${input.timestamp}`));
  return timingSafeEqual(expected, input.signature) ? { valid: true } : { valid: false, reason: "invalid_signature" };
}

export async function parseSinchWebhook(options: SinchWebhookOptions): Promise<SmsEvent> {
  const rawBody = await options.request.text();
  if (options.unsafeSkipVerification !== true) {
    await verifySinchRequest(options, rawBody);
  }
  let body: unknown;
  try { body = JSON.parse(rawBody); } catch { throw new WebhookPayloadError("The sinch webhook body is not valid JSON.", { provider: "sinch" }); }
  return interpretSinchEvent(body, options.detectKeywords ?? true);
}

async function verifySinchRequest(options: SinchWebhookOptions, rawBody: string): Promise<void> {
  const { credentials, request } = options;
  switch (credentials.kind) {
    case "basic": {
      const header = request.headers.get("authorization");
      if (!hasBasicAuthorization(header, credentials)) {
        throw new WebhookSignatureError("Sinch webhook Basic authorization failed.", { reason: header === null ? "missing_signature" : "invalid_signature", provider: "sinch" });
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
        throw new WebhookSignatureError(`Sinch webhook verification failed (${verification.reason}).`, { reason: verification.reason, provider: "sinch" });
      }
      return;
    }
    default: {
      const _exhaustive: never = credentials;
      return _exhaustive;
    }
  }
}

export function interpretSinchEvent(body: unknown, detectKeywords: boolean): SmsEvent {
  if (!isRecord(body)) throw new WebhookPayloadError("The sinch webhook must be a JSON object.", { provider: "sinch" });
  const type = readString(body, "type") ?? "";
  const batchId = readString(body, "batch_id") ?? readString(body, "batchId");
  const inboundId = readString(body, "id") ?? readString(body, "message_id");
  const occurredAt = parseDate(readString(body, "at") ?? readString(body, "received_at"));
  const base: SmsEventBase = { provider: "sinch", dedupeKey: `sinch:${batchId ?? inboundId ?? "unknown"}:${type}`, raw: body, ...(occurredAt === undefined ? {} : { occurredAt }) };
  if (type === "mo_text" || type === "mo_binary" || type === "inbound_sms") {
    const from = readString(body, "from"); const to = readString(body, "to"); const messageId = inboundId; const text = readString(body, "body");
    if (from === undefined || to === undefined || messageId === undefined || text === undefined) throw new WebhookPayloadError("The sinch inbound webhook is missing id, from, to, or body.", { provider: "sinch" });
    return inboundEvent({ base: { ...base, dedupeKey: `sinch:${messageId}:received` }, providerId: messageId, from: normalizePhone(from), to: normalizePhone(to), body: text, mediaUrls: [], providerSignal: undefined, detectKeywords });
  }
  const reports = Array.isArray(body["recipient_delivery_report"]) ? body["recipient_delivery_report"] : [body];
  const report = reports[0];
  if (!isRecord(report)) return { ...base, type: "unrecognized", providerEventType: type || "unknown" };
  const status = readString(report, "status"); const recipient = readString(report, "recipient"); const code = readCode(report, "code");
  if (batchId === undefined || status === undefined) return { ...base, type: "unrecognized", providerEventType: type || "unknown" };
  const mapped = sinchStatus(status, code); const eventBase = { ...base, dedupeKey: `sinch:${batchId}:${recipient ?? "summary"}:${status}` };
  if (mapped === undefined) return { ...eventBase, type: "unrecognized", providerEventType: status };
  return { ...eventBase, type: mapped, providerId: batchId, providerStatus: status, ...(recipient === undefined ? {} : { to: normalizePhone(recipient) }), ...(code === undefined ? {} : { errorCode: code }) };
}

function sinchStatus(status: string, code: string | undefined): MessageStatusType | undefined {
  switch (status.toLowerCase()) {
    case "queued": case "pending": return "message.queued";
    case "sent": case "accepted": return "message.sent";
    case "delivered": return "message.delivered";
    case "failed": case "undelivered": case "expired": return "message.undelivered";
    case "filtered": case "rejected": return code === "40003" ? "message.filtered" : "message.undelivered";
    default: return undefined;
  }
}
function normalizePhone(value: string): string { return value.startsWith("+") ? value : `+${value}`; }
