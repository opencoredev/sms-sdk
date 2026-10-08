import { hmac, timingSafeEqual, toBase64 } from "../core/crypto.js";
import { WebhookPayloadError, WebhookSignatureError } from "../core/errors.js";
import { inboundEvent, type MessageStatusType, type SmsEvent, type SmsEventBase } from "./events.js";
import {
  paramsToRecord,
  readFormParams,
  requireField,
  resolveSignedUrl,
  type SignedUrlOptions,
  type WebhookCommonOptions,
} from "./shared.js";

/** Options for {@link parsePlivoWebhook}. */
export type PlivoWebhookOptions = WebhookCommonOptions &
  SignedUrlOptions & {
    /** Auth Token of the account or subaccount (matched against `X-Plivo-Signature-V2`) or of the main account (`X-Plivo-Signature-Ma-V2`). */
    readonly credentials: { readonly authToken: string };
  };

/**
 * Computes a Plivo V2 signature: Base64(HMAC-SHA256(authToken, baseUrl + nonce)),
 * where `baseUrl` is the callback URL without its query string.
 */
export async function computePlivoSignatureV2(input: {
  readonly authToken: string;
  readonly url: string;
  readonly nonce: string;
}): Promise<string> {
  return toBase64(await hmac("SHA-256", input.authToken, plivoBaseUrl(input.url) + input.nonce));
}

/** Checks a Plivo V2 signature from `X-Plivo-Signature-V2` or `X-Plivo-Signature-Ma-V2`. */
export async function verifyPlivoSignatureV2(input: {
  readonly authToken: string;
  readonly url: string;
  readonly nonce: string;
  readonly signature: string;
}): Promise<boolean> {
  const expected = await computePlivoSignatureV2(input);
  return timingSafeEqual(expected, input.signature);
}

/**
 * Verifies and normalizes a Plivo messaging callback (delivery status or
 * inbound message).
 *
 * Plivo documents V2 signatures (`X-Plivo-Signature-V2` and its nonce) for
 * messaging callbacks; V3 is documented for Voice only. V2 signs the URL
 * and nonce but not the parameters and has no timestamp, so deduplicate with
 * `dedupeKey` to guard against replays.
 *
 * @throws {WebhookSignatureError} when verification fails.
 * @throws {WebhookPayloadError} when required fields are missing.
 */
export async function parsePlivoWebhook(options: PlivoWebhookOptions): Promise<SmsEvent> {
  const { request } = options;
  const rawBody = await request.text();

  if (options.unsafeSkipVerification !== true) {
    const nonce = request.headers.get("x-plivo-signature-v2-nonce");
    const signatures = [request.headers.get("x-plivo-signature-v2"), request.headers.get("x-plivo-signature-ma-v2")].filter(
      (value): value is string => value !== null && value.length > 0,
    );
    if (nonce === null || nonce.length === 0 || signatures.length === 0) {
      throw new WebhookSignatureError("Missing X-Plivo-Signature-V2 or its nonce.", {
        reason: "missing_signature",
        provider: "plivo",
      });
    }
    const url = resolveSignedUrl(request, options);
    let valid = false;
    for (const signature of signatures) {
      valid ||= await verifyPlivoSignatureV2({ authToken: options.credentials.authToken, url, nonce, signature });
    }
    if (!valid) {
      throw new WebhookSignatureError(
        "Invalid Plivo signature. Check the auth token and that publicUrl matches the callback URL.",
        { reason: "invalid_signature", provider: "plivo" },
      );
    }
  }

  return interpretPlivoParams(paramsToRecord(readFormParams(request, rawBody)), options.detectKeywords ?? true);
}

/** Normalizes verified Plivo callback fields. */
export function interpretPlivoParams(fields: Record<string, string>, detectKeywords: boolean): SmsEvent {
  const messageUuid = requireField("plivo", fields, "MessageUUID");
  const status = fields["Status"];

  if (status === undefined) {
    if (!("Text" in fields)) {
      throw new WebhookPayloadError("The plivo webhook has neither Status nor Text.", { provider: "plivo" });
    }
    const base: SmsEventBase = { provider: "plivo", dedupeKey: `plivo:${messageUuid}:received`, raw: fields };
    return inboundEvent({
      base,
      providerId: messageUuid,
      from: requireField("plivo", fields, "From"),
      to: requireField("plivo", fields, "To"),
      body: fields["Text"] ?? "",
      mediaUrls: plivoMediaUrls(fields),
      providerSignal: undefined,
      detectKeywords,
    });
  }

  const base: SmsEventBase = { provider: "plivo", dedupeKey: `plivo:${messageUuid}:${status}`, raw: fields };
  const type = plivoStatusType(status);
  if (type === undefined) {
    return { ...base, type: "unrecognized", providerEventType: status };
  }
  const errorCode = fields["ErrorCode"];
  return {
    ...base,
    type,
    providerId: messageUuid,
    providerStatus: status,
    ...(errorCode === undefined || errorCode.length === 0 || errorCode === "000" ? {} : { errorCode }),
    ...(fields["From"] === undefined ? {} : { from: fields["From"] }),
    ...(fields["To"] === undefined ? {} : { to: fields["To"] }),
  };
}

function plivoStatusType(status: string): MessageStatusType | undefined {
  switch (status) {
    case "queued":
      return "message.queued";
    case "sent":
      return "message.sent";
    case "delivered":
      return "message.delivered";
    case "undelivered":
    case "failed":
      return "message.undelivered";
    default:
      return undefined;
  }
}

function plivoMediaUrls(fields: Record<string, string>): string[] {
  const urls: string[] = [];
  for (let index = 0; fields[`Media${index}`] !== undefined; index += 1) {
    const url = fields[`Media${index}`];
    if (url !== undefined) {
      urls.push(url);
    }
  }
  return urls;
}

function plivoBaseUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}
