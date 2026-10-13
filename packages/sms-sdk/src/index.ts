/**
 * SMS SDK: one typed send API over the built-in SMS providers.
 *
 * Adapters live in subpaths (`@opencoredev/sms-sdk/twilio`, `/telnyx`,
 * `/plivo`, `/vonage`), webhooks in `/webhooks`, test helpers in `/testing`,
 * and segment math in `/encoding`.
 *
 * @packageDocumentation
 */

export { createSmsClient } from "./core/client.js";
export { isE164, maskPhoneNumber, type E164 } from "./core/e164.js";
export { estimateSegments, isGsm7, type SegmentPreview } from "./core/encoding.js";
export { resolveSender, supportsSender, type SenderResolution } from "./core/capabilities.js";
export { memoryIdempotencyStore } from "./core/idempotency.js";
export { redactText } from "./core/redact.js";
export {
  AllProvidersRejectedError,
  ConfigurationError,
  HandoffUnknownError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  InvalidMessageError,
  InvalidRecipientError,
  InvalidSenderError,
  isFallbackEligible,
  isSmsError,
  PolicyRejectedError,
  ProviderAuthError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  SendAbortedError,
  SmsError,
  UnsupportedFieldError,
  WebhookPayloadError,
  WebhookSignatureError,
} from "./core/errors.js";

export type {
  AdapterMessage,
  AdapterSendOutcome,
  AdapterSupport,
  Delivery,
  Handoff,
  ProviderErrorInfo,
  ProviderExtra,
  ProviderOptionField,
  ProviderOptionValue,
  ProviderOptionsOf,
  ProviderOptionsSpec,
  ProviderWireField,
  RejectionCategory,
  SendContext,
  SenderType,
  SmsAdapter,
  SmsCapabilities,
  SmsEncoding,
  SmsFrom,
  SmsSender,
  UnknownReason,
  ValidationField,
  ValidationIssue,
  ValidationIssueCode,
} from "./core/adapters.js";
export type {
  HandoffUnknownReason,
  SerializedSmsError,
  SmsErrorCode,
  WebhookFailureReason,
} from "./core/errors.js";
export type {
  SendAttempt,
  SmsAcceptedEvent,
  SmsAttemptEvent,
  SmsClientHooks,
  SmsFailureEvent,
  SmsHookEventBase,
} from "./core/events.js";
export type {
  FinalIdempotencyRecord,
  FinalizeResult,
  IdempotencyRecord,
  IdempotencyStore,
  MemoryIdempotencyStore,
  ReserveResult,
} from "./core/idempotency.js";
export type { FetchLike } from "./core/http.js";
export type {
  BeforeSendContext,
  PolicyDecision,
  RetryOptions,
  SmsAdapterInfo,
  SmsClient,
  SmsClientOptions,
  SmsSendInput,
  SmsSendOptions,
  SmsSendResult,
  SmsValidationResult,
} from "./core/types.js";

/**
 * Provider-specific send options, keyed by adapter name. Each adapter subpath
 * adds its own key by module augmentation, so the keys you can write are the
 * adapters you import. A custom adapter can do the same:
 *
 * ```ts
 * declare module "@opencoredev/sms-sdk" {
 *   interface SmsProviderOptions {
 *     readonly acme?: ProviderOptionsOf<typeof ACME_PROVIDER_OPTIONS>;
 *   }
 * }
 * ```
 *
 * It is declared here, in the package root, so the built-in adapters and your
 * own `declare module "@opencoredev/sms-sdk"` augment the same declaration.
 * Augmenting a re-export instead depends on the order TypeScript reads files.
 */
export interface SmsProviderOptions {}
