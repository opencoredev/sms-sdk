/**
 * Verified, normalized SMS webhooks for the built-in SMS providers.
 *
 * @packageDocumentation
 */

import { ConfigurationError } from "../core/errors.js";
import { isRecord } from "../core/http.js";
import type { SmsEvent } from "./events.js";
import { parseBandwidthWebhook, parseBandwidthWebhooks, type BandwidthWebhookOptions } from "./bandwidth.js";
import { parseSinchWebhook, parseSinchWebhooks, type SinchWebhookOptions } from "./sinch.js";
import { parsePlivoWebhook, type PlivoWebhookOptions } from "./plivo.js";
import { parseTelnyxWebhook, type TelnyxWebhookOptions } from "./telnyx.js";
import { parseTwilioWebhook, type TwilioWebhookOptions } from "./twilio.js";
import { parseVonageWebhook, type VonageWebhookOptions } from "./vonage.js";

/** Options for {@link parseSmsWebhook}, discriminated by `provider`. */
export type ParseSmsWebhookOptions =
  | ({ readonly provider: "twilio" } & TwilioWebhookOptions)
  | ({ readonly provider: "telnyx" } & TelnyxWebhookOptions)
  | ({ readonly provider: "plivo" } & PlivoWebhookOptions)
  | ({ readonly provider: "vonage" } & VonageWebhookOptions)
  | ({ readonly provider: "bandwidth" } & BandwidthWebhookOptions)
  | ({ readonly provider: "sinch" } & SinchWebhookOptions);

/**
 * Reads the raw request body once, verifies the provider's signature, then
 * returns a normalized {@link SmsEvent}. Nothing is interpreted before
 * verification succeeds.
 *
 * Bandwidth callbacks and Sinch delivery reports can carry several events in
 * one request. This function throws `WebhookPayloadError` for those instead of
 * dropping events; use {@link parseSmsWebhooks} to read every event.
 *
 * @throws {WebhookSignatureError} when the request is not authentic. Respond 401/403.
 * @throws {WebhookPayloadError} when the body exceeds 1 MiB (`reason: "body_too_large"`, checked before verification) or an authentic payload lacks required fields or carries several events.
 * @throws {ConfigurationError} when `unsafeSkipVerification` is set and `NODE_ENV` is `"production"`.
 */
export async function parseSmsWebhook(options: ParseSmsWebhookOptions): Promise<SmsEvent> {
  if (!isRecord(options)) {
    throw new ConfigurationError("Webhook options must be an object with a supported provider.");
  }
  switch (options.provider) {
    case "twilio":
      return parseTwilioWebhook(options);
    case "telnyx":
      return parseTelnyxWebhook(options);
    case "plivo":
      return parsePlivoWebhook(options);
    case "vonage":
      return parseVonageWebhook(options);
    case "bandwidth":
      return parseBandwidthWebhook(options);
    case "sinch":
      return parseSinchWebhook(options);
    default: {
      const _exhaustive: never = options;
      void _exhaustive;
      throw new ConfigurationError("Unsupported SMS webhook provider.");
    }
  }
}

/**
 * Like {@link parseSmsWebhook}, but returns every event the request carries,
 * in payload order. A Bandwidth callback yields one event per array element
 * and a Sinch delivery report one per `recipient_delivery_report` entry; every
 * other provider sends one event per request, so the array has one element.
 * Deduplicate each event by its own `dedupeKey`.
 *
 * @throws {WebhookSignatureError} when the request is not authentic. Respond 401/403.
 * @throws {WebhookPayloadError} when the body exceeds 1 MiB (`reason: "body_too_large"`, checked before verification) or an authentic payload lacks required fields.
 * @throws {ConfigurationError} when `unsafeSkipVerification` is set and `NODE_ENV` is `"production"`.
 */
export async function parseSmsWebhooks(options: ParseSmsWebhookOptions): Promise<SmsEvent[]> {
  if (!isRecord(options)) {
    throw new ConfigurationError("Webhook options must be an object with a supported provider.");
  }
  switch (options.provider) {
    case "bandwidth":
      return parseBandwidthWebhooks(options);
    case "sinch":
      return parseSinchWebhooks(options);
    case "twilio":
    case "telnyx":
    case "plivo":
    case "vonage":
      return [await parseSmsWebhook(options)];
    default: {
      const _exhaustive: never = options;
      void _exhaustive;
      throw new ConfigurationError("Unsupported SMS webhook provider.");
    }
  }
}

export {
  detectKeyword,
  HELP_KEYWORDS,
  OPT_OUT_KEYWORDS,
  type KeywordMatch,
  type MessageReceivedEvent,
  type MessageStatusEvent,
  type MessageStatusType,
  type RecipientKeywordEvent,
  type SmsEvent,
  type SmsEventBase,
  type UnrecognizedEvent,
  type WebhookProvider,
} from "./events.js";
export type { SignedUrlOptions, WebhookCommonOptions } from "./shared.js";
export {
  parseBandwidthWebhook,
  parseBandwidthWebhooks,
  type BandwidthWebhookCredentials,
  type BandwidthWebhookOptions,
} from "./bandwidth.js";
export {
  parseSinchWebhook,
  parseSinchWebhooks,
  SINCH_DEFAULT_TOLERANCE_SEC,
  verifySinchSignature,
  type SinchWebhookCredentials,
  type SinchWebhookOptions,
  type SinchWebhookVerification,
} from "./sinch.js";
export {
  computeTwilioSignature,
  parseTwilioWebhook,
  verifyTwilioSignature,
  type TwilioWebhookOptions,
} from "./twilio.js";
export {
  parseTelnyxWebhook,
  TELNYX_DEFAULT_TOLERANCE_SEC,
  verifyTelnyxSignature,
  type TelnyxWebhookOptions,
  type WebhookVerification,
} from "./telnyx.js";
export {
  computePlivoSignatureV2,
  parsePlivoWebhook,
  verifyPlivoSignatureV2,
  type PlivoWebhookOptions,
} from "./plivo.js";
export {
  parseVonageWebhook,
  VONAGE_DEFAULT_TOLERANCE_SEC,
  verifyVonageSignature,
  type VonageWebhookOptions,
} from "./vonage.js";
export { ConfigurationError, WebhookPayloadError, WebhookSignatureError, type WebhookFailureReason } from "../core/errors.js";
