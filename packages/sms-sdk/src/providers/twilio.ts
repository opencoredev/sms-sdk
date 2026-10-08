/**
 * Twilio adapter for the Programmable Messaging Message resource, API version 2010-04-01.
 *
 * @see https://www.twilio.com/docs/messaging/api/message-resource
 * @packageDocumentation
 */

import type {
  AdapterMessage,
  AdapterSendOutcome,
  Delivery,
  RejectionCategory,
  SmsAdapter,
  SmsCapabilities,
  SmsFrom,
  ValidationIssue,
} from "../core/adapters.js";
import { ConfigurationError } from "../core/errors.js";
import {
  basicAuthorization,
  exchange,
  isRecord,
  parseJson,
  parseRetryAfter,
  providerInfo,
  readCode,
  readString,
  unknownForStatus,
  type FetchLike,
} from "../core/http.js";

const ACCOUNT_SID_PATTERN = /^AC[0-9a-fA-F]{32}$/;
const MESSAGING_SERVICE_SID_PATTERN = /^MG[0-9a-fA-F]{32}$/;
const MESSAGE_SID_PATTERN = /^(SM|MM)[0-9a-fA-F]{32}$/;
const MAX_BODY_LENGTH = 1600;
const MAX_MEDIA = 10;

type TwilioCommonOptions = {
  /** Account SID, `AC` followed by 32 hex characters. */
  readonly accountSid: string;
  /** Default sender: a Twilio number, short code, alphanumeric ID, or Messaging Service SID. */
  readonly from?: SmsFrom;
  /** API origin. Default `https://api.twilio.com`. */
  readonly baseUrl?: string;
  /** Custom `fetch`, for tests or runtimes without a global one. */
  readonly fetch?: FetchLike;
};

/** Authenticate with the account's Auth Token. */
export type TwilioAuthTokenOptions = TwilioCommonOptions & {
  readonly authToken: string;
  readonly apiKeySid?: never;
  readonly apiKeySecret?: never;
};

/** Authenticate with an API key (recommended by Twilio for production). */
export type TwilioApiKeyOptions = TwilioCommonOptions & {
  readonly apiKeySid: string;
  readonly apiKeySecret: string;
  readonly authToken?: never;
};

/** Options for {@link twilio}. Pass either `authToken` or `apiKeySid` + `apiKeySecret`. */
export type TwilioOptions = TwilioAuthTokenOptions | TwilioApiKeyOptions;

/** Static capabilities of the Twilio adapter. */
export const TWILIO_CAPABILITIES: SmsCapabilities = {
  sendText: true,
  mms: true,
  scheduling: true,
  validityPeriod: { minSec: 1, maxSec: 36_000 },
  webhookUrlOverride: true,
  inbound: true,
  deliveryReceipts: true,
  senderTypes: ["long_code", "toll_free", "short_code", "alphanumeric", "messaging_service"],
  nativeIdempotency: false,
};

/**
 * Creates a Twilio adapter.
 *
 * Sends `POST /2010-04-01/Accounts/{AccountSid}/Messages.json` with HTTP Basic
 * auth and a form-encoded body. A `{ messagingService }` sender becomes
 * `MessagingServiceSid`; every other sender becomes `From`. `sendAt` requires a
 * Messaging Service sender, per Twilio.
 *
 * @throws {ConfigurationError} when the account SID or credentials are malformed.
 */
export function twilio(options: TwilioOptions): SmsAdapter {
  if (!ACCOUNT_SID_PATTERN.test(options.accountSid)) {
    throw new ConfigurationError("Twilio accountSid must be AC followed by 32 hex characters.");
  }
  const authorization =
    options.authToken !== undefined
      ? basicAuthorization(options.accountSid, requireSecret(options.authToken, "authToken"))
      : basicAuthorization(requireSecret(options.apiKeySid, "apiKeySid"), requireSecret(options.apiKeySecret, "apiKeySecret"));
  const baseUrl = (options.baseUrl ?? "https://api.twilio.com").replace(/\/+$/, "");
  const url = `${baseUrl}/2010-04-01/Accounts/${options.accountSid}/Messages.json`;
  const fetcher: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  return {
    name: "twilio",
    capabilities: TWILIO_CAPABILITIES,
    support: { status: "supported", notes: [] },
    ...(options.from === undefined ? {} : { defaultFrom: options.from }),

    validate(message) {
      return validateTwilioMessage(message);
    },

    async send(message, context) {
      const response = await exchange(fetcher, url, {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: buildTwilioForm(message).toString(),
        signal: context.signal,
      });
      if (response.kind === "failed") {
        return { kind: "unknown", reason: "network", cause: response.cause };
      }
      return interpretTwilioResponse(response.status, response.text, response.headers);
    },
  };
}

/** Form parameters for the Message create request. */
export function buildTwilioForm(message: AdapterMessage): URLSearchParams {
  const form = new URLSearchParams();
  form.set("To", message.to);
  if (message.from.kind === "messaging_service") {
    form.set("MessagingServiceSid", message.from.value);
  } else {
    form.set("From", message.from.value);
  }
  if (message.body.length > 0) {
    form.set("Body", message.body);
  }
  for (const mediaUrl of message.mediaUrls) {
    form.append("MediaUrl", mediaUrl);
  }
  if (message.webhookUrl !== undefined) {
    form.set("StatusCallback", message.webhookUrl);
  }
  if (message.validityPeriodSec !== undefined) {
    form.set("ValidityPeriod", String(message.validityPeriodSec));
  }
  if (message.sendAt !== undefined) {
    form.set("SendAt", message.sendAt.toISOString());
    form.set("ScheduleType", "fixed");
  }
  return form;
}

function validateTwilioMessage(message: AdapterMessage): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (message.from.kind === "messaging_service" && !MESSAGING_SERVICE_SID_PATTERN.test(message.from.value)) {
    issues.push({
      code: "invalid_sender",
      field: "from",
      message: "Twilio Messaging Service SIDs are MG followed by 32 hex characters.",
    });
  }
  if (message.sendAt !== undefined && message.from.kind !== "messaging_service") {
    issues.push({
      code: "unsupported_field",
      field: "sendAt",
      message: "Twilio schedules messages only when sending from a Messaging Service.",
    });
  }
  if (message.body.length > MAX_BODY_LENGTH) {
    issues.push({ code: "invalid_field", field: "body", message: `Twilio accepts bodies up to ${MAX_BODY_LENGTH} characters.` });
  }
  if (message.mediaUrls.length > MAX_MEDIA) {
    issues.push({ code: "invalid_field", field: "mediaUrls", message: `Twilio accepts up to ${MAX_MEDIA} media URLs.` });
  }
  return issues;
}

/** Maps a Twilio HTTP response to an adapter outcome. */
export function interpretTwilioResponse(status: number, text: string, headers: Headers): AdapterSendOutcome {
  const requestId = headers.get("twilio-request-id");
  const body = parseJson(text);

  if (status >= 200 && status < 300) {
    const sid = isRecord(body) ? readString(body, "sid") : undefined;
    if (sid === undefined || !MESSAGE_SID_PATTERN.test(sid)) {
      return {
        kind: "unknown",
        reason: "malformed_response",
        details: providerInfo({ provider: "twilio", httpStatus: status, requestId }),
      };
    }
    const providerStatus = isRecord(body) ? readString(body, "status") : undefined;
    return { kind: "accepted", providerId: sid, delivery: twilioDelivery(providerStatus) };
  }

  if (status >= 400 && status < 500) {
    const code = isRecord(body) ? readCode(body, "code") : undefined;
    const message = isRecord(body) ? readString(body, "message") : undefined;
    const category = twilioRejectionCategory(status, code);
    const retryAfterMs = category === "rate_limited" ? parseRetryAfter(headers.get("retry-after")) : undefined;
    return {
      kind: "rejected",
      category,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      details: providerInfo({ provider: "twilio", httpStatus: status, code, message, requestId }),
    };
  }

  return unknownForStatus("twilio", status, requestId);
}

/**
 * Rejection category for a Twilio 4xx. Codes come from Twilio's error
 * dictionary; unlisted 4xx codes are `request` (not fallback-eligible).
 */
export function twilioRejectionCategory(status: number, code: string | undefined): RejectionCategory {
  if (status === 401 || code === "20003") {
    return "auth";
  }
  if (status === 429 || code === "20429") {
    return "rate_limited";
  }
  switch (code) {
    case "21211":
    case "21614":
      return "recipient";
    case "21610":
      return "compliance";
    case "21212":
    case "21606":
    case "21612":
    case "21659":
    case "21660":
    case "21703":
      return "sender";
    case "21408":
    case "21608":
      return "account";
    default:
      return status === 403 ? "auth" : "request";
  }
}

/** Delivery value for a Twilio Message `status`. */
export function twilioDelivery(status: string | undefined): Delivery {
  switch (status) {
    case "queued":
    case "accepted":
    case "scheduled":
    case "sending":
      return "queued";
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "undelivered":
    case "failed":
      return "undelivered";
    default:
      return "unknown";
  }
}

function requireSecret(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new ConfigurationError(`Twilio ${name} is required.`);
  }
  return value;
}
