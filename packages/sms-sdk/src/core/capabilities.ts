import type {
  AdapterMessage,
  SenderType,
  SmsAdapter,
  SmsCapabilities,
  SmsFrom,
  SmsSender,
  ValidationIssue,
} from "./adapters.js";
import { isE164 } from "./e164.js";
import {
  InvalidMessageError,
  InvalidRecipientError,
  InvalidSenderError,
  UnsupportedFieldError,
  type SmsError,
} from "./errors.js";
import { isRecord } from "./http.js";
import { parseProviderOptions } from "./provider-options.js";
import type { SmsSendInput } from "./types.js";

const SENDER_ID_PATTERN = /^(?=.*[A-Za-z])[A-Za-z0-9 ]{1,11}$/;
const SHORT_CODE_PATTERN = /^\d{3,8}$/;
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/** Outcome of resolving a caller-supplied {@link SmsFrom}. */
export type SenderResolution =
  | { readonly kind: "ok"; readonly sender: SmsSender }
  | { readonly kind: "missing" }
  | { readonly kind: "invalid"; readonly message: string };

/**
 * Turns an {@link SmsFrom} into a validated {@link SmsSender}. Checks format
 * only: alphanumeric IDs are 1-11 letters, digits, or spaces with at least one
 * letter; short codes are 3-8 digits.
 */
export function resolveSender(from: SmsFrom | undefined): SenderResolution {
  if (from === undefined) {
    return { kind: "missing" };
  }
  if (typeof from === "string") {
    return isE164(from)
      ? { kind: "ok", sender: { kind: "phone_number", value: from } }
      : { kind: "invalid", message: "Sender phone number must be E.164, such as +14155550123." };
  }
  if (typeof from !== "object" || from === null) {
    return { kind: "invalid", message: "Sender must be an E.164 string or a sender object." };
  }
  if ("senderId" in from) {
    return SENDER_ID_PATTERN.test(from.senderId)
      ? { kind: "ok", sender: { kind: "alphanumeric", value: from.senderId } }
      : {
          kind: "invalid",
          message: "Alphanumeric sender IDs are 1-11 letters, digits, or spaces and contain at least one letter.",
        };
  }
  if ("shortCode" in from) {
    return SHORT_CODE_PATTERN.test(from.shortCode)
      ? { kind: "ok", sender: { kind: "short_code", value: from.shortCode } }
      : { kind: "invalid", message: "Short codes are 3-8 digits." };
  }
  if ("messagingService" in from) {
    return from.messagingService.trim().length > 0
      ? { kind: "ok", sender: { kind: "messaging_service", value: from.messagingService } }
      : { kind: "invalid", message: "Messaging service identifiers must be non-empty." };
  }
  return { kind: "invalid", message: "Unrecognized sender object." };
}

/** The {@link SenderType} values that allow a sender of this kind. */
export function senderTypesFor(sender: SmsSender): readonly SenderType[] {
  switch (sender.kind) {
    case "phone_number":
      return ["long_code", "toll_free"];
    case "short_code":
      return ["short_code"];
    case "alphanumeric":
      return ["alphanumeric"];
    case "messaging_service":
      return ["messaging_service"];
    default: {
      const _exhaustive: never = sender;
      return _exhaustive;
    }
  }
}

/** True when the adapter declares at least one sender type that fits `sender`. */
export function supportsSender(capabilities: SmsCapabilities, sender: SmsSender): boolean {
  return senderTypesFor(sender).some((type) => capabilities.senderTypes.includes(type));
}

/** Checks that do not depend on an adapter: recipient, body, field formats. */
export function validateMessage(input: SmsSendInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const mediaUrls = input.mediaUrls ?? [];

  if (!isE164(input.to)) {
    issues.push({
      code: "invalid_recipient",
      field: "to",
      message: "Recipient must be E.164: a +, a country code, and up to 15 digits, such as +14155550123.",
    });
  }
  if (typeof input.body !== "string") {
    issues.push({ code: "invalid_field", field: "body", message: "Body must be a string." });
  } else if (input.body.length === 0 && mediaUrls.length === 0) {
    issues.push({ code: "empty_body", field: "body", message: "Body is empty and there is no media to send." });
  }
  if (mediaUrls.some((url) => !isHttpUrl(url))) {
    issues.push({ code: "invalid_field", field: "mediaUrls", message: "Every media URL must be an absolute http(s) URL." });
  }
  if (input.sendAt !== undefined && !(input.sendAt instanceof Date && Number.isFinite(input.sendAt.getTime()))) {
    issues.push({ code: "invalid_field", field: "sendAt", message: "sendAt must be a valid Date." });
  }
  if (
    input.validityPeriodSec !== undefined &&
    !(Number.isInteger(input.validityPeriodSec) && input.validityPeriodSec > 0)
  ) {
    issues.push({
      code: "invalid_field",
      field: "validityPeriodSec",
      message: "validityPeriodSec must be a positive integer.",
    });
  }
  if (input.webhookUrl !== undefined && !isHttpUrl(input.webhookUrl)) {
    issues.push({ code: "invalid_field", field: "webhookUrl", message: "webhookUrl must be an absolute http(s) URL." });
  }
  if (
    input.idempotencyKey !== undefined &&
    (input.idempotencyKey.length === 0 || input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH)
  ) {
    issues.push({
      code: "invalid_field",
      field: "idempotencyKey",
      message: `idempotencyKey must be 1-${MAX_IDEMPOTENCY_KEY_LENGTH} characters.`,
    });
  }
  return issues;
}

/** Result of checking one adapter against a message. */
export type AdapterCheck =
  | { readonly kind: "ok"; readonly message: AdapterMessage }
  | { readonly kind: "issues"; readonly issues: readonly ValidationIssue[] };

/**
 * Builds the {@link AdapterMessage} for `adapter` and checks sender and
 * capability support. Assumes {@link validateMessage} found no issues.
 */
export function checkAdapter(adapter: SmsAdapter, input: SmsSendInput): AdapterCheck {
  const provider = adapter.name;
  const resolution = resolveSender(input.from ?? adapter.defaultFrom);

  if (resolution.kind === "missing") {
    return {
      kind: "issues",
      issues: [{ code: "missing_sender", field: "from", provider, message: `No sender: pass from or configure one on the ${provider} adapter.` }],
    };
  }
  if (resolution.kind === "invalid") {
    return { kind: "issues", issues: [{ code: "invalid_sender", field: "from", provider, message: resolution.message }] };
  }

  const issues: ValidationIssue[] = [];
  const capabilities = adapter.capabilities;
  const sender = resolution.sender;
  const mediaUrls = input.mediaUrls ?? [];

  if (!supportsSender(capabilities, sender)) {
    issues.push(unsupported(provider, "from", `${provider} does not support ${sender.kind.replace("_", " ")} senders.`));
  }
  if (mediaUrls.length > 0 && !capabilities.mms) {
    issues.push(unsupported(provider, "mediaUrls", `${provider} adapter does not support mediaUrls (MMS).`));
  }
  if (input.sendAt !== undefined && !capabilities.scheduling) {
    issues.push(unsupported(provider, "sendAt", `${provider} adapter does not support sendAt (scheduling).`));
  }
  if (input.validityPeriodSec !== undefined) {
    const range = capabilities.validityPeriod;
    if (range === null) {
      issues.push(unsupported(provider, "validityPeriodSec", `${provider} adapter does not support validityPeriodSec.`));
    } else if (input.validityPeriodSec < range.minSec || input.validityPeriodSec > range.maxSec) {
      issues.push({
        code: "invalid_field",
        field: "validityPeriodSec",
        provider,
        message: `${provider} accepts validityPeriodSec from ${range.minSec} to ${range.maxSec}.`,
      });
    }
  }
  if (input.webhookUrl !== undefined && !capabilities.webhookUrlOverride) {
    issues.push(unsupported(provider, "webhookUrl", `${provider} adapter does not support a per-message webhookUrl.`));
  }

  const options = parseProviderOptions(adapter, providerOptionsEntry(input, provider));
  if (options.kind === "issues") {
    issues.push(...options.issues);
  }

  const message: AdapterMessage = {
    to: input.to,
    from: sender,
    body: input.body,
    mediaUrls,
    ...(input.sendAt === undefined ? {} : { sendAt: input.sendAt }),
    ...(input.validityPeriodSec === undefined ? {} : { validityPeriodSec: input.validityPeriodSec }),
    ...(input.webhookUrl === undefined ? {} : { webhookUrl: input.webhookUrl }),
    ...(options.kind === "ok" && options.fields.length > 0 ? { providerFields: options.fields } : {}),
  };

  if (issues.length === 0 && adapter.validate !== undefined) {
    issues.push(...adapter.validate(message).map((issue) => ({ ...issue, provider })));
  }
  return issues.length === 0 ? { kind: "ok", message } : { kind: "issues", issues };
}

/** The caller's `providerOptions` entry for `adapterName`, still unparsed. */
function providerOptionsEntry(input: SmsSendInput, adapterName: string): unknown {
  const all: unknown = input.providerOptions;
  return isRecord(all) ? all[adapterName] : undefined;
}

/** Converts a validation issue into the error `send()` throws for it. */
export function issueToError(issue: ValidationIssue): SmsError {
  switch (issue.code) {
    case "invalid_recipient":
      return new InvalidRecipientError(issue.message);
    case "invalid_sender":
    case "missing_sender":
      return new InvalidSenderError(issue.message, issue.provider === undefined ? {} : { provider: issue.provider });
    case "empty_body":
    case "invalid_field":
      return new InvalidMessageError(issue.message, { field: issue.field });
    case "unsupported_field":
      return new UnsupportedFieldError(issue.message, { field: issue.field, provider: issue.provider ?? "unknown" });
    default: {
      const _exhaustive: never = issue.code;
      return _exhaustive;
    }
  }
}

function unsupported(provider: string, field: ValidationIssue["field"], message: string): ValidationIssue {
  return { code: "unsupported_field", field, provider, message };
}

function isHttpUrl(value: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
