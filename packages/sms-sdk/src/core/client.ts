import type { SmsAdapter, ValidationIssue } from "./adapters.js";
import { checkAdapter, issueToError, validateMessage } from "./capabilities.js";
import { maskPhoneNumber } from "./e164.js";
import { estimateSegments, type SegmentPreview } from "./encoding.js";
import {
  ConfigurationError,
  HandoffUnknownError,
  IdempotencyConflictError,
  IdempotencyInProgressError,
  PolicyRejectedError,
  SendAbortedError,
  SmsError,
} from "./errors.js";
import { emitHook, type SmsHookEventBase } from "./events.js";
import { runSendChain, type ChainResult, type SendCandidate } from "./fallback.js";
import { adaptersWithProviderOptions, validateProviderOptions } from "./provider-options.js";
import { fingerprintMessage, type FinalIdempotencyRecord, type IdempotencyStore } from "./idempotency.js";
import { resolveRetryOptions } from "./retry.js";
import type {
  SmsAdapterInfo,
  SmsClient,
  SmsClientOptions,
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

/**
 * Creates an SMS client over one or more adapters.
 *
 * @throws {ConfigurationError} when no adapters are given, names repeat, or numeric options are invalid.
 */
export function createSmsClient(options: SmsClientOptions): SmsClient {
  const adapters = options.adapters;
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new ConfigurationError("createSmsClient needs at least one adapter.");
  }
  const names = adapters.map((adapter) => adapter.name);
  if (new Set(names).size !== names.length) {
    throw new ConfigurationError(`Adapter names must be unique; got ${names.join(", ")}.`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new ConfigurationError("timeoutMs must be a positive number.");
  }

  const retry = resolveRetryOptions(options.retry);
  const fallback = options.fallback === "on-known-rejection";
  const hooks = options.hooks ?? {};
  const idempotency: IdempotencyConfig | undefined =
    options.idempotency === undefined
      ? undefined
      : {
          store: options.idempotency.store,
          ttlSec: options.idempotency.ttlSec ?? DEFAULT_TTL_SEC,
          staleReservationSec: options.idempotency.staleReservationSec ?? DEFAULT_STALE_RESERVATION_SEC,
        };
  const inFlight = new Map<string, InFlight>();

  const validate = (input: SmsSendInput): SmsValidationResult => {
    const preview = estimateSegments(typeof input.body === "string" ? input.body : "");
    const messageIssues = [...validateMessage(input), ...validateProviderOptions(adapters, input.providerOptions)];
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

  const send = async (input: SmsSendInput, sendOptions: SmsSendOptions = {}): Promise<SmsSendResult> => {
    const preview = estimateSegments(typeof input.body === "string" ? input.body : "");
    const candidates = buildCandidates(input);
    const signal = sendOptions.signal;
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
      providerOptions: input.providerOptions,
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
    const [firstIssue] = [...validateMessage(input), ...validateProviderOptions(adapters, input.providerOptions)];
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
      let decision;
      try {
        decision = await options.beforeSend({ id, message: input, encoding: preview.encoding, segments: preview.segments });
      } catch (cause) {
        await finalize({
          state: "rejected",
          fingerprint: reservation?.fingerprint ?? "",
          error: new PolicyRejectedError("beforeSend threw").toJSON(),
        });
        throw cause;
      }
      if (decision.kind === "reject") {
        return fail(new PolicyRejectedError(decision.reason));
      }
    }

    let chain: ChainResult;
    try {
      chain = await runSendChain({
        candidates: args.candidates,
        fallback,
        retry,
        timeoutMs,
        signal: args.signal,
        idempotencyKey: input.idempotencyKey,
        onAttempt: (attempt) => emitHook(hooks.onAttempt, { ...base, attempt }),
      });
    } catch (cause) {
      return fail(
        new HandoffUnknownError("The send failed unexpectedly after it may have reached a provider.", {
          reason: "adapter_exception",
          attempts: [],
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

  return {
    send,
    validate,
    capabilities(): readonly SmsAdapterInfo[] {
      return adapters.map((adapter) => ({
        name: adapter.name,
        capabilities: adapter.capabilities,
        support: adapter.support,
        defaultFrom: adapter.defaultFrom,
      }));
    },
  };
}

function newId(): string {
  return `sms_${crypto.randomUUID().replaceAll("-", "")}`;
}
