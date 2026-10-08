import { WebhookPayloadError, WebhookSignatureError } from "../core/errors.js";
import { hmac, sha256Hex, timingSafeEqual, toBase64 } from "../core/crypto.js";
import { inboundEvent, type MessageStatusType, type SmsEvent, type SmsEventBase } from "./events.js";
import {
  paramsToRecord,
  readFormParams,
  requireField,
  resolveSignedUrl,
  type SignedUrlOptions,
  type WebhookCommonOptions,
} from "./shared.js";

/** Options for {@link parseTwilioWebhook}. */
export type TwilioWebhookOptions = WebhookCommonOptions &
  SignedUrlOptions & {
    /** The primary Auth Token of the account that owns the number. */
    readonly credentials: { readonly authToken: string };
  };

/**
 * Computes `X-Twilio-Signature`: Base64(HMAC-SHA1(authToken, url + sorted
 * params)). Parameters are sorted by name (case-sensitive), repeated names
 * by value, and each name and value appended with no delimiter.
 */
export async function computeTwilioSignature(input: {
  readonly authToken: string;
  readonly url: string;
  readonly params: ReadonlyArray<readonly [string, string]>;
}): Promise<string> {
  const grouped = new Map<string, string[]>();
  for (const [key, value] of input.params) {
    grouped.set(key, [...(grouped.get(key) ?? []), value]);
  }
  let data = input.url;
  for (const key of [...grouped.keys()].sort()) {
    for (const value of (grouped.get(key) ?? []).sort()) {
      data += key + value;
    }
  }
  return toBase64(await hmac("SHA-1", input.authToken, data));
}

/**
 * Checks `X-Twilio-Signature`. Twilio may sign the URL with or without the
 * default port, so both forms are tried.
 */
export async function verifyTwilioSignature(input: {
  readonly authToken: string;
  readonly url: string;
  readonly params: ReadonlyArray<readonly [string, string]>;
  readonly signature: string;
}): Promise<boolean> {
  for (const url of urlVariants(input.url)) {
    const expected = await computeTwilioSignature({ authToken: input.authToken, url, params: input.params });
    if (timingSafeEqual(expected, input.signature)) {
      return true;
    }
  }
  return false;
}

/**
 * Verifies and normalizes a Twilio Messaging webhook (inbound message or
 * status callback).
 *
 * Form-encoded requests are signed over the URL plus sorted POST parameters.
 * JSON requests carry `bodySHA256` in the query string; the body hash is
 * checked and the signature covers the URL alone.
 *
 * @throws {WebhookSignatureError} when verification fails.
 * @throws {WebhookPayloadError} when required fields are missing.
 */
export async function parseTwilioWebhook(options: TwilioWebhookOptions): Promise<SmsEvent> {
  const { request } = options;
  const rawBody = await request.text();
  const url = resolveSignedUrl(request, options);
  const bodyHash = new URL(url).searchParams.get("bodySHA256");
  const isJson = (request.headers.get("content-type") ?? "").toLowerCase().includes("application/json");
  const jsonMode = isJson && bodyHash !== null;

  // JSON signatures cover the URL alone, so the body is parsed only after the
  // signature and body hash pass. Form parameters are part of the signature.
  const formParams = jsonMode ? [] : readFormParams(request, rawBody);

  if (options.unsafeSkipVerification !== true) {
    const signature = request.headers.get("x-twilio-signature");
    if (signature === null || signature.length === 0) {
      throw new WebhookSignatureError("Missing X-Twilio-Signature header.", { reason: "missing_signature", provider: "twilio" });
    }
    if (jsonMode && !timingSafeEqual(await sha256Hex(rawBody), bodyHash.toLowerCase())) {
      throw new WebhookSignatureError("Twilio bodySHA256 does not match the request body.", {
        reason: "body_hash_mismatch",
        provider: "twilio",
      });
    }
    const signedParams = request.method.toUpperCase() === "GET" ? [] : formParams;
    const valid = await verifyTwilioSignature({
      authToken: options.credentials.authToken,
      url,
      params: signedParams,
      signature,
    });
    if (!valid) {
      throw new WebhookSignatureError(
        "Invalid X-Twilio-Signature. Check the auth token and that publicUrl matches the URL configured in Twilio.",
        { reason: "invalid_signature", provider: "twilio" },
      );
    }
  }

  const params = jsonMode ? jsonParams(rawBody) : formParams;
  return interpretTwilioParams(paramsToRecord(params), options.detectKeywords ?? true);
}

/** Normalizes verified Twilio webhook fields. */
export function interpretTwilioParams(fields: Record<string, string>, detectKeywords: boolean): SmsEvent {
  const messageSid = fields["MessageSid"] ?? fields["SmsSid"];
  if (messageSid === undefined || messageSid.length === 0) {
    throw new WebhookPayloadError("The twilio webhook is missing MessageSid.", { provider: "twilio" });
  }
  const status = fields["MessageStatus"] ?? fields["SmsStatus"];
  const isInbound = "Body" in fields && (status === undefined || status === "received" || status === "receiving");

  if (isInbound) {
    const base: SmsEventBase = { provider: "twilio", dedupeKey: `twilio:${messageSid}:received`, raw: fields };
    const optOutType = fields["OptOutType"]?.toUpperCase();
    return inboundEvent({
      base,
      providerId: messageSid,
      from: requireField("twilio", fields, "From"),
      to: requireField("twilio", fields, "To"),
      body: fields["Body"] ?? "",
      mediaUrls: twilioMediaUrls(fields),
      providerSignal:
        optOutType === "STOP" ? "opted_out" : optOutType === "START" ? "opted_in" : optOutType === "HELP" ? "help" : undefined,
      ...(optOutType === undefined ? {} : { providerKeyword: optOutType }),
      detectKeywords,
    });
  }

  if (status === undefined) {
    throw new WebhookPayloadError("The twilio webhook has neither Body nor MessageStatus.", { provider: "twilio" });
  }
  const base: SmsEventBase = { provider: "twilio", dedupeKey: `twilio:${messageSid}:${status}`, raw: fields };
  const errorCode = fields["ErrorCode"];
  const type = twilioStatusType(status, errorCode);
  if (type === undefined) {
    return { ...base, type: "unrecognized", providerEventType: status };
  }
  return {
    ...base,
    type,
    providerId: messageSid,
    providerStatus: status,
    ...(errorCode === undefined || errorCode.length === 0 ? {} : { errorCode }),
    ...(fields["From"] === undefined ? {} : { from: fields["From"] }),
    ...(fields["To"] === undefined ? {} : { to: fields["To"] }),
  };
}

/** Maps a Twilio `MessageStatus`; error 30007 ("Message filtered") becomes `message.filtered`. */
function twilioStatusType(status: string, errorCode: string | undefined): MessageStatusType | undefined {
  switch (status) {
    case "queued":
    case "accepted":
    case "scheduled":
    case "sending":
      return "message.queued";
    case "sent":
      return "message.sent";
    case "delivered":
      return "message.delivered";
    case "undelivered":
    case "failed":
      return errorCode === "30007" ? "message.filtered" : "message.undelivered";
    default:
      return undefined;
  }
}

function twilioMediaUrls(fields: Record<string, string>): string[] {
  const count = Number(fields["NumMedia"] ?? "0");
  const urls: string[] = [];
  for (let index = 0; index < (Number.isInteger(count) ? count : 0); index += 1) {
    const url = fields[`MediaUrl${index}`];
    if (url !== undefined) {
      urls.push(url);
    }
  }
  return urls;
}

function jsonParams(rawBody: string): Array<[string, string]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    throw new WebhookPayloadError("The twilio webhook body is not valid JSON.", { provider: "twilio" });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WebhookPayloadError("The twilio webhook JSON body is not an object.", { provider: "twilio" });
  }
  return Object.entries(parsed).flatMap(([key, value]): Array<[string, string]> =>
    typeof value === "string" ? [[key, value]] : typeof value === "number" ? [[key, String(value)]] : [],
  );
}

function urlVariants(url: string): string[] {
  const parsed = new URL(url);
  const defaultPort = parsed.protocol === "https:" ? "443" : parsed.protocol === "http:" ? "80" : undefined;
  if (defaultPort === undefined) {
    return [url];
  }
  const explicitPort = url.match(/^[a-z]+:\/\/[^/?#]*:(\d+)/i)?.[1];
  if (explicitPort === undefined) {
    const withPort = url.replace(/^([a-z]+:\/\/[^/?#]+)/i, `$1:${defaultPort}`);
    return [url, withPort];
  }
  if (explicitPort === defaultPort) {
    return [url, url.replace(`:${defaultPort}`, "")];
  }
  return [url];
}
