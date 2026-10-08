import type { ProviderErrorInfo, RejectionCategory, UnknownReason, ValidationField } from "./adapters.js";
import type { SendAttempt } from "./events.js";

/** Stable machine-readable error codes. One per error class. */
export type SmsErrorCode =
  | "configuration"
  | "invalid_recipient"
  | "invalid_sender"
  | "invalid_message"
  | "unsupported_field"
  | "policy_rejected"
  | "provider_rejected"
  | "provider_auth"
  | "provider_rate_limited"
  | "all_providers_rejected"
  | "handoff_unknown"
  | "aborted"
  | "idempotency_conflict"
  | "idempotency_in_progress"
  | "webhook_signature"
  | "webhook_payload";

/** JSON shape produced by `SmsError#toJSON()`. Contains no secrets, bodies, or full numbers. */
export type SerializedSmsError = {
  readonly name: string;
  readonly code: SmsErrorCode;
  readonly message: string;
  readonly retrySafe: boolean;
  readonly attempts: readonly SendAttempt[];
  readonly provider?: ProviderErrorInfo;
};

type SmsErrorOptions = {
  readonly code: SmsErrorCode;
  readonly retrySafe: boolean;
  readonly attempts?: readonly SendAttempt[];
  readonly provider?: ProviderErrorInfo;
  readonly cause?: unknown;
};

/**
 * Base class for every error this SDK throws.
 *
 * `retrySafe` answers one question: can the same logical message be sent again
 * without risking a duplicate? It is `true` only when nothing was sent or the
 * provider proved it did not accept the message. It does not promise the retry
 * will succeed.
 *
 * `cause` may hold the original exception for debugging; it is excluded from
 * `toJSON()`.
 */
export class SmsError extends Error {
  readonly code: SmsErrorCode;
  readonly retrySafe: boolean;
  /** Provider requests made before the error, oldest first. */
  readonly attempts: readonly SendAttempt[];
  /** Redacted details from the provider response, when there was one. */
  readonly provider: ProviderErrorInfo | undefined;

  constructor(message: string, options: SmsErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SmsError";
    this.code = options.code;
    this.retrySafe = options.retrySafe;
    this.attempts = options.attempts ?? [];
    this.provider = options.provider;
  }

  /** Redacted, log-safe representation. */
  toJSON(): SerializedSmsError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retrySafe: this.retrySafe,
      attempts: this.attempts,
      ...(this.provider === undefined ? {} : { provider: this.provider }),
    };
  }
}

/** Client or adapter options are invalid. Nothing was sent. `retrySafe: true`. */
export class ConfigurationError extends SmsError {
  constructor(message: string) {
    super(message, { code: "configuration", retrySafe: true });
    this.name = "ConfigurationError";
  }
}

/** `to` is not a valid E.164 number. Nothing was sent. `retrySafe: true`. */
export class InvalidRecipientError extends SmsError {
  constructor(message: string) {
    super(message, { code: "invalid_recipient", retrySafe: true });
    this.name = "InvalidRecipientError";
  }
}

/** The sender is missing or malformed. Nothing was sent. `retrySafe: true`. */
export class InvalidSenderError extends SmsError {
  readonly providerName: string | undefined;

  constructor(message: string, options: { readonly provider?: string } = {}) {
    super(message, { code: "invalid_sender", retrySafe: true });
    this.name = "InvalidSenderError";
    this.providerName = options.provider;
  }
}

/** The message content is invalid, such as an empty body without media. Nothing was sent. `retrySafe: true`. */
export class InvalidMessageError extends SmsError {
  readonly field: ValidationField;

  constructor(message: string, options: { readonly field: ValidationField }) {
    super(message, { code: "invalid_message", retrySafe: true });
    this.name = "InvalidMessageError";
    this.field = options.field;
  }
}

/**
 * The primary adapter cannot send a requested field (`mediaUrls`, `sendAt`,
 * `validityPeriodSec`, `webhookUrl`, or the sender type). Thrown before any
 * request. `retrySafe: true`.
 */
export class UnsupportedFieldError extends SmsError {
  readonly field: ValidationField;
  readonly providerName: string;

  constructor(message: string, options: { readonly field: ValidationField; readonly provider: string }) {
    super(message, { code: "unsupported_field", retrySafe: true });
    this.name = "UnsupportedFieldError";
    this.field = options.field;
    this.providerName = options.provider;
  }
}

/**
 * The client's `beforeSend` policy refused the message. Nothing was sent and
 * no fallback runs. `retrySafe: true`.
 *
 * `message` is fixed. The caller's `reason` may name a person or number, so it
 * stays out of `message`, `toJSON()`, and hook payloads.
 */
export class PolicyRejectedError extends SmsError {
  /** The reason `beforeSend` returned, unredacted. Not serialized. */
  readonly reason: string;

  constructor(reason: string) {
    super("Send blocked by the beforeSend policy.", { code: "policy_rejected", retrySafe: true });
    this.name = "PolicyRejectedError";
    this.reason = reason;
  }
}

type ProviderRejectedOptions = {
  readonly category: RejectionCategory;
  readonly provider: ProviderErrorInfo;
  readonly attempts: readonly SendAttempt[];
};

/**
 * A provider proved it did not accept the message. `retrySafe: true`.
 * `category` tells you why; `fallbackEligible` tells you whether the client
 * would fail over to another adapter for it.
 */
export class ProviderRejectedError extends SmsError {
  readonly category: RejectionCategory;
  readonly providerName: string;
  readonly fallbackEligible: boolean;

  constructor(message: string, options: ProviderRejectedOptions, code: SmsErrorCode = "provider_rejected") {
    super(message, { code, retrySafe: true, attempts: options.attempts, provider: options.provider });
    this.name = "ProviderRejectedError";
    this.category = options.category;
    this.providerName = options.provider.provider;
    this.fallbackEligible = isFallbackEligible(options.category);
  }
}

/** The provider rejected the credentials. A {@link ProviderRejectedError} with category `auth`. */
export class ProviderAuthError extends ProviderRejectedError {
  constructor(message: string, options: Omit<ProviderRejectedOptions, "category">) {
    super(message, { ...options, category: "auth" }, "provider_auth");
    this.name = "ProviderAuthError";
  }
}

/**
 * The provider refused the request because of a documented rate or queue
 * limit, so the message was not created. A {@link ProviderRejectedError} with
 * category `rate_limited`. `retryAfterMs` is set when the provider sent `Retry-After`.
 */
export class ProviderRateLimitedError extends ProviderRejectedError {
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: Omit<ProviderRejectedOptions, "category"> & { readonly retryAfterMs?: number }) {
    super(message, { ...options, category: "rate_limited" }, "provider_rate_limited");
    this.name = "ProviderRateLimitedError";
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Fallback was enabled and every attempted adapter rejected the message.
 * `errors` holds one rejection per adapter, in order. `retrySafe: true`.
 */
export class AllProvidersRejectedError extends SmsError {
  readonly errors: readonly ProviderRejectedError[];

  constructor(errors: readonly ProviderRejectedError[], attempts: readonly SendAttempt[]) {
    const names = errors.map((error) => error.providerName).join(", ");
    super(`Every attempted provider rejected the message (${names}).`, {
      code: "all_providers_rejected",
      retrySafe: true,
      attempts,
    });
    this.name = "AllProvidersRejectedError";
    this.errors = errors;
  }
}

/** Why a {@link HandoffUnknownError} was raised. */
export type HandoffUnknownReason = UnknownReason | "stale_reservation" | "replayed_unknown";

/**
 * The SDK cannot tell whether the provider accepted the message: a timeout,
 * network failure, 5xx, malformed success response, or a previous unknown
 * outcome for the same idempotency key. `retrySafe: false`.
 *
 * Do not resend automatically. Reconcile first: look the message up in the
 * provider console or API, or wait for a status webhook.
 */
export class HandoffUnknownError extends SmsError {
  readonly reason: HandoffUnknownReason;
  readonly providerName: string | undefined;

  constructor(
    message: string,
    options: {
      readonly reason: HandoffUnknownReason;
      readonly providerName?: string;
      readonly attempts: readonly SendAttempt[];
      readonly provider?: ProviderErrorInfo;
      readonly cause?: unknown;
    },
  ) {
    super(message, {
      code: "handoff_unknown",
      retrySafe: false,
      attempts: options.attempts,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      cause: options.cause,
    });
    this.name = "HandoffUnknownError";
    this.reason = options.reason;
    this.providerName = options.providerName;
  }
}

/**
 * The caller aborted before a request could have reached a provider: before
 * the first request or while waiting to retry after a proven rejection.
 * `retrySafe: true`. An abort while a request is in flight raises
 * {@link HandoffUnknownError} instead.
 */
export class SendAbortedError extends SmsError {
  constructor(attempts: readonly SendAttempt[], cause?: unknown) {
    super("The send was aborted before any provider accepted the message.", {
      code: "aborted",
      retrySafe: true,
      attempts,
      cause,
    });
    this.name = "SendAbortedError";
  }
}

/**
 * The idempotency key was already used for a different payload or sender.
 * Nothing was sent. `retrySafe: false`: use a new key for a new message.
 */
export class IdempotencyConflictError extends SmsError {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super("This idempotency key was already used for a different message.", {
      code: "idempotency_conflict",
      retrySafe: false,
    });
    this.name = "IdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
  }
}

/**
 * Another process holds a fresh reservation for this idempotency key and has
 * not finished. Nothing was sent by this call. `retrySafe: true`: calling again
 * later with the same key replays the other call's outcome.
 */
export class IdempotencyInProgressError extends SmsError {
  readonly idempotencyKey: string;

  constructor(idempotencyKey: string) {
    super("Another send with this idempotency key is still in progress.", {
      code: "idempotency_in_progress",
      retrySafe: true,
    });
    this.name = "IdempotencyInProgressError";
    this.idempotencyKey = idempotencyKey;
  }
}

/** Why webhook verification failed. */
export type WebhookFailureReason =
  | "missing_signature"
  | "invalid_signature"
  | "stale_timestamp"
  | "body_hash_mismatch"
  | "malformed_signature"
  | "invalid_credentials";

/** The webhook request failed authenticity checks. Respond with 401/403 and do not process it. */
export class WebhookSignatureError extends SmsError {
  readonly reason: WebhookFailureReason;
  readonly providerName: string;

  constructor(message: string, options: { readonly reason: WebhookFailureReason; readonly provider: string }) {
    super(message, { code: "webhook_signature", retrySafe: false });
    this.name = "WebhookSignatureError";
    this.reason = options.reason;
    this.providerName = options.provider;
  }
}

/** The webhook was authentic but its payload is missing required fields. */
export class WebhookPayloadError extends SmsError {
  readonly providerName: string;

  constructor(message: string, options: { readonly provider: string }) {
    super(message, { code: "webhook_payload", retrySafe: false });
    this.name = "WebhookPayloadError";
    this.providerName = options.provider;
  }
}

/**
 * Whether the client may fail over to the next adapter after this rejection,
 * when `fallback: "on-known-rejection"` is set.
 *
 * Eligible: `auth`, `rate_limited`, `sender`, `account` (problems specific to
 * one provider account). Not eligible: `recipient`, `compliance`, `request`
 * (another provider would reject it too, or must not be used to bypass an opt-out).
 */
export function isFallbackEligible(category: RejectionCategory): boolean {
  switch (category) {
    case "auth":
    case "rate_limited":
    case "sender":
    case "account":
      return true;
    case "recipient":
    case "compliance":
    case "request":
      return false;
    default: {
      const _exhaustive: never = category;
      return _exhaustive;
    }
  }
}

/** Type guard for any error thrown by this SDK. */
export function isSmsError(error: unknown): error is SmsError {
  return error instanceof SmsError;
}
