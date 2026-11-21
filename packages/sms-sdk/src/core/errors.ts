import type {
  Delivery,
  LookupFailureReason,
  ProviderErrorInfo,
  RejectionCategory,
  UnknownReason,
  ValidationField,
} from "./adapters.js";
import type { SendAttempt } from "./events.js";

const SAFE_DIAGNOSTIC_TOKEN = /^[A-Za-z0-9._-]+$/;
const OPAQUE_UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_HEX32_ID = /^[A-Za-z]{0,4}[0-9a-f]{32}$/i;
const DIGIT_SPAN = /\d[\d._:-]*\d/g;
const CREDENTIAL_TOKEN_PREFIX =
  /^(?:(?:sk|pk|rk|whsec|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[baprs]|sq0[a-z]{3})[_-]|(?:akia|asia)[0-9a-z]{12}|aiza[0-9a-z_-]{10}|eyj[a-z0-9_-]{6,}\.)/i;
const CREDENTIAL_REQUEST_ID_MARKER =
  /(?:^|[_.:-])(?:secret|token|password|passwd|pwd|apikey|api_key|api-key|bearer|basic|auth_token|access_key|private_key)(?:[_.:-]|$)/i;

// Require at least one hex letter [a-f] so phone-padded all-decimal IDs (e.g. RQ14155550123000...)
// are still dropped as potential PII rather than echoed in diagnostic error metadata.
function isOpaqueHexId(value: string): boolean {
  if (OPAQUE_UUID_ID.test(value)) {
    return /[a-f]/i.test(value);
  }
  if (OPAQUE_HEX32_ID.test(value)) {
    return /[a-f]/i.test(value.slice(-32));
  }
  return false;
}

function containsPhoneLengthDigits(value: string): boolean {
  for (const match of value.matchAll(DIGIT_SPAN)) {
    if (match[0].replace(/\D/g, "").length >= 8) {
      return true;
    }
  }
  return false;
}

/** Keeps only compact structural tokens (codes, request IDs), rejecting free-form text, credentials, PII, or phone-length digit runs. */
export function sanitizeDiagnosticToken(value: unknown, maxLength: number): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !SAFE_DIAGNOSTIC_TOKEN.test(value) ||
    CREDENTIAL_TOKEN_PREFIX.test(value) ||
    value.includes(":") ||
    CREDENTIAL_REQUEST_ID_MARKER.test(value) ||
    (!isOpaqueHexId(value) && containsPhoneLengthDigits(value))
  ) {
    return undefined;
  }
  return value;
}

function safeReadProperty(obj: Record<string, unknown>, key: string): unknown {
  try {
    return obj[key];
  } catch {
    return undefined;
  }
}

/** Copies only structural provider details, reading each field once. Free-form `message` and unvalidated strings are dropped. */
export function sanitizeProviderDetails(
  raw: Record<string, unknown>,
  fallbackProvider: string,
  sanitizeProviderName = false,
): ProviderErrorInfo {
  const rawStatus = safeReadProperty(raw, "httpStatus");
  const rawCode = safeReadProperty(raw, "code");
  const rawRequestId = safeReadProperty(raw, "requestId");
  // The client knows which adapter answered; preserve its name in memory, and sanitize for JSON logs.
  const provider = sanitizeProviderName
    ? (sanitizeDiagnosticToken(fallbackProvider, 64) ?? "unknown")
    : fallbackProvider;
  const httpStatus =
    typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 100 && rawStatus <= 599
      ? rawStatus
      : undefined;
  const code = sanitizeDiagnosticToken(rawCode, 64);
  const requestId = sanitizeDiagnosticToken(rawRequestId, 128);
  return {
    provider,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(code === undefined ? {} : { code }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

const DELIVERY_MAP = {
  unknown: true,
  queued: true,
  sent: true,
  delivered: true,
  undelivered: true,
  filtered: true,
} as const satisfies Record<Delivery, true>;

const REJECTION_CATEGORY_MAP = {
  auth: true,
  rate_limited: true,
  recipient: true,
  sender: true,
  account: true,
  compliance: true,
  request: true,
} as const satisfies Record<RejectionCategory, true>;

const UNKNOWN_REASON_MAP = {
  network: true,
  timeout: true,
  aborted: true,
  malformed_response: true,
  server_error: true,
  unexpected_status: true,
  adapter_exception: true,
} as const satisfies Record<UnknownReason, true>;

const VALID_DELIVERIES = new Set<string>(Object.keys(DELIVERY_MAP));
const VALID_REJECTION_CATEGORIES = new Set<string>(Object.keys(REJECTION_CATEGORY_MAP));
const VALID_UNKNOWN_REASONS = new Set<string>(Object.keys(UNKNOWN_REASON_MAP));

function sanitizeAttemptForJson(attempt: unknown): SendAttempt | undefined {
  try {
    if (attempt === null || typeof attempt !== "object" || Array.isArray(attempt)) {
      return undefined;
    }
    const raw = attempt as Record<string, unknown>;
    const rawProvider = safeReadProperty(raw, "provider");
    const rawAttemptNum = safeReadProperty(raw, "attempt");
    const rawOutcome = safeReadProperty(raw, "outcome");
    const rawDuration = safeReadProperty(raw, "durationMs");

    const provider = sanitizeDiagnosticToken(rawProvider, 64) ?? "unknown";
    const attemptNum =
      typeof rawAttemptNum === "number" && Number.isFinite(rawAttemptNum) ? rawAttemptNum : 0;
    const durationMs =
      typeof rawDuration === "number" && Number.isFinite(rawDuration) ? rawDuration : 0;

    if (rawOutcome === "accepted") {
      const rawProviderId = safeReadProperty(raw, "providerId");
      const rawDelivery = safeReadProperty(raw, "delivery");
      const providerId = sanitizeDiagnosticToken(rawProviderId, 128) ?? "[redacted]";
      const delivery =
        typeof rawDelivery === "string" && VALID_DELIVERIES.has(rawDelivery)
          ? (rawDelivery as Delivery)
          : "unknown";
      return {
        provider,
        attempt: attemptNum,
        outcome: "accepted",
        providerId,
        delivery,
        durationMs,
      };
    }

    if (rawOutcome === "rejected") {
      const rawCategory = safeReadProperty(raw, "category");
      const rawHttpStatus = safeReadProperty(raw, "httpStatus");
      const rawProviderCode = safeReadProperty(raw, "providerCode");
      const rawRetryAfterMs = safeReadProperty(raw, "retryAfterMs");
      const category =
        typeof rawCategory === "string" && VALID_REJECTION_CATEGORIES.has(rawCategory)
          ? (rawCategory as RejectionCategory)
          : "request";
      const httpStatus =
        typeof rawHttpStatus === "number" &&
        Number.isInteger(rawHttpStatus) &&
        rawHttpStatus >= 100 &&
        rawHttpStatus <= 599
          ? rawHttpStatus
          : undefined;
      const providerCode = sanitizeDiagnosticToken(rawProviderCode, 64);
      const retryAfterMs =
        typeof rawRetryAfterMs === "number" && Number.isFinite(rawRetryAfterMs) && rawRetryAfterMs >= 0
          ? rawRetryAfterMs
          : undefined;
      return {
        provider,
        attempt: attemptNum,
        outcome: "rejected",
        category,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(providerCode === undefined ? {} : { providerCode }),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        durationMs,
      };
    }

    if (rawOutcome === "unknown") {
      const rawReason = safeReadProperty(raw, "reason");
      const rawHttpStatus = safeReadProperty(raw, "httpStatus");
      const reason =
        typeof rawReason === "string" && VALID_UNKNOWN_REASONS.has(rawReason)
          ? (rawReason as UnknownReason)
          : "adapter_exception";
      const httpStatus =
        typeof rawHttpStatus === "number" &&
        Number.isInteger(rawHttpStatus) &&
        rawHttpStatus >= 100 &&
        rawHttpStatus <= 599
          ? rawHttpStatus
          : undefined;
      return {
        provider,
        attempt: attemptNum,
        outcome: "unknown",
        reason,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        durationMs,
      };
    }

    return undefined;
  } catch {
    return undefined;
  }
}

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
  | "webhook_payload"
  | "message_lookup_failed";

/** JSON shape produced by `SmsError#toJSON()`. Contains no secrets, bodies, or full numbers. */
export type SerializedSmsError = {
  readonly name: string;
  readonly code: SmsErrorCode;
  readonly message: string;
  readonly retrySafe: boolean;
  readonly attempts: readonly SendAttempt[];
  readonly provider?: ProviderErrorInfo;
  readonly providerName?: string;
  readonly reason?: string;
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
    const safeAttempts: SendAttempt[] = [];
    try {
      const rawAttempts = this.attempts;
      if (Array.isArray(rawAttempts)) {
        for (const item of rawAttempts) {
          const sanitized = sanitizeAttemptForJson(item);
          if (sanitized !== undefined) {
            safeAttempts.push(sanitized);
          }
        }
      }
    } catch {
      // Malformed or revoked attempts array: omit unreadable entries.
    }

    let safeProvider: ProviderErrorInfo | undefined;
    try {
      const rawProvider = this.provider;
      if (rawProvider !== null && typeof rawProvider === "object" && !Array.isArray(rawProvider)) {
        const record = rawProvider as unknown as Record<string, unknown>;
        const rawName = safeReadProperty(record, "provider");
        const fallbackName = typeof rawName === "string" ? rawName : "unknown";
        safeProvider = sanitizeProviderDetails(record, fallbackName, true);
      }
    } catch {
      safeProvider = undefined;
    }

    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retrySafe: this.retrySafe,
      attempts: safeAttempts,
      ...(safeProvider === undefined ? {} : { provider: safeProvider }),
    };
  }
}

/** Client or adapter options are invalid. Nothing was sent. `retrySafe: true`. */
export class ConfigurationError extends SmsError {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, { code: "configuration", retrySafe: true, cause: options?.cause });
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
    const names = errors.map((error) => sanitizeDiagnosticToken(error.providerName, 64) ?? "unknown").join(", ");
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

  override toJSON(): SerializedSmsError {
    const safeProviderName =
      this.providerName === undefined ? undefined : (sanitizeDiagnosticToken(this.providerName, 64) ?? "unknown");
    return {
      ...super.toJSON(),
      reason: this.reason,
      ...(safeProviderName === undefined ? {} : { providerName: safeProviderName }),
    };
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

/**
 * `getMessage` could not read the provider's record of a message: a network
 * error, timeout, 5xx, malformed response, or a provider 4xx such as bad
 * credentials. `reason` says which.
 *
 * `retrySafe: false`: a failed lookup proves nothing about whether the message
 * was sent, so it is never a reason to resend. Calling `getMessage` again is safe.
 */
export class MessageLookupError extends SmsError {
  readonly reason: LookupFailureReason;
  readonly providerName: string;
  readonly providerId: string;

  constructor(options: {
    readonly reason: LookupFailureReason;
    readonly providerName: string;
    readonly providerId: string;
    readonly provider?: ProviderErrorInfo;
    readonly cause?: unknown;
  }) {
    const safeProviderName = sanitizeDiagnosticToken(options.providerName, 64) ?? "unknown";
    super(`The ${safeProviderName} message lookup failed (${options.reason.replace("_", " ")})`, {
      code: "message_lookup_failed",
      retrySafe: false,
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      cause: options.cause,
    });
    this.name = "MessageLookupError";
    this.reason = options.reason;
    this.providerName = options.providerName;
    this.providerId = options.providerId;
  }

  override toJSON(): SerializedSmsError {
    return {
      ...super.toJSON(),
      providerName: sanitizeDiagnosticToken(this.providerName, 64) ?? "unknown",
      reason: this.reason,
    };
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

  override toJSON(): SerializedSmsError {
    return {
      ...super.toJSON(),
      providerName: sanitizeDiagnosticToken(this.providerName, 64) ?? "unknown",
      reason: this.reason,
    };
  }
}

/**
 * The webhook body exceeded the 1 MiB limit (`reason: "body_too_large"`),
 * could not be read (`reason: "body_unreadable"`), or an authentic payload is
 * missing required fields.
 */
export class WebhookPayloadError extends SmsError {
  readonly providerName: string;
  readonly reason: "body_too_large" | "body_unreadable" | undefined;

  constructor(
    message: string,
    options: { readonly provider: string; readonly reason?: "body_too_large" | "body_unreadable"; readonly cause?: unknown },
  ) {
    super(message, {
      code: "webhook_payload",
      retrySafe: false,
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
    this.name = "WebhookPayloadError";
    this.providerName = options.provider;
    this.reason = options.reason;
  }

  override toJSON(): SerializedSmsError {
    return {
      ...super.toJSON(),
      providerName: sanitizeDiagnosticToken(this.providerName, 64) ?? "unknown",
      ...(this.reason === undefined ? {} : { reason: this.reason }),
    };
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
