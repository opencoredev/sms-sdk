import type {
  AdapterSupport,
  Delivery,
  SmsAdapter,
  SmsCapabilities,
  SmsEncoding,
  SmsFrom,
  SmsMessageStatus,
  ValidationIssue,
} from "./adapters.js";
import type { E164 } from "./e164.js";
import type { SegmentPreview } from "./encoding.js";
import type { SendAttempt, SmsClientHooks } from "./events.js";
import type { IdempotencyStore } from "./idempotency.js";
import type { SmsProviderOptions } from "../index.js";


/** One logical SMS to send. */
export type SmsSendInput = {
  /** Destination in E.164, such as `+14155550123`. */
  readonly to: E164;
  /** Sender. Defaults to each adapter's configured `from`. */
  readonly from?: SmsFrom;
  /** Message text. May be empty only when `mediaUrls` is non-empty. */
  readonly body: string;
  /**
   * Caller-chosen key for this logical message (not per HTTP attempt), such
   * as `"order:123:shipped:v1"`. Deduplicates only when the client has an
   * idempotency store; see `SmsClientOptions.idempotency`.
   */
  readonly idempotencyKey?: string;
  /** MMS media. Requires an adapter with `capabilities.mms`. */
  readonly mediaUrls?: readonly string[];
  /** Provider-side scheduled send time. Requires `capabilities.scheduling`. */
  readonly sendAt?: Date;
  /** How long the provider may keep trying to deliver. Requires `capabilities.validityPeriod`. */
  readonly validityPeriodSec?: number;
  /** Per-message status webhook URL. Requires `capabilities.webhookUrlOverride`. */
  readonly webhookUrl?: string;
  /**
   * Provider-specific options, keyed by adapter name, such as
   * `{ twilio: { shortenUrls: true } }`. An entry applies only when that
   * adapter sends; with fallback, each adapter uses its own entry. Entries for
   * adapters the client does not have are ignored. Unknown keys, wrong types,
   * and fields the SDK sets itself throw before any request. Part of the
   * idempotency fingerprint.
   */
  readonly providerOptions?: SmsProviderOptions;
};

/**
 * A send the provider accepted. `send()` only resolves with this; rejections
 * and unknown outcomes throw.
 */
export type SmsSendResult = {
  /** Library-scoped logical ID, stable across idempotent replays. */
  readonly id: string;
  /** Name of the adapter that accepted the message. */
  readonly provider: string;
  /** The provider's message ID. Match status webhooks with it. */
  readonly providerId: string;
  /** Always `"accepted"`: the provider created or queued the message. Not handset delivery. */
  readonly handoff: "accepted";
  /** Delivery status reported in the provider's response, usually `queued`. */
  readonly delivery: Delivery;
  readonly encoding: SmsEncoding;
  /** Estimated segments; see `estimateSegments`. */
  readonly segments: number;
  /** Adapters tried, in order, without duplicates. */
  readonly attemptedProviders: readonly string[];
  /** Every provider request made, in order. */
  readonly attempts: readonly SendAttempt[];
  /** True when this result came from the idempotency store instead of a new send. */
  readonly replayed: boolean;
};

/** Result of `sms.validate()`: local, deterministic, and free. Never contacts a provider. */
export type SmsValidationResult = SegmentPreview & {
  /** True when the primary adapter can send this message and it has no errors. */
  readonly supported: boolean;
  /** Every problem found, across the message and every adapter. */
  readonly issues: readonly ValidationIssue[];
  /** Adapters that could send this message, in configured order. */
  readonly adapterCandidates: readonly string[];
  /** Candidates that have an entry in `providerOptions`, in configured order. */
  readonly providerOptionsFor: readonly string[];
};

/** Decision returned by `beforeSend`. */
export type PolicyDecision = { readonly kind: "allow" } | { readonly kind: "reject"; readonly reason: string };

/** Input given to `beforeSend`. Runs once per logical send, before any provider request. */
export type BeforeSendContext = {
  readonly id: string;
  readonly message: SmsSendInput;
  readonly encoding: SmsEncoding;
  readonly segments: number;
};

/** Same-adapter retry policy for proven, rate-limited rejections. */
export type RetryOptions = {
  /** Requests per adapter, including the first: an integer from 1 to 10. Default `2`. `1` disables retries. */
  readonly maxAttempts?: number;
  /** Base delay for exponential backoff with full jitter. Finite, 0 or more. Default `500` ms. */
  readonly baseDelayMs?: number;
  /**
   * Longest wait between attempts. A `Retry-After` longer than this stops
   * retrying that adapter instead of waiting. Default `10000` ms.
   */
  readonly maxDelayMs?: number;
};

/** Options for {@link createSmsClient}. */
export type SmsClientOptions = {
  /** Adapters in priority order. The first is the primary. */
  readonly adapters: readonly [SmsAdapter, ...SmsAdapter[]];
  /**
   * `"none"` (default): only the primary adapter is used.
   * `"on-known-rejection"`: after a fallback-eligible rejection, try the next
   * adapter. Never after an accepted or unknown outcome.
   */
  readonly fallback?: "none" | "on-known-rejection";
  /** Retry policy. Only rate-limit rejections are retried. */
  readonly retry?: RetryOptions;
  /** Per-request timeout. A timeout after the request starts is an unknown outcome. Default `10000` ms. */
  readonly timeoutMs?: number;
  /** Enables idempotency-key deduplication. Off unless a store is given. */
  readonly idempotency?: {
    readonly store: IdempotencyStore;
    /** Retention of accepted/rejected records, in seconds. Finite and positive. Default `86400` (24 hours). */
    readonly ttlSec?: number;
    /** Age in seconds after which an unfinished reservation is an unknown outcome. Finite and positive. Default `300`. */
    readonly staleReservationSec?: number;
  };
  /** Policy check, such as a suppression list. A rejection never falls back. */
  readonly beforeSend?: (context: BeforeSendContext) => PolicyDecision | Promise<PolicyDecision>;
  /** Redacted observability callbacks. */
  readonly hooks?: SmsClientHooks;
};

/** Options for a single `send()` call. */
export type SmsSendOptions = {
  /** Cancels the send. Aborting during a request yields an unknown outcome. */
  readonly signal?: AbortSignal;
};

/** Options for a single `getMessage()` call. */
export type SmsGetMessageOptions = {
  /**
   * Name of the adapter to ask, such as `result.provider` from the send that
   * returned the ID. Default: the primary adapter.
   */
  readonly adapter?: string;
  /** Cancels the lookup. */
  readonly signal?: AbortSignal;
};

/** Public metadata of a configured adapter. */
export type SmsAdapterInfo = {
  readonly name: string;
  readonly capabilities: SmsCapabilities;
  readonly support: AdapterSupport;
  readonly defaultFrom: SmsFrom | undefined;
  /** The adapter implements `getMessage`. */
  readonly messageLookup: boolean;
};

/** The SMS client returned by {@link createSmsClient}. */
export interface SmsClient {
  /**
   * Sends one logical message. Resolves only when a provider accepted it.
   *
   * @throws {InvalidRecipientError | InvalidSenderError | InvalidMessageError | UnsupportedFieldError} before any request.
   * @throws {PolicyRejectedError} when `beforeSend` rejects.
   * @throws {ProviderRejectedError | ProviderAuthError | ProviderRateLimitedError} when the provider proved it did not accept.
   * @throws {AllProvidersRejectedError} when fallback ran and every adapter rejected.
   * @throws {HandoffUnknownError} when acceptance cannot be determined. Do not resend automatically.
   * @throws {SendAbortedError} when aborted before any request could have been processed.
   * @throws {IdempotencyConflictError | IdempotencyInProgressError} with an idempotency store.
   */
  send(input: SmsSendInput, options?: SmsSendOptions): Promise<SmsSendResult>;
  /** Local preflight: E.164, sender, body, capabilities, and segment estimate. Never sends. */
  validate(input: SmsSendInput): SmsValidationResult;
  /**
   * Looks up one message by the provider's message ID, such as
   * `SmsSendResult.providerId` or a webhook event's `providerId`. Read-only:
   * it never sends. Use it to check delivery when a status webhook is late or
   * lost. The request uses the client's `timeoutMs`.
   *
   * It cannot reconcile a {@link HandoffUnknownError} by itself: an unknown
   * outcome has no provider ID. Find those by recipient and time in the
   * provider console, or wait for a status webhook.
   *
   * @returns The provider's record, or `undefined` when the provider has no message with that ID.
   * @throws {ConfigurationError} when `providerId` is empty, or the adapter is not configured or has no `getMessage`.
   * @throws {MessageLookupError} when the provider could not answer. Never a reason to resend.
   */
  getMessage(providerId: string, options?: SmsGetMessageOptions): Promise<SmsMessageStatus | undefined>;
  /** Configured adapters with their capabilities and support status. */
  capabilities(): readonly SmsAdapterInfo[];
}
