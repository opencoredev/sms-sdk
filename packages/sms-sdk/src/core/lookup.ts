import type { Delivery, LookupFailureReason, MessageLookupOutcome, SmsAdapter } from "./adapters.js";
import { DELIVERIES, UNKNOWN_REASONS } from "./fallback.js";
import { sanitizeProviderDetails } from "./http.js";

/**
 * Runs one {@link SmsAdapter.getMessage} request with a per-request timeout
 * linked to the caller's signal. Never throws: an adapter exception becomes
 * `failed` with reason `adapter_exception`.
 */
export async function lookupOnce(input: {
  readonly adapter: SmsAdapter;
  readonly providerId: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
}): Promise<MessageLookupOutcome> {
  const getMessage = input.adapter.getMessage;
  if (getMessage === undefined) {
    return { kind: "failed", reason: "adapter_exception", cause: new TypeError(`${input.adapter.name} has no getMessage.`) };
  }
  if (input.signal?.aborted === true) {
    return { kind: "failed", reason: "aborted", cause: input.signal.reason };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("SMS provider lookup timed out.", "TimeoutError"));
  }, input.timeoutMs);
  const onCallerAbort = (): void => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });

  let outcome: MessageLookupOutcome;
  try {
    outcome = await getMessage.call(input.adapter, input.providerId, { signal: controller.signal });
  } catch (cause) {
    outcome = { kind: "failed", reason: "adapter_exception", cause };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }

  outcome = normalizeLookupOutcome(outcome, input.adapter.name);
  if (outcome.kind === "failed" && controller.signal.aborted) {
    return { ...outcome, reason: timedOut ? "timeout" : "aborted" };
  }
  return outcome;
}

const LOOKUP_REASONS: ReadonlySet<unknown> = new Set([...UNKNOWN_REASONS, "auth", "rate_limited", "request"]);

const malformedLookupOutcome = (adapterName: string): MessageLookupOutcome => ({
  kind: "failed",
  reason: "adapter_exception",
  cause: new TypeError(`${adapterName} getMessage returned a malformed lookup outcome.`),
});

/** Copies a lookup outcome field by field (each read once); anything off-contract becomes `failed`/`adapter_exception`. */
function normalizeLookupOutcome(outcome: unknown, adapterName: string): MessageLookupOutcome {
  try {
    if (typeof outcome !== "object" || outcome === null || Array.isArray(outcome)) {
      return malformedLookupOutcome(adapterName);
    }
    const record = outcome as Record<string, unknown>;
    const kind = record["kind"];
    if (kind === "not_found") {
      return { kind: "not_found" };
    }
    if (kind === "failed") {
      const reason = record["reason"];
      const rawDetails = record["details"];
      if (!LOOKUP_REASONS.has(reason)) {
        return malformedLookupOutcome(adapterName);
      }
      if (rawDetails !== undefined && (typeof rawDetails !== "object" || rawDetails === null || Array.isArray(rawDetails))) {
        return malformedLookupOutcome(adapterName);
      }
      const details =
        rawDetails === undefined ? undefined : sanitizeProviderDetails(rawDetails as Record<string, unknown>, adapterName);
      return {
        kind: "failed",
        reason: reason as LookupFailureReason,
        ...(details === undefined ? {} : { details }),
        ...("cause" in record ? { cause: record["cause"] } : {}),
      };
    }
    if (kind === "found") {
      const status = record["status"];
      if (typeof status !== "object" || status === null || Array.isArray(status)) {
        return malformedLookupOutcome(adapterName);
      }
      const s = status as Record<string, unknown>;
      const provider = s["provider"];
      const providerId = s["providerId"];
      const delivery = s["delivery"];
      const providerStatus = s["providerStatus"];
      const errorCode = s["errorCode"];
      if (typeof providerId !== "string" || providerId.length === 0 || !DELIVERIES.has(delivery)) {
        return malformedLookupOutcome(adapterName);
      }
      return {
        kind: "found",
        status: {
          provider: typeof provider === "string" && provider.length > 0 ? provider : adapterName,
          providerId,
          delivery: delivery as Delivery,
          ...(typeof providerStatus === "string" ? { providerStatus } : {}),
          ...(typeof errorCode === "string" && (delivery === "undelivered" || delivery === "filtered")
            ? { errorCode }
            : {}),
        },
      };
    }
    return malformedLookupOutcome(adapterName);
  } catch (cause) {
    return { kind: "failed", reason: "adapter_exception", cause };
  }
}
