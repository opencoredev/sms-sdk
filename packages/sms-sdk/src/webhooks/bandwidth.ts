import { WebhookPayloadError, WebhookSignatureError } from "../core/errors.js";
import { isRecord, readCode, readString } from "../core/http.js";
import { inboundEvent, type MessageStatusType, type SmsEvent, type SmsEventBase } from "./events.js";
import { hasBasicAuthorization, parseDate, type BasicCallbackCredentials, type WebhookCommonOptions } from "./shared.js";

/** The Basic credentials configured on the Bandwidth application's callback. */
export type BandwidthWebhookCredentials = BasicCallbackCredentials;

export type BandwidthWebhookOptions = WebhookCommonOptions & {
  /** Basic credentials set on the Bandwidth application. Bandwidth does not sign callbacks, so these are the only proof a request came from Bandwidth. */
  readonly credentials: BandwidthWebhookCredentials;
};

/**
 * Parses a Bandwidth Messaging callback. Bandwidth sends an array of events and
 * does not sign callbacks, so the parser checks the request's Basic
 * authorization against `credentials` before interpreting it.
 */
export async function parseBandwidthWebhook(options: BandwidthWebhookOptions): Promise<SmsEvent> {
  const rawBody = await options.request.text();
  if (options.unsafeSkipVerification !== true) {
    const header = options.request.headers.get("authorization");
    if (!hasBasicAuthorization(header, options.credentials)) {
      throw new WebhookSignatureError("Bandwidth webhook Basic authorization failed.", {
        reason: header === null ? "missing_signature" : "invalid_signature",
        provider: "bandwidth",
      });
    }
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new WebhookPayloadError("The bandwidth webhook body is not valid JSON.", { provider: "bandwidth" });
  }
  return interpretBandwidthEvent(body, options.detectKeywords ?? true);
}

export function interpretBandwidthEvent(body: unknown, detectKeywords: boolean): SmsEvent {
  if (!Array.isArray(body) || body.length !== 1 || !isRecord(body[0])) {
    throw new WebhookPayloadError("The bandwidth webhook body must contain exactly one event.", { provider: "bandwidth" });
  }
  const event = body[0];
  const type = readString(event, "type");
  const message = isRecord(event["message"]) ? event["message"] : undefined;
  if (type === undefined || message === undefined) {
    throw new WebhookPayloadError("The bandwidth webhook is missing type or message.", { provider: "bandwidth" });
  }
  const providerId = readString(message, "id");
  if (providerId === undefined) throw new WebhookPayloadError("The bandwidth webhook is missing message.id.", { provider: "bandwidth" });
  const occurredAt = parseDate(readString(event, "time") ?? readString(message, "time"));
  const base: SmsEventBase = {
    provider: "bandwidth",
    dedupeKey: `bandwidth:${providerId}:${type}`,
    raw: body,
    ...(occurredAt === undefined ? {} : { occurredAt }),
  };
  if (type === "message-received") {
    const from = readString(message, "from");
    const to = firstString(message["to"]);
    if (from === undefined || to === undefined) throw new WebhookPayloadError("The bandwidth inbound webhook is missing message.from or message.to.", { provider: "bandwidth" });
    return inboundEvent({ base, providerId, from, to, body: readString(message, "text") ?? "", mediaUrls: strings(message["media"]), providerSignal: undefined, detectKeywords });
  }
  const status = bandwidthStatus(type);
  if (status === undefined) return { ...base, type: "unrecognized", providerEventType: type };
  const to = readString(event, "to") ?? firstString(message["to"]);
  const errorCode = readCode(event, "errorCode") ?? readCode(message, "errorCode");
  const from = readString(message, "from");
  return { ...base, type: status, providerId, providerStatus: type, ...(errorCode === undefined ? {} : { errorCode }), ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) };
}

function bandwidthStatus(type: string): MessageStatusType | undefined {
  switch (type) {
    case "message-sending": return "message.queued";
    case "message-delivered": return "message.delivered";
    case "message-failed": return "message.undelivered";
    default: return undefined;
  }
}

function firstString(value: unknown): string | undefined {
  return Array.isArray(value) && typeof value[0] === "string" && value[0].length > 0 ? value[0] : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}
