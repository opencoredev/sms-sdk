/**
 * Verified, normalized SMS webhooks for Twilio, Telnyx, Plivo, and Vonage.
 *
 * @packageDocumentation
 */

import type { SmsEvent } from "./events.js";
import { parsePlivoWebhook, type PlivoWebhookOptions } from "./plivo.js";
import { parseTelnyxWebhook, type TelnyxWebhookOptions } from "./telnyx.js";
import { parseTwilioWebhook, type TwilioWebhookOptions } from "./twilio.js";
import { parseVonageWebhook, type VonageWebhookOptions } from "./vonage.js";

/** Options for {@link parseSmsWebhook}, discriminated by `provider`. */
export type ParseSmsWebhookOptions =
  | ({ readonly provider: "twilio" } & TwilioWebhookOptions)
  | ({ readonly provider: "telnyx" } & TelnyxWebhookOptions)
  | ({ readonly provider: "plivo" } & PlivoWebhookOptions)
  | ({ readonly provider: "vonage" } & VonageWebhookOptions);

/**
 * Reads the raw request body once, verifies the provider's signature, then
 * returns a normalized {@link SmsEvent}. Nothing is interpreted before
 * verification succeeds.
 *
 * @throws {WebhookSignatureError} when the request is not authentic. Respond 401/403.
 * @throws {WebhookPayloadError} when an authentic payload lacks required fields.
 */
export async function parseSmsWebhook(options: ParseSmsWebhookOptions): Promise<SmsEvent> {
  switch (options.provider) {
    case "twilio":
      return parseTwilioWebhook(options);
    case "telnyx":
      return parseTelnyxWebhook(options);
    case "plivo":
      return parsePlivoWebhook(options);
    case "vonage":
      return parseVonageWebhook(options);
    default: {
      const _exhaustive: never = options;
      return _exhaustive;
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
export { WebhookPayloadError, WebhookSignatureError, type WebhookFailureReason } from "../core/errors.js";
