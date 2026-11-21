import type { SmsAdapter, SmsMessageStatus, ValidationIssue } from "./adapters.js";
import {
  canonicalFromByAdapter,
  checkAdapter,
  issueToError,
  MESSAGE_NOT_OBJECT_ISSUE,
  validateMessage,
} from "./capabilities.js";
import { maskPhoneNumber } from "./e164.js";
import { estimateSegments, type SegmentPreview } from "./encoding.js";
import {
  ConfigurationError,
  HandoffUnknownError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  MessageLookupError,
  PolicyRejectedError,
  SendAbortedError,
  SmsError,
} from "./errors.js";
import { emitHook, type SendAttempt, type SmsHookEventBase } from "./events.js";
import { isRecord } from "./http.js";
import { runSendChain, type ChainResult, type SendCandidate } from "./fallback.js";
import { adaptersWithProviderOptions, canonicalProviderOptions, validateProviderOptions } from "./provider-options.js";
import { fingerprintMessage, type FinalIdempotencyRecord, type IdempotencyStore } from "./idempotency.js";
import { lookupOnce } from "./lookup.js";
import { resolveRetryOptions } from "./retry.js";
import type {
  SmsAdapterInfo,
  SmsClient,
  SmsClientOptions,
  SmsGetMessageOptions,
  SmsSendInput,
  SmsSendOptions,
  SmsSendResult,
  SmsValidationResult,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_TTL_SEC = 86_400;
const DEFAULT_STALE_RESERVATION_SEC = 300;

type InFlight = { readonly fingerprint: string; readonly promise: Promise<SmsSendResult> };

type IdempotencyConfig = {
  readonly store: IdempotencyStore;
  readonly ttlSec: number;
  readonly staleReservationSec: number;
};

const VALID_SENDER_TYPES = new Set([
  "long_code",
  "toll_free",
  "short_code",
  "alphanumeric",
  "messaging_service",
]);

const regexpSourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get;
const regexpFlagsGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, "flags")?.get;

function isRealRegExp(value: unknown): value is RegExp {
  if (!(value instanceof RegExp)) {
    return false;
  }
  try {
    regexpSourceGetter?.call(value);
    regexpFlagsGetter?.call(value);
    return true;
  } catch {
    return false;
  }
}

function isValidProviderOptionField(field: unknown): boolean {
  if (!isRecord(field) || typeof field["wire"] !== "string" || field["wire"].length === 0) {
    return false;
  }
  switch (field["type"]) {
    case "boolean":
      return true;
    case "string":
      return (
        (field["maxLength"] === undefined ||
          (typeof field["maxLength"] === "number" && Number.isInteger(field["maxLength"]) && field["maxLength"] > 0)) &&
        (field["pattern"] === undefined || isRealRegExp(field["pattern"]))
      );
    case "integer": {
      const min = field["min"];
      const max = field["max"];
      return (
        typeof min === "number" &&
        Number.isInteger(min) &&
        (max === undefined || (typeof max === "number" && Number.isInteger(max) && max >= min))
      );
    }
    case "enum": {
      const values = field["values"];
      return Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === "string");
    }
    default:
      return false;
  }
}

function isValidProviderOptionsSpec(spec: unknown): boolean {
  if (!isRecord(spec) || !isRecord(spec["options"]) || !Array.isArray(spec["reserved"])) {
    return false;
  }
  if (!spec["reserved"].every((w) => typeof w === "string")) {
    return false;
  }
  if (
    spec["nestedPrefixes"] !== undefined &&
    (!Array.isArray(spec["nestedPrefixes"]) || !spec["nestedPrefixes"].every((p) => typeof p === "string"))
  ) {
    return false;
  }
  return Object.values(spec["options"]).every(isValidProviderOptionField);
}

function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function freezeShallowRecord(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    defineOwn(copy, key, value[key]);
  }
  return Object.freeze(copy);
}

function freezeFromByAdapter(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    defineOwn(copy, key, freezeShallowRecord(value[key]));
  }
  return Object.freeze(copy);
}

function freezeProviderOptions(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (isRecord(entry)) {
      const entryCopy: Record<string, unknown> = {};
      for (const optKey of Object.keys(entry)) {
        const optVal = entry[optKey];
        defineOwn(entryCopy, optKey, optKey === "extra" ? freezeShallowRecord(optVal) : optVal);
      }
      defineOwn(copy, key, Object.freeze(entryCopy));
    } else {
      defineOwn(copy, key, entry);
    }
  }
  return Object.freeze(copy);
}

function snapshotSendAt(value: unknown): unknown {
  if (!(value instanceof Date)) {
    return value;
  }
  try {
    return new Date(Date.prototype.getTime.call(value));
  } catch {
    return new Date(Number.NaN);
  }
}

function snapshotSendInput(raw: SmsSendInput): SmsSendInput {
  const source = raw as unknown as Record<string, unknown>;
  const from = source["from"];
  const fromByAdapter = source["fromByAdapter"];
  const mediaUrls = source["mediaUrls"];
  const sendAt = source["sendAt"];
  const validityPeriodSec = source["validityPeriodSec"];
  const webhookUrl = source["webhookUrl"];
  const idempotencyKey = source["idempotencyKey"];
  const providerOptions = source["providerOptions"];
  const snapshot: Record<string, unknown> = {
    to: source["to"],
    body: source["body"],
  };
  if (from !== undefined) {
    snapshot["from"] = freezeShallowRecord(from);
  }
  if (fromByAdapter !== undefined) {
    snapshot["fromByAdapter"] = freezeFromByAdapter(fromByAdapter);
  }
  if (mediaUrls !== undefined) {
    snapshot["mediaUrls"] = Array.isArray(mediaUrls) ? Object.freeze([...mediaUrls]) : mediaUrls;
  }
  if (sendAt !== undefined) {
    snapshot["sendAt"] = snapshotSendAt(sendAt);
  }
  if (validityPeriodSec !== undefined) {
    snapshot["validityPeriodSec"] = validityPeriodSec;
  }
  if (webhookUrl !== undefined) {
    snapshot["webhookUrl"] = webhookUrl;
  }
  if (idempotencyKey !== undefined) {
    snapshot["idempotencyKey"] = idempotencyKey;
  }
  if (providerOptions !== undefined) {
    snapshot["providerOptions"] = freezeProviderOptions(providerOptions);
  }
  return Object.freeze(snapshot) as unknown as SmsSendInput;
}

/**
 * Creates an SMS client over one or more adapters.
 *
 * @throws {ConfigurationError} when no adapters are given, names repeat, or numeric options are invalid.
 */
export function createSmsClient(options: SmsClientOptions): SmsClient {
  if (!isRecord(options)) {
    throw new ConfigurationError("createSmsClient options must be an object.");
  }
  if (!Array.isArray(options.adapters) || options.adapters.length === 0) {
    throw new ConfigurationError("createSmsClient needs at least one adapter.");
  }
  const adapters = [...options.adapters];
  for (const adapter of adapters) {
    if (
      !isRecord(adapter) ||
      typeof adapter["name"] !== "string" ||
      adapter["name"].length === 0 ||
      typeof adapter["send"] !== "function" ||
      !isRecord(adapter["capabilities"]) ||
      !Array.isArray(adapter["capabilities"]["senderTypes"]) ||
      !adapter["capabilities"]["senderTypes"].every((t) => typeof t === "string" && VALID_SENDER_TYPES.has(t)) ||
      (adapter["capabilities"]["validityPeriod"] !== null &&
        (!isRecord(adapter["capabilities"]["validityPeriod"]) ||
          typeof adapter["capabilities"]["validityPeriod"]["minSec"] !== "number" ||
          !Number.isInteger(adapter["capabilities"]["validityPeriod"]["minSec"]) ||
          adapter["capabilities"]["validityPeriod"]["minSec"] <= 0 ||
          typeof adapter["capabilities"]["validityPeriod"]["maxSec"] !== "number" ||
          !Number.isInteger(adapter["capabilities"]["validityPeriod"]["maxSec"]) ||
          adapter["capabilities"]["validityPeriod"]["maxSec"] < adapter["capabilities"]["validityPeriod"]["minSec"])) ||
      (adapter["providerOptions"] !== undefined && !isValidProviderOptionsSpec(adapter["providerOptions"])) ||
      (adapter["validate"] !== undefined && typeof adapter["validate"] !== "function") ||
      (adapter["getMessage"] !== undefined && typeof adapter["getMessage"] !== "function")
    ) {
      throw new ConfigurationError("Each adapter must be an object with a non-empty name, capabilities, and send().");
    }
  }
  if (options.beforeSend !== undefined && typeof options.beforeSend !== "function") {
    throw new ConfigurationError("beforeSend must be a function.");
  }
  const names = adapters.map((adapter) => adapter.name);
  if (new Set(names).size !== names.length) {
    throw new ConfigurationError(`Adapter names must be unique; got ${names.join(", ")}.`);
  }
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  if (!(typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647)) {
    throw new ConfigurationError("timeoutMs must be a positive number up to 2147483647.");
  }

  const retry = resolveRetryOptions(options.retry);
  if (options.fallback !== undefined && options.fallback !== "none" && options.fallback !== "on-known-rejection") {
    throw new ConfigurationError('fallback must be "none" or "on-known-rejection".');
  }
  const fallback = options.fallback === "on-known-rejection";
  if (options.hooks !== undefined) {
    if (!isRecord(options.hooks)) {
      throw new ConfigurationError("hooks must be an object of callback functions.");
    }
    for (const [hookName, hookFn] of Object.entries(options.hooks)) {
      if (hookFn !== undefined && typeof hookFn !== "function") {
        throw new ConfigurationError(`hooks.${hookName} must be a function.`);
      }
    }
  }
  const hooks = options.hooks ?? {};
  if (
    options.idempotency !== undefined &&
    (!isRecord(options.idempotency) ||
      !isRecord(options.idempotency.store) ||
      typeof options.idempotency.store.get !== "function" ||
      typeof options.idempotency.store.reserve !== "function" ||
      typeof options.idempotency.store.finalize !== "function")
  ) {
    throw new ConfigurationError("idempotency must be an object with a valid store.");
  }
  const idempotency: IdempotencyConfig | undefined =
    options.idempotency === undefined
      ? undefined
      : {
          store: options.idempotency.store,
          ttlSec: requirePositiveSeconds(
            options.idempotency.ttlSec === undefined ? DEFAULT_TTL_SEC : options.idempotency.ttlSec,
            "ttlSec",
          ),
          staleReservationSec: requirePositiveSeconds(
            options.idempotency.staleReservationSec === undefined
              ? DEFAULT_STALE_RESERVATION_SEC
              : options.idempotency.staleReservationSec,
            "staleReservationSec",
          ),
        };
  const inFlight = new Map<string, InFlight>();
  const configuredAdapters = new Set(adapters.map((adapter) => adapter.name));

  const validate = (rawInput: SmsSendInput): SmsValidationResult => {
    if (!isRecord(rawInput)) {
      return {
        ...estimateSegments(""),
        supported: false,
        issues: [MESSAGE_NOT_OBJECT_ISSUE],
        adapterCandidates: [],
        providerOptionsFor: [],
      };
    }
    const input = snapshotSendInput(rawInput);
    const preview = estimateSegments(typeof input.body === "string" ? input.body : "");
    const messageIssues = [
      ...validateMessage(input, configuredAdapters),
      ...validateProviderOptions(adapters, input.providerOptions),
    ];
    if (messageIssues.length > 0) {
      return { ...preview, supported: false, issues: messageIssues, adapterCandidates: [], providerOptionsFor: [] };
    }

    const issues: ValidationIssue[] = [];
    const candidates: SmsAdapter[] = [];
    let primarySupported = false;
    adapters.forEach((adapter, index) => {
      const check = checkAdapter(adapter, input);
      if (check.kind === "ok") {
        candidates.push(adapter);
        primarySupported ||= index === 0;
      } else {
        issues.push(...check.issues);
      }
    });
    return {
      ...preview,
      supported: primarySupported,
      issues,
      adapterCandidates: candidates.map((adapter) => adapter.name),
      providerOptionsFor: adaptersWithProviderOptions(candidates, input.providerOptions),
    };
  };

  const send = async (rawInput: SmsSendInput, sendOptions: SmsSendOptions = {}): Promise<SmsSendResult> => {
    if (!isRecord(sendOptions)) {
      throw new ConfigurationError("send options must be an object.");
    }
    const signal = requireOptionalSignal(sendOptions.signal, "send");
    if (!isRecord(rawInput)) {
      throw issueToError(MESSAGE_NOT_OBJECT_ISSUE);
    }
    const input = snapshotSendInput(rawInput);
    const preview = estimateSegments(typeof input.body === "string" ? input.body : "");
    const candidates = buildCandidates(input);
    if (signal?.aborted === true) {
      throw new SendAbortedError([], signal.reason);
    }

    const key = input.idempotencyKey;
    if (key === undefined) {
      return execute({ input, candidates, preview, signal, id: newId(), reservation: undefined });
    }

    const fingerprint = await fingerprintMessage({
      to: input.to,
      from: input.from ?? null,
      body: input.body,
      mediaUrls: input.mediaUrls ?? [],
      sendAt: input.sendAt?.toISOString() ?? null,
      validityPeriodSec: input.validityPeriodSec ?? null,
      webhookUrl: input.webhookUrl ?? null,
      providerOptions: canonicalProviderOptions(adapters, input.providerOptions),
      fromByAdapter: canonicalFromByAdapter(adapters, input),
    });

    const running = inFlight.get(key);
    if (running !== undefined) {
      if (running.fingerprint !== fingerprint) {
        throw new IdempotencyConflictError(key);
      }
      const result = await running.promise;
      return { ...result, replayed: true };
    }

    const promise = sendWithKey({ input, candidates, preview, signal, key, fingerprint });
    inFlight.set(key, { fingerprint, promise });
    try {
      return await promise;
    } finally {
      inFlight.delete(key);
    }
  };

  /** Validates and builds the ordered candidates, throwing for the primary adapter's first issue. */
  const buildCandidates = (input: SmsSendInput): [SendCandidate, ...SendCandidate[]] => {
    const [firstIssue] = [
      ...validateMessage(input, configuredAdapters),
      ...validateProviderOptions(adapters, input.providerOptions),
    ];
    if (firstIssue !== undefined) {
      throw issueToError(firstIssue);
    }

    const [primary, ...rest] = adapters;
    const primaryCheck = checkAdapter(primary, input);
    if (primaryCheck.kind === "issues") {
      const [issue] = primaryCheck.issues;
      throw issueToError(issue ?? { code: "invalid_field", field: "body", message: "Invalid message." });
    }

    const candidates: [SendCandidate, ...SendCandidate[]] = [{ adapter: primary, message: primaryCheck.message }];
    if (fallback) {
      for (const adapter of rest) {
        const check = checkAdapter(adapter, input);
        if (check.kind === "ok") {
          candidates.push({ adapter, message: check.message });
        }
      }
    }
    return candidates;
  };

  const sendWithKey = async (args: {
    readonly input: SmsSendInput;
    readonly candidates: [SendCandidate, ...SendCandidate[]];
    readonly preview: SegmentPreview;
    readonly signal: AbortSignal | undefined;
    readonly key: string;
    readonly fingerprint: string;
  }): Promise<SmsSendResult> => {
    if (idempotency === undefined) {
      return execute({ ...args, id: newId(), reservation: undefined });
    }

    const now = Date.now();
    const reserved = await idempotency.store.reserve({ key: args.key, fingerprint: args.fingerprint, now });
    if (reserved.kind === "reserved") {
      return execute({
        ...args,
        id: newId(),
        reservation: { config: idempotency, key: args.key, fingerprint: args.fingerprint, id: reserved.reservationId },
      });
    }

    const record = reserved.record;
    if (record.fingerprint !== args.fingerprint) {
      throw new IdempotencyConflictError(args.key);
    }
    switch (record.state) {
      case "accepted":
        return { ...record.result, replayed: true };
      case "unknown":
        throw new HandoffUnknownError(
          "A previous send with this idempotency key has an unknown outcome. It will not be resent; reconcile with the provider.",
          { reason: "replayed_unknown", attempts: record.error.attempts },
        );
      case "reserved":
        if (now - record.reservedAt > idempotency.staleReservationSec * 1000) {
          throw new HandoffUnknownError(
            "A previous send with this idempotency key never finished. Its outcome is unknown and it will not be resent.",
            { reason: "stale_reservation", attempts: [] },
          );
        }
        throw new IdempotencyInProgressError(args.key);
      case "rejected":
        // The store only returns a same-fingerprint rejected record when it failed to re-reserve it.
        throw new IdempotencyInProgressError(args.key);
      default: {
        const _exhaustive: never = record;
        return _exhaustive;
      }
    }
  };

  const execute = async (args: {
    readonly input: SmsSendInput;
    readonly candidates: [SendCandidate, ...SendCandidate[]];
    readonly preview: SegmentPreview;
    readonly signal: AbortSignal | undefined;
    readonly id: string;
    readonly reservation:
      | { readonly config: IdempotencyConfig; readonly key: string; readonly fingerprint: string; readonly id: string }
      | undefined;
  }): Promise<SmsSendResult> => {
    const { input, preview, id, reservation } = args;
    const base: SmsHookEventBase = {
      id,
      to: maskPhoneNumber(input.to),
      encoding: preview.encoding,
      segments: preview.segments,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    };

    const finalize = async (record: FinalIdempotencyRecord): Promise<void> => {
      if (reservation === undefined) {
        return;
      }
      try {
        await reservation.config.store.finalize({
          key: reservation.key,
          reservationId: reservation.id,
          record,
          ttlSec: reservation.config.ttlSec,
          now: Date.now(),
        });
      } catch {
        // The outcome is already decided. An unfinalized reservation later
        // reads as in progress, then as an unknown outcome, so it never resends.
      }
    };

    const fail = async (error: SmsError): Promise<never> => {
      const state = error instanceof HandoffUnknownError ? "unknown" : "rejected";
      await finalize({ state, fingerprint: reservation?.fingerprint ?? "", error: error.toJSON() });
      emitHook(hooks.onFailure, { ...base, errorCode: error.code, retrySafe: error.retrySafe, attempts: error.attempts });
      throw error;
    };

    if (options.beforeSend !== undefined) {
      let isObj = false;
      let kind: unknown;
      let reason: unknown;
      try {
        const policyMessage: SmsSendInput =
          input.sendAt instanceof Date
            ? Object.freeze({ ...input, sendAt: new Date(input.sendAt.getTime()) })
            : input;
        const decision: unknown = await options.beforeSend({
          id,
          message: policyMessage,
          encoding: preview.encoding,
          segments: preview.segments,
        });
        if (isRecord(decision)) {
          isObj = true;
          kind = decision["kind"];
          if (kind === "reject") {
            reason = decision["reason"];
          }
        }
      } catch (cause) {
        const policyError = new PolicyRejectedError("beforeSend threw");
        await finalize({ state: "rejected", fingerprint: reservation?.fingerprint ?? "", error: policyError.toJSON() });
        // The caller gets the original exception; hooks see it as a policy failure.
        emitHook(hooks.onFailure, { ...base, errorCode: policyError.code, retrySafe: policyError.retrySafe, attempts: [] });
        throw cause;
      }
      if (!isObj || (kind !== "allow" && kind !== "reject")) {
        return fail(new PolicyRejectedError('beforeSend must return { kind: "allow" } or { kind: "reject", reason }.'));
      }
      if (kind === "reject") {
        const normalizedReason = typeof reason === "string" && reason.length > 0 ? reason : "beforeSend rejected";
        return fail(new PolicyRejectedError(normalizedReason));
      }
    }

    // Kept here as well as in the chain so an unexpected throw still reports
    // every request already made, which is what reconciliation needs.
    const attempts: SendAttempt[] = [];
    let chain: ChainResult;
    try {
      chain = await runSendChain({
        candidates: args.candidates,
        fallback,
        retry,
        timeoutMs,
        signal: args.signal,
        idempotencyKey: input.idempotencyKey,
        onAttempt: (attempt) => {
          attempts.push(attempt);
          emitHook(hooks.onAttempt, { ...base, attempt });
        },
      });
    } catch (cause) {
      return fail(
        new HandoffUnknownError("The send failed unexpectedly after it may have reached a provider.", {
          reason: "adapter_exception",
          attempts: [...attempts],
          cause,
        }),
      );
    }

    if (chain.kind === "failed") {
      return fail(chain.error);
    }

    const result: SmsSendResult = {
      id,
      provider: chain.provider,
      providerId: chain.providerId,
      handoff: "accepted",
      delivery: chain.delivery,
      encoding: preview.encoding,
      segments: preview.segments,
      attemptedProviders: [...new Set(chain.attempts.map((attempt) => attempt.provider))],
      attempts: chain.attempts,
      replayed: false,
    };
    await finalize({ state: "accepted", fingerprint: reservation?.fingerprint ?? "", result });
    emitHook(hooks.onAccepted, {
      ...base,
      provider: result.provider,
      providerId: result.providerId,
      attempts: result.attempts,
    });
    return result;
  };

  const getMessage = async (
    providerId: string,
    lookupOptions: SmsGetMessageOptions = {},
  ): Promise<SmsMessageStatus | undefined> => {
    if (
      typeof providerId !== "string" ||
      providerId.length === 0 ||
      providerId === "." ||
      providerId === ".."
    ) {
      throw new ConfigurationError("getMessage needs a non-empty providerId.");
    }
    if (!isRecord(lookupOptions)) {
      throw new ConfigurationError("getMessage options must be an object.");
    }
    const signal = requireOptionalSignal(lookupOptions.signal, "getMessage");
    if (lookupOptions.adapter !== undefined && typeof lookupOptions.adapter !== "string") {
      throw new ConfigurationError("getMessage adapter must be a string.");
    }
    const name = lookupOptions.adapter === undefined ? adapters[0].name : lookupOptions.adapter;
    const adapter = adapters.find((candidate) => candidate.name === name);
    if (adapter === undefined) {
      throw new ConfigurationError(`getMessage: no adapter named "${name}" is configured.`);
    }
    if (adapter.getMessage === undefined) {
      throw new ConfigurationError(`getMessage: the ${name} adapter cannot look up messages.`);
    }
    const outcome = await lookupOnce({ adapter, providerId, timeoutMs, signal });
    switch (outcome.kind) {
      case "found":
        return outcome.status;
      case "not_found":
        return undefined;
      case "failed":
        throw new MessageLookupError({
          reason: outcome.reason,
          providerName: name,
          providerId,
          ...(outcome.details === undefined ? {} : { provider: outcome.details }),
          cause: outcome.cause,
        });
      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  };

  return {
    send,
    validate,
    getMessage,
    capabilities(): readonly SmsAdapterInfo[] {
      return adapters.map((adapter) => ({
        name: adapter.name,
        capabilities: adapter.capabilities,
        support: adapter.support,
        defaultFrom: adapter.defaultFrom,
        messageLookup: adapter.getMessage !== undefined,
      }));
    },
  };
}

const MAX_IDEMPOTENCY_SECONDS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);

function requirePositiveSeconds(value: number, name: "ttlSec" | "staleReservationSec"): number {
  if (!(typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_IDEMPOTENCY_SECONDS)) {
    throw new ConfigurationError(
      `idempotency.${name} must be a safe integer number of seconds between 1 and ${MAX_IDEMPOTENCY_SECONDS}.`,
    );
  }
  return value;
}

const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

function requireOptionalSignal(value: AbortSignal | undefined, method: "send" | "getMessage"): AbortSignal | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (abortSignalAbortedGetter !== undefined) {
    try {
      abortSignalAbortedGetter.call(value);
      return value;
    } catch {
      throw new ConfigurationError(`${method} signal must be an AbortSignal.`);
    }
  }
  if (!(value instanceof AbortSignal)) {
    throw new ConfigurationError(`${method} signal must be an AbortSignal.`);
  }
  return value;
}

function newId(): string {
  return `sms_${crypto.randomUUID().replaceAll("-", "")}`;
}
