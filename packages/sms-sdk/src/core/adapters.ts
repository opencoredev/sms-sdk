import type { E164 } from "./e164.js";

/**
 * The sender a message is sent from, as written by the caller.
 *
 * - An E.164 string is a provisioned long code or toll-free number.
 * - `{ senderId }` is an alphanumeric sender ID (1-11 characters, at least one letter).
 * - `{ shortCode }` is a provisioned short code (3-8 digits).
 * - `{ messagingService }` is a provider-side sender pool, such as a Twilio
 *   Messaging Service SID, a Telnyx messaging profile ID, or a Plivo Powerpack UUID.
 *
 * The SDK never infers that a sender is provisioned. The provider decides.
 */
export type SmsFrom =
  | E164
  | { readonly senderId: string }
  | { readonly shortCode: string }
  | { readonly messagingService: string };

/**
 * A sender after the client has resolved and validated it. Adapters receive
 * this shape instead of {@link SmsFrom}.
 */
export type SmsSender =
  | { readonly kind: "phone_number"; readonly value: E164 }
  | { readonly kind: "short_code"; readonly value: string }
  | { readonly kind: "alphanumeric"; readonly value: string }
  | { readonly kind: "messaging_service"; readonly value: string };

/**
 * Sender categories an adapter can declare. A {@link SmsSender} of kind
 * `phone_number` is allowed when the adapter declares `long_code` or `toll_free`.
 */
export type SenderType = "long_code" | "toll_free" | "short_code" | "alphanumeric" | "messaging_service";

/**
 * Whether the provider created the message.
 *
 * - `accepted`: the provider created or queued it. This is not handset delivery.
 * - `rejected`: the provider proved it did not create the message.
 * - `unknown`: the request may have reached the provider. Never resend automatically.
 */
export type Handoff = "accepted" | "rejected" | "unknown";

/**
 * Delivery progress known at the time of the send result or webhook. Provider
 * acceptance is `queued` (or `sent` if the provider says so), never `delivered`.
 */
export type Delivery = "unknown" | "queued" | "sent" | "delivered" | "undelivered" | "filtered";

/** Text encoding used for segment estimates. */
export type SmsEncoding = "gsm7" | "ucs2";

/**
 * Static baseline of what an adapter can send. Sender availability also depends
 * on country, registration, and account state, which the SDK cannot see.
 */
export type SmsCapabilities = {
  /** Every adapter sends plain text. */
  readonly sendText: true;
  /** `mediaUrls` is accepted. */
  readonly mms: boolean;
  /** `sendAt` is accepted. Some providers add sender restrictions, checked by the adapter. */
  readonly scheduling: boolean;
  /** Accepted `validityPeriodSec` range, or `null` when the provider has no such field. */
  readonly validityPeriod: { readonly minSec: number; readonly maxSec: number } | null;
  /** A per-message `webhookUrl` (status callback) override is accepted. */
  readonly webhookUrlOverride: boolean;
  /** The provider can deliver inbound messages to a webhook this SDK parses. */
  readonly inbound: boolean;
  /** The provider sends delivery status webhooks this SDK parses. */
  readonly deliveryReceipts: boolean;
  /** Sender categories the adapter can send from. */
  readonly senderTypes: readonly SenderType[];
  /**
   * The provider deduplicates sends by key on its side, and the adapter uses
   * it. `false` for every built-in adapter: none of the four providers
   * document send idempotency for their SMS endpoint.
   */
  readonly nativeIdempotency: boolean;
};

/**
 * How completely an adapter is verified.
 *
 * - `supported`: request, response, error mapping, and webhooks are implemented
 *   from official documentation and pass the contract tests.
 * - `partial`: works and passes the contract tests, but some provider behavior
 *   could not be confirmed from official documentation. `notes` says what.
 */
export type AdapterSupport = {
  readonly status: "supported" | "partial";
  readonly notes: readonly string[];
};

/** Fields of a validated message that an adapter sends. */
export type AdapterMessage = {
  readonly to: E164;
  readonly from: SmsSender;
  readonly body: string;
  /** Empty when the message has no media. */
  readonly mediaUrls: readonly string[];
  readonly sendAt?: Date;
  readonly validityPeriodSec?: number;
  readonly webhookUrl?: string;
};

/** Per-attempt context the client passes to {@link SmsAdapter.send}. */
export type SendContext = {
  /** Aborts on caller cancellation or per-request timeout. Pass it to `fetch`. */
  readonly signal: AbortSignal;
  /** 1-based attempt number for this adapter within one logical send. */
  readonly attempt: number;
  /** The caller's idempotency key, for adapters with native idempotency. */
  readonly idempotencyKey?: string;
};

/**
 * Why a provider rejected a message. The client uses it to decide retries and
 * fallback; see `isFallbackEligible`.
 *
 * - `auth`: credentials missing, invalid, or forbidden.
 * - `rate_limited`: the provider refused the request because of a documented rate or queue limit.
 * - `recipient`: the destination is invalid or unreachable for this route.
 * - `sender`: the sender is invalid, not provisioned, or not usable for this destination.
 * - `account`: account state (balance, trial, region permissions, spend limit, disabled).
 * - `compliance`: opt-out, block list, or content block. Never retried or failed over.
 * - `request`: the request was malformed or a field was invalid.
 */
export type RejectionCategory =
  | "auth"
  | "rate_limited"
  | "recipient"
  | "sender"
  | "account"
  | "compliance"
  | "request";

/**
 * Redacted provider details, safe to log. `message` has phone numbers masked
 * and is truncated; message bodies and credentials are never included.
 */
export type ProviderErrorInfo = {
  readonly provider: string;
  readonly httpStatus?: number;
  readonly code?: string;
  readonly message?: string;
  readonly requestId?: string;
};

/** Why an adapter could not prove whether the provider accepted the message. */
export type UnknownReason =
  | "network"
  | "timeout"
  | "aborted"
  | "malformed_response"
  | "server_error"
  | "unexpected_status"
  | "adapter_exception";

/**
 * Result of one provider request.
 *
 * Adapters must return `unknown` whenever the request may have been processed
 * and the response does not prove otherwise. They should not throw; a thrown
 * error is treated as `unknown`.
 */
export type AdapterSendOutcome =
  | {
      readonly kind: "accepted";
      readonly providerId: string;
      readonly delivery: Delivery;
    }
  | {
      readonly kind: "rejected";
      readonly category: RejectionCategory;
      /** Milliseconds the provider asked to wait (from `Retry-After`), when given. */
      readonly retryAfterMs?: number;
      readonly details: ProviderErrorInfo;
    }
  | {
      readonly kind: "unknown";
      readonly reason: UnknownReason;
      readonly details?: ProviderErrorInfo;
      readonly cause?: unknown;
    };

/** Problem found by local validation. */
export type ValidationIssue = {
  readonly code: ValidationIssueCode;
  readonly field: ValidationField;
  readonly message: string;
  /** Set when the issue applies to one adapter only. */
  readonly provider?: string;
};

/** Stable identifiers for {@link ValidationIssue}. */
export type ValidationIssueCode =
  | "invalid_recipient"
  | "invalid_sender"
  | "missing_sender"
  | "empty_body"
  | "unsupported_field"
  | "invalid_field";

/** Input fields a {@link ValidationIssue} can point at. */
export type ValidationField =
  | "to"
  | "from"
  | "body"
  | "mediaUrls"
  | "sendAt"
  | "validityPeriodSec"
  | "webhookUrl"
  | "idempotencyKey";

/**
 * The adapter contract. Implement it to add a provider; run
 * `runSmsAdapterContract` from `@opencoredev/sms-sdk/testing` to check it.
 */
export interface SmsAdapter {
  /** Stable provider name, such as `"twilio"`. Used in results and errors. */
  readonly name: string;
  readonly capabilities: SmsCapabilities;
  readonly support: AdapterSupport;
  /** Sender used when the message has no `from`. */
  readonly defaultFrom?: SmsFrom;
  /**
   * Provider-specific checks that need no network, such as sender ID formats
   * or field combinations. Generic capability checks run in the client.
   */
  validate?(message: AdapterMessage): readonly ValidationIssue[];
  /** Sends one request. Must not throw; see {@link AdapterSendOutcome}. */
  send(message: AdapterMessage, context: SendContext): Promise<AdapterSendOutcome>;
}
