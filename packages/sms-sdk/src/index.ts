/**
 * SMS SDK: one typed send API over Twilio, Telnyx, Plivo, and Vonage.
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
