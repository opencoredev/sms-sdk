import type { AdapterMessage, AdapterSendOutcome, Delivery, SmsAdapter } from "./adapters.js";
import {
  AllProvidersRejectedError,
  HandoffUnknownError,
  ProviderAuthError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  SendAbortedError,
  type SmsError,
} from "./errors.js";
import type { SendAttempt } from "./events.js";
import { decideRetry, sleep, type ResolvedRetryOptions } from "./retry.js";

/** An adapter paired with the message built for it. */
export type SendCandidate = { readonly adapter: SmsAdapter; readonly message: AdapterMessage };

/** Final result of a send chain. */
export type ChainResult =
  | {
      readonly kind: "accepted";
      readonly provider: string;
      readonly providerId: string;
      readonly delivery: Delivery;
      readonly attempts: readonly SendAttempt[];
    }
  | { readonly kind: "failed"; readonly error: SmsError; readonly attempts: readonly SendAttempt[] };

type ChainInput = {
  readonly candidates: readonly [SendCandidate, ...SendCandidate[]];
  readonly fallback: boolean;
  readonly retry: ResolvedRetryOptions;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly idempotencyKey: string | undefined;
  readonly onAttempt: (attempt: SendAttempt) => void;
};

type AdapterRun =
  | { readonly kind: "accepted"; readonly providerId: string; readonly delivery: Delivery }
  | { readonly kind: "rejected"; readonly error: ProviderRejectedError }
  | { readonly kind: "unknown"; readonly error: HandoffUnknownError }
  | { readonly kind: "aborted" };

/**
 * Sends through the candidates in order.
 *
 * Stops on the first accepted or unknown outcome. Moves to the next candidate
 * only when fallback is enabled and the rejection is fallback-eligible.
 */
export async function runSendChain(input: ChainInput): Promise<ChainResult> {
  const attempts: SendAttempt[] = [];
  const rejections: ProviderRejectedError[] = [];
  const record = (attempt: SendAttempt): void => {
    attempts.push(attempt);
    input.onAttempt(attempt);
  };

  for (const candidate of input.candidates) {
    const run = await runAdapter(candidate, input, record, attempts);

    switch (run.kind) {
      case "accepted":
        return {
          kind: "accepted",
          provider: candidate.adapter.name,
          providerId: run.providerId,
          delivery: run.delivery,
          attempts,
        };
      case "unknown":
        return { kind: "failed", error: run.error, attempts };
      case "aborted":
        return { kind: "failed", error: new SendAbortedError([...attempts]), attempts };
      case "rejected":
        rejections.push(run.error);
        if (!input.fallback || !run.error.fallbackEligible) {
          return { kind: "failed", error: summarizeRejections(rejections, attempts), attempts };
        }
        break;
      default: {
        const _exhaustive: never = run;
        return _exhaustive;
      }
    }
  }

  return { kind: "failed", error: summarizeRejections(rejections, attempts), attempts };
}

function summarizeRejections(rejections: readonly ProviderRejectedError[], attempts: readonly SendAttempt[]): SmsError {
  const [first, ...rest] = rejections;
  if (first !== undefined && rest.length === 0) {
    return first;
  }
  return new AllProvidersRejectedError(rejections, [...attempts]);
}

async function runAdapter(
  candidate: SendCandidate,
  input: ChainInput,
  record: (attempt: SendAttempt) => void,
  attempts: readonly SendAttempt[],
): Promise<AdapterRun> {
  const provider = candidate.adapter.name;

  for (let attempt = 1; ; attempt += 1) {
    if (input.signal?.aborted === true) {
      return { kind: "aborted" };
    }

    const started = Date.now();
    const outcome = await attemptOnce(candidate, input, attempt);
    const durationMs = Date.now() - started;

    switch (outcome.kind) {
      case "accepted":
        record({
          provider,
          attempt,
          outcome: "accepted",
          providerId: outcome.providerId,
          delivery: outcome.delivery,
          durationMs,
        });
        return { kind: "accepted", providerId: outcome.providerId, delivery: outcome.delivery };

      case "unknown": {
        record({
          provider,
          attempt,
          outcome: "unknown",
          reason: outcome.reason,
          ...(outcome.details?.httpStatus === undefined ? {} : { httpStatus: outcome.details.httpStatus }),
          durationMs,
        });
        const error = new HandoffUnknownError(unknownMessage(provider, outcome.reason), {
          reason: outcome.reason,
          providerName: provider,
          attempts: [...attempts],
          ...(outcome.details === undefined ? {} : { provider: outcome.details }),
          cause: outcome.cause,
        });
        return { kind: "unknown", error };
      }

      case "rejected": {
        record({
          provider,
          attempt,
          outcome: "rejected",
          category: outcome.category,
          ...(outcome.details.httpStatus === undefined ? {} : { httpStatus: outcome.details.httpStatus }),
          ...(outcome.details.code === undefined ? {} : { providerCode: outcome.details.code }),
          ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
          durationMs,
        });

        if (outcome.category === "rate_limited") {
          const decision = decideRetry({ attempt, retryAfterMs: outcome.retryAfterMs, options: input.retry });
          if (decision.kind === "wait") {
            if ((await sleep(decision.delayMs, input.signal)) === "aborted") {
              return { kind: "aborted" };
            }
            continue;
          }
        }
        return { kind: "rejected", error: rejectionError(outcome, [...attempts]) };
      }

      default: {
        const _exhaustive: never = outcome;
        return _exhaustive;
      }
    }
  }
}

/** Runs one adapter request with a per-request timeout linked to the caller's signal. */
async function attemptOnce(candidate: SendCandidate, input: ChainInput, attempt: number): Promise<AdapterSendOutcome> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("SMS provider request timed out.", "TimeoutError"));
  }, input.timeoutMs);
  const onCallerAbort = (): void => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });

  let outcome: AdapterSendOutcome;
  try {
    outcome = await candidate.adapter.send(candidate.message, {
      signal: controller.signal,
      attempt,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
  } catch (cause) {
    outcome = { kind: "unknown", reason: "adapter_exception", cause };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }

  if (outcome.kind === "unknown" && controller.signal.aborted) {
    return { ...outcome, reason: timedOut ? "timeout" : "aborted" };
  }
  return outcome;
}

function rejectionError(
  outcome: Extract<AdapterSendOutcome, { kind: "rejected" }>,
  attempts: readonly SendAttempt[],
): ProviderRejectedError {
  const provider = outcome.details.provider;
  const detail = outcome.details.message === undefined ? "" : `: ${outcome.details.message}`;

  if (outcome.category === "auth") {
    return new ProviderAuthError(`${provider} rejected the credentials${detail}`, { provider: outcome.details, attempts });
  }
  if (outcome.category === "rate_limited") {
    return new ProviderRateLimitedError(`${provider} rate-limited the request; the message was not created${detail}`, {
      provider: outcome.details,
      attempts,
      ...(outcome.retryAfterMs === undefined ? {} : { retryAfterMs: outcome.retryAfterMs }),
    });
  }
  return new ProviderRejectedError(`${provider} rejected the message (${outcome.category})${detail}`, {
    category: outcome.category,
    provider: outcome.details,
    attempts,
  });
}

function unknownMessage(provider: string, reason: string): string {
  return (
    `The outcome of the ${provider} request is unknown (${reason.replace("_", " ")}). ` +
    "The message may have been accepted. Do not resend automatically; reconcile with the provider first."
  );
}
