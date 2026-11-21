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
  InvalidMessageError,
  MessageLookupError,
  PolicyRejectedError,
  SendAbortedError,
  SmsError,
} from "./errors.js";
import { emitHook, type SendAttempt, type SmsHookEventBase } from "./events.js";
import { freezeCapabilities, freezeProviderOptionsSpec, freezeSender, isPlainObject, isRecord, sanitizeProviderDetails } from "./http.js";
import { DELIVERIES, UNKNOWN_REASONS, runSendChain, type ChainResult, type SendCandidate } from "./fallback.js";
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

export function isValidProviderOptionsSpec(spec: unknown): boolean {
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

function freezeShallowPlainRecord(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    defineOwn(copy, key, value[key]);
  }
  return Object.freeze(copy);
}

function hasKey(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key) || (key in record && !(key in Object.prototype));
}

function freezeFromByAdapter(value: unknown, configuredNames: readonly string[]): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const key of configuredNames) {
    if (hasKey(value, key)) {
      defineOwn(copy, key, freezeSender(value[key]));
    }
  }
  return Object.freeze(copy);
}

function freezeProviderOptions(value: unknown, configuredNames: readonly string[]): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const copy: Record<string, unknown> = {};
  for (const key of configuredNames) {
    if (!hasKey(value, key)) {
      continue;
    }
    const entry = value[key];
    if (isPlainObject(entry)) {
      const entryCopy: Record<string, unknown> = {};
      for (const optKey of Object.keys(entry)) {
        const optVal = entry[optKey];
        defineOwn(entryCopy, optKey, optKey === "extra" ? freezeShallowPlainRecord(optVal) : optVal);
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

function snapshotSendInput(raw: SmsSendInput, configuredNames: readonly string[]): SmsSendInput {
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
    snapshot["from"] = freezeSender(from);
  }
  if (fromByAdapter !== undefined) {
    snapshot["fromByAdapter"] = freezeFromByAdapter(fromByAdapter, configuredNames);
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
    snapshot["providerOptions"] = freezeProviderOptions(providerOptions, configuredNames);
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
  let rawAdapters: unknown;
  let beforeSend: SmsClientOptions["beforeSend"];
  let rawTimeoutMs: unknown;
  let rawRetry: SmsClientOptions["retry"];
  let rawFallback: unknown;
  let rawHooks: unknown;
  let rawIdempotency: unknown;
  let rawAdapterList: unknown[];
  try {
    rawAdapters = options.adapters;
    beforeSend = options.beforeSend;
    rawTimeoutMs = options.timeoutMs;
    rawRetry = options.retry;
    rawFallback = options.fallback;
    rawHooks = options.hooks;
    rawIdempotency = options.idempotency;
    if (!Array.isArray(rawAdapters) || rawAdapters.length === 0) {
      throw new ConfigurationError("createSmsClient needs at least one adapter.");
    }
    rawAdapterList = [...rawAdapters];
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("createSmsClient options must be an object.");
  }
  const validatedAdapters: SmsAdapter[] = [];
  for (const rawAdapter of rawAdapterList) {
    try {
      if (!isRecord(rawAdapter)) {
        throw new ConfigurationError("Each adapter must be an object with a non-empty name, capabilities, support, and send().");
      }
      const adapterName = rawAdapter["name"];
      const rawSend = rawAdapter["send"];
      const rawCapabilities = rawAdapter["capabilities"];
      const rawSupport = rawAdapter["support"];
      const rawProviderOptions = rawAdapter["providerOptions"];
      const rawDefaultFrom = rawAdapter["defaultFrom"];
      const rawValidate = rawAdapter["validate"];
      const rawGetMessage = rawAdapter["getMessage"];
      if (!isRecord(rawCapabilities) || !isRecord(rawSupport)) {
        throw new ConfigurationError("Each adapter must be an object with a non-empty name, capabilities, support, and send().");
      }
      const frozenCaps = freezeCapabilities(rawCapabilities as unknown as SmsAdapter["capabilities"]);
      const rawSupportStatus = rawSupport["status"];
      const rawSupportNotes = rawSupport["notes"];
      const frozenSupport = Object.freeze({
        status: rawSupportStatus as SmsAdapter["support"]["status"],
        notes: Array.isArray(rawSupportNotes) ? Object.freeze([...(rawSupportNotes as readonly string[])]) : (rawSupportNotes as readonly string[]),
      });
      const frozenProviderOptions =
        rawProviderOptions === undefined
          ? undefined
          : isRecord(rawProviderOptions)
            ? freezeProviderOptionsSpec(rawProviderOptions as unknown as NonNullable<SmsAdapter["providerOptions"]>)
            : (rawProviderOptions as NonNullable<SmsAdapter["providerOptions"]>);
      const caps = frozenCaps as unknown as Record<string, unknown>;
      const validity = caps["validityPeriod"] as Record<string, unknown> | null;
      if (
        typeof adapterName !== "string" ||
        adapterName.length === 0 ||
        typeof rawSend !== "function" ||
        caps["sendText"] !== true ||
        typeof caps["mms"] !== "boolean" ||
        typeof caps["scheduling"] !== "boolean" ||
        typeof caps["webhookUrlOverride"] !== "boolean" ||
        typeof caps["inbound"] !== "boolean" ||
        typeof caps["deliveryReceipts"] !== "boolean" ||
        typeof caps["nativeIdempotency"] !== "boolean" ||
        !Array.isArray(caps["senderTypes"]) ||
        !caps["senderTypes"].every((t) => typeof t === "string" && VALID_SENDER_TYPES.has(t)) ||
        (validity !== null &&
          (!isRecord(validity) ||
            typeof validity["minSec"] !== "number" ||
            !Number.isInteger(validity["minSec"]) ||
            validity["minSec"] <= 0 ||
            typeof validity["maxSec"] !== "number" ||
            !Number.isInteger(validity["maxSec"]) ||
            validity["maxSec"] < validity["minSec"])) ||
        (frozenSupport.status !== "supported" && frozenSupport.status !== "partial") ||
        !Array.isArray(frozenSupport.notes) ||
        !frozenSupport.notes.every((n) => typeof n === "string") ||
        (frozenProviderOptions !== undefined && !isValidProviderOptionsSpec(frozenProviderOptions)) ||
        (rawValidate !== undefined && typeof rawValidate !== "function") ||
        (rawGetMessage !== undefined && typeof rawGetMessage !== "function")
      ) {
        throw new ConfigurationError("Each adapter must be an object with a non-empty name, capabilities, support, and send().");
      }
      const frozenDefaultFrom = freezeSender(rawDefaultFrom as SmsAdapter["defaultFrom"]);
      const sendFn = (rawSend as SmsAdapter["send"]).bind(rawAdapter);
      const validateFn =
        rawValidate === undefined ? undefined : (rawValidate as NonNullable<SmsAdapter["validate"]>).bind(rawAdapter);
      const getMessageFn =
        rawGetMessage === undefined ? undefined : (rawGetMessage as NonNullable<SmsAdapter["getMessage"]>).bind(rawAdapter);
      validatedAdapters.push(
        Object.freeze({
          name: adapterName,
          capabilities: frozenCaps,
          support: frozenSupport,
          ...(frozenProviderOptions === undefined ? {} : { providerOptions: frozenProviderOptions }),
          ...(frozenDefaultFrom === undefined ? {} : { defaultFrom: frozenDefaultFrom }),
          send: sendFn,
          ...(validateFn === undefined ? {} : { validate: validateFn }),
          ...(getMessageFn === undefined ? {} : { getMessage: getMessageFn }),
        }),
      );
    } catch (error) {
      if (error instanceof ConfigurationError) {
        throw error;
      }
      throw new ConfigurationError("Each adapter must be an object with a non-empty name, capabilities, support, and send().");
    }
  }
  const adapters = validatedAdapters as [SmsAdapter, ...SmsAdapter[]];
  if (beforeSend !== undefined && typeof beforeSend !== "function") {
    throw new ConfigurationError("beforeSend must be a function.");
  }
  const names = adapters.map((adapter) => adapter.name);
  if (new Set(names).size !== names.length) {
    throw new ConfigurationError(`Adapter names must be unique; got ${names.join(", ")}.`);
  }
  const timeoutMs = rawTimeoutMs === undefined ? DEFAULT_TIMEOUT_MS : rawTimeoutMs;
  if (!(typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647)) {
    throw new ConfigurationError("timeoutMs must be a positive number up to 2147483647.");
  }

  let retry: ReturnType<typeof resolveRetryOptions>;
  try {
    retry = resolveRetryOptions(rawRetry);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("retry options must be an object.");
  }
  if (rawFallback !== undefined && rawFallback !== "none" && rawFallback !== "on-known-rejection") {
    throw new ConfigurationError('fallback must be "none" or "on-known-rejection".');
  }
  const fallback = rawFallback === "on-known-rejection";
  const hooks: {
    onAttempt?: NonNullable<SmsClientOptions["hooks"]>["onAttempt"];
    onAccepted?: NonNullable<SmsClientOptions["hooks"]>["onAccepted"];
    onFailure?: NonNullable<SmsClientOptions["hooks"]>["onFailure"];
  } = {};
  if (rawHooks !== undefined) {
    if (!isRecord(rawHooks)) {
      throw new ConfigurationError("hooks must be an object of callback functions.");
    }
    try {
      for (const hookName of ["onAttempt", "onAccepted", "onFailure"] as const) {
        if (hookName in rawHooks) {
          const hookFn = rawHooks[hookName];
          if (hookFn !== undefined) {
            if (typeof hookFn !== "function") {
              throw new ConfigurationError(`hooks.${hookName} must be a function.`);
            }
            hooks[hookName] = hookFn.bind(rawHooks) as never;
          }
        }
      }
    } catch (error) {
      if (error instanceof ConfigurationError) {
        throw error;
      }
      throw new ConfigurationError("hooks must be an object of callback functions.");
    }
  }
  let idempotency: IdempotencyConfig | undefined;
  if (rawIdempotency !== undefined) {
    try {
      if (!isRecord(rawIdempotency)) {
        throw new ConfigurationError("idempotency must be an object with a valid store.");
      }
      const store = rawIdempotency["store"];
      if (!isRecord(store)) {
        throw new ConfigurationError("idempotency must be an object with a valid store.");
      }
      const storeGet = store["get"];
      const storeReserve = store["reserve"];
      const storeFinalize = store["finalize"];
      if (
        typeof storeGet !== "function" ||
        typeof storeReserve !== "function" ||
        typeof storeFinalize !== "function"
      ) {
        throw new ConfigurationError("idempotency must be an object with a valid store.");
      }
      const rawTtl = rawIdempotency["ttlSec"];
      const rawStale = rawIdempotency["staleReservationSec"];
      idempotency = {
        store: Object.freeze({
          get: (storeGet as IdempotencyStore["get"]).bind(store),
          reserve: (storeReserve as IdempotencyStore["reserve"]).bind(store),
          finalize: (storeFinalize as IdempotencyStore["finalize"]).bind(store),
        }),
        ttlSec: requirePositiveSeconds((rawTtl === undefined ? DEFAULT_TTL_SEC : rawTtl) as number, "ttlSec"),
        staleReservationSec: requirePositiveSeconds(
          (rawStale === undefined ? DEFAULT_STALE_RESERVATION_SEC : rawStale) as number,
          "staleReservationSec",
        ),
      };
    } catch (error) {
      if (error instanceof ConfigurationError) {
        throw error;
      }
      throw new ConfigurationError("idempotency must be an object with a valid store.");
    }
  }
  const inFlight = new Map<string, InFlight>();
  const configuredAdapters = new Set(adapters.map((adapter) => adapter.name));

  const validate = (rawInput: SmsSendInput): SmsValidationResult => {
    let input: SmsSendInput;
    try {
      if (!isRecord(rawInput)) {
        return {
          ...estimateSegments(""),
          supported: false,
          issues: [MESSAGE_NOT_OBJECT_ISSUE],
          adapterCandidates: [],
          providerOptionsFor: [],
        };
      }
      input = snapshotSendInput(rawInput, names);
    } catch {
      return {
        ...estimateSegments(""),
        supported: false,
        issues: [MESSAGE_NOT_OBJECT_ISSUE],
        adapterCandidates: [],
        providerOptionsFor: [],
      };
    }
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
    let signal: AbortSignal | undefined;
    try {
      if (!isRecord(sendOptions)) {
        throw new ConfigurationError("send options must be an object.");
      }
      signal = requireOptionalSignal(sendOptions.signal, "send");
    } catch (error) {
      if (error instanceof ConfigurationError) {
        throw error;
      }
      throw new ConfigurationError("send options must be an object.");
    }
    let input: SmsSendInput;
    try {
      if (!isRecord(rawInput)) {
        throw issueToError(MESSAGE_NOT_OBJECT_ISSUE);
      }
      input = snapshotSendInput(rawInput, names);
    } catch (error) {
      if (error instanceof InvalidMessageError) {
        throw error;
      }
      throw issueToError(MESSAGE_NOT_OBJECT_ISSUE);
    }
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
      return cloneSendResult(result, true);
    }

    const promise = sendWithKey({ input, candidates, preview, signal, key, fingerprint });
    inFlight.set(key, { fingerprint, promise });
    try {
      const result = await promise;
      return cloneSendResult(result, result.replayed);
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
    let rawReserved: unknown;
    try {
      rawReserved = await idempotency.store.reserve({ key: args.key, fingerprint: args.fingerprint, now });
    } catch (error) {
      if (error instanceof SmsError) {
        throw error;
      }
      throw new ConfigurationError(
        "idempotency.store.reserve() could not complete. Nothing was sent by this call.",
        { cause: error },
      );
    }
    const reserved = snapshotReserveResult(rawReserved);
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
          { reason: "replayed_unknown", attempts: record.attempts },
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
      emitHook(hooks.onFailure, {
        ...base,
        errorCode: error.code,
        retrySafe: error.retrySafe,
        attempts: error.attempts.map((attempt) => ({ ...attempt })),
      });
      throw error;
    };

    if (beforeSend !== undefined) {
      let rawDecision: unknown;
      try {
        const policyMessage: SmsSendInput =
          input.sendAt instanceof Date
            ? Object.freeze({ ...input, sendAt: new Date(input.sendAt.getTime()) })
            : input;
        rawDecision = beforeSend({
          id,
          message: policyMessage,
          encoding: preview.encoding,
          segments: preview.segments,
        });
      } catch (cause) {
        const policyError = new PolicyRejectedError("beforeSend threw");
        await finalize({ state: "rejected", fingerprint: reservation?.fingerprint ?? "", error: policyError.toJSON() });
        // The caller gets the original exception; hooks see it as a policy failure.
        emitHook(hooks.onFailure, { ...base, errorCode: policyError.code, retrySafe: policyError.retrySafe, attempts: [] });
        throw cause;
      }
      let isRealPromise = false;
      try {
        isRealPromise = rawDecision instanceof Promise;
      } catch {
        return fail(new PolicyRejectedError("beforeSend returned an unreadable decision."));
      }
      let decision: unknown;
      if (isRealPromise) {
        try {
          decision = await rawDecision;
        } catch (cause) {
          const policyError = new PolicyRejectedError("beforeSend threw");
          await finalize({ state: "rejected", fingerprint: reservation?.fingerprint ?? "", error: policyError.toJSON() });
          emitHook(hooks.onFailure, { ...base, errorCode: policyError.code, retrySafe: policyError.retrySafe, attempts: [] });
          throw cause;
        }
      } else {
        try {
          decision = await rawDecision;
        } catch {
          return fail(new PolicyRejectedError("beforeSend returned an unreadable decision."));
        }
      }
      let isObj = false;
      let kind: unknown;
      let reason: unknown;
      try {
        if (isRecord(decision)) {
          isObj = true;
          kind = decision["kind"];
          if (kind === "reject") {
            reason = decision["reason"];
          }
        }
      } catch {
        return fail(new PolicyRejectedError("beforeSend returned an unreadable decision."));
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
          emitHook(hooks.onAttempt, { ...base, attempt: { ...attempt } });
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
    await finalize({
      state: "accepted",
      fingerprint: reservation?.fingerprint ?? "",
      result: cloneSendResult(result, false),
    });
    emitHook(hooks.onAccepted, {
      ...base,
      provider: result.provider,
      providerId: result.providerId,
      attempts: result.attempts.map((attempt) => ({ ...attempt })),
    });
    return cloneSendResult(result, false);
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
    let signal: AbortSignal | undefined;
    let rawAdapter: unknown;
    try {
      if (!isRecord(lookupOptions)) {
        throw new ConfigurationError("getMessage options must be an object.");
      }
      signal = requireOptionalSignal(lookupOptions.signal, "getMessage");
      rawAdapter = lookupOptions.adapter;
    } catch (error) {
      if (error instanceof ConfigurationError) {
        throw error;
      }
      throw new ConfigurationError("getMessage options must be an object.");
    }
    if (rawAdapter !== undefined && typeof rawAdapter !== "string") {
      throw new ConfigurationError("getMessage adapter must be a string.");
    }
    const name = rawAdapter === undefined ? adapters[0]!.name : rawAdapter;
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
      return Object.freeze(
        adapters.map((adapter) =>
          Object.freeze({
            name: adapter.name,
            capabilities: freezeCapabilities(adapter.capabilities),
            support: Object.freeze({
              ...adapter.support,
              notes: Object.freeze([...adapter.support.notes]),
            }),
            defaultFrom: freezeSender(adapter.defaultFrom),
            messageLookup: adapter.getMessage !== undefined,
          }),
        ),
      );
    },
  };
}

type ReserveSnapshot =
  | { readonly kind: "reserved"; readonly reservationId: string }
  | {
      readonly kind: "existing";
      readonly record:
        | { readonly state: "accepted"; readonly fingerprint: string; readonly result: SmsSendResult }
        | { readonly state: "unknown"; readonly fingerprint: string; readonly attempts: readonly SendAttempt[] }
        | { readonly state: "reserved"; readonly fingerprint: string; readonly reservedAt: number }
        | { readonly state: "rejected"; readonly fingerprint: string };
    };

const ENCODINGS: ReadonlySet<unknown> = new Set(["gsm7", "ucs2"]);

/** Reads a store's reserve() result once inside try/catch; anything off-contract throws ConfigurationError. */
function snapshotReserveResult(raw: unknown): ReserveSnapshot {
  const malformed = (detail: string): ConfigurationError =>
    new ConfigurationError(`idempotency.store.reserve() returned a malformed result: ${detail}.`);
  try {
    if (!isRecord(raw)) {
      throw malformed("not an object");
    }
    const kind = raw["kind"];
    if (kind === "reserved") {
      const reservationId = raw["reservationId"];
      if (typeof reservationId !== "string" || reservationId.length === 0) {
        throw malformed("reserved without a reservationId");
      }
      return { kind, reservationId };
    }
    if (kind !== "existing") {
      throw malformed("unrecognized kind");
    }
    const record = raw["record"];
    if (!isRecord(record)) {
      throw malformed("existing without a record");
    }
    const fingerprint = record["fingerprint"];
    const state = record["state"];
    if (typeof fingerprint !== "string") {
      throw malformed("record without a fingerprint");
    }
    switch (state) {
      case "accepted": {
        const r = record["result"];
        if (!isRecord(r)) {
          throw malformed("accepted record without a result");
        }
        const id = r["id"];
        const provider = r["provider"];
        const providerId = r["providerId"];
        const handoff = r["handoff"];
        const delivery = r["delivery"];
        const encoding = r["encoding"];
        const segments = r["segments"];
        const rawAttemptedProviders = r["attemptedProviders"];
        const attemptedProviders = Array.isArray(rawAttemptedProviders)
          ? Array.from(rawAttemptedProviders)
          : undefined;
        const attempts = r["attempts"];
        const replayed = r["replayed"];
        if (
          typeof id !== "string" ||
          id.length === 0 ||
          typeof provider !== "string" ||
          provider.length === 0 ||
          typeof providerId !== "string" ||
          providerId.length === 0 ||
          handoff !== "accepted" ||
          !DELIVERIES.has(delivery) ||
          !ENCODINGS.has(encoding) ||
          typeof segments !== "number" ||
          !Number.isSafeInteger(segments) ||
          segments < 0 ||
          attemptedProviders === undefined ||
          !attemptedProviders.every((name) => typeof name === "string" && name.length > 0) ||
          !Array.isArray(attempts) ||
          typeof replayed !== "boolean"
        ) {
          throw malformed("accepted record without a valid result");
        }
        return {
          kind,
          record: {
            state,
            fingerprint,
            result: {
              id,
              provider,
              providerId,
              handoff,
              delivery: delivery as SmsSendResult["delivery"],
              encoding: encoding as SmsSendResult["encoding"],
              segments,
              attemptedProviders: Object.freeze(attemptedProviders as string[]),
              attempts: snapshotStoredAttempts(attempts),
              replayed: true,
            },
          },
        };
      }
      case "unknown": {
        const error = record["error"];
        const attempts = isRecord(error) ? error["attempts"] : undefined;
        return {
          kind,
          record: {
            state,
            fingerprint,
            attempts: Array.isArray(attempts) ? snapshotStoredAttempts(attempts) : [],
          },
        };
      }
      case "reserved": {
        const reservedAt = record["reservedAt"];
        if (typeof reservedAt !== "number" || !Number.isFinite(reservedAt)) {
          throw malformed("reserved record without a finite reservedAt");
        }
        return { kind, record: { state, fingerprint, reservedAt } };
      }
      case "rejected":
        return { kind, record: { state, fingerprint } };
      default:
        throw malformed("record with an unrecognized state");
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw malformed("unreadable");
  }
}

function cloneSendResult(result: SmsSendResult, replayed: boolean): SmsSendResult {
  return {
    ...result,
    attemptedProviders: [...result.attemptedProviders],
    attempts: result.attempts.map((attempt) => ({ ...attempt })),
    replayed,
  };
}

const STORED_REJECTION_CATEGORIES: ReadonlySet<unknown> = new Set([
  "auth",
  "rate_limited",
  "sender",
  "account",
  "recipient",
  "compliance",
  "request",
]);

/** Copies and validates persisted attempt entries at the store boundary. */
function snapshotStoredAttempts(raw: unknown[]): readonly SendAttempt[] {
  const invalid = (): never => {
    throw new ConfigurationError("idempotency store returned malformed attempts.");
  };
  return Object.freeze(
    Array.from(raw, (entry: unknown): SendAttempt => {
      if (!isRecord(entry)) return invalid();
      const provider = entry["provider"];
      const attempt = entry["attempt"];
      const outcome = entry["outcome"];
      const durationMs = entry["durationMs"];
      if (
        typeof provider !== "string" ||
        provider.length === 0 ||
        typeof attempt !== "number" ||
        !Number.isSafeInteger(attempt) ||
        attempt < 1 ||
        typeof durationMs !== "number" ||
        !Number.isFinite(durationMs) ||
        durationMs < 0
      ) {
        return invalid();
      }
      const base = { provider, attempt, durationMs };
      if (outcome === "accepted") {
        const providerId = entry["providerId"];
        const delivery = entry["delivery"];
        if (typeof providerId !== "string" || providerId.length === 0 || !DELIVERIES.has(delivery)) {
          return invalid();
        }
        return Object.freeze({
          ...base,
          outcome,
          providerId,
          delivery: delivery as SmsSendResult["delivery"],
        });
      }
      const details = sanitizeProviderDetails(
        { httpStatus: entry["httpStatus"], code: entry["providerCode"] },
        provider,
      );
      const http = details.httpStatus === undefined ? {} : { httpStatus: details.httpStatus };
      if (outcome === "unknown") {
        const reason = entry["reason"];
        if (!UNKNOWN_REASONS.has(reason)) return invalid();
        return Object.freeze({
          ...base,
          outcome,
          ...http,
          reason: reason as Extract<SendAttempt, { outcome: "unknown" }>["reason"],
        });
      }
      if (outcome === "rejected") {
        const category = entry["category"];
        const retryAfterMs = entry["retryAfterMs"];
        if (
          !STORED_REJECTION_CATEGORIES.has(category) ||
          (retryAfterMs !== undefined &&
            (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 0))
        ) {
          return invalid();
        }
        return Object.freeze({
          ...base,
          outcome,
          ...http,
          category: category as Extract<SendAttempt, { outcome: "rejected" }>["category"],
          ...(details.code === undefined ? {} : { providerCode: details.code }),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
      }
      return invalid();
    }),
  );
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
