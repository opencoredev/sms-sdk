import type { RetryOptions } from "./types.js";

/** {@link RetryOptions} with defaults applied. */
export type ResolvedRetryOptions = {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
};

/** Default retry policy: two requests per adapter, 500 ms base, 10 s cap. */
export const DEFAULT_RETRY: ResolvedRetryOptions = {
  maxAttempts: 2,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
};

/** Applies defaults and clamps values to sane bounds. */
export function resolveRetryOptions(options: RetryOptions | undefined): ResolvedRetryOptions {
  const maxAttempts = Math.max(1, Math.floor(options?.maxAttempts ?? DEFAULT_RETRY.maxAttempts));
  const baseDelayMs = Math.max(0, options?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs);
  const maxDelayMs = Math.max(baseDelayMs, options?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs);
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

/** What to do after a rate-limited rejection. */
export type RetryDecision = { readonly kind: "wait"; readonly delayMs: number } | { readonly kind: "stop" };

/**
 * Decides whether to retry a proven rate-limit rejection.
 *
 * A provider `Retry-After` is honored when it fits within `maxDelayMs`;
 * a longer one stops retrying. Without `Retry-After`, the delay is
 * exponential backoff with full jitter: `random() * min(maxDelayMs, baseDelayMs * 2^(attempt-1))`.
 */
export function decideRetry(input: {
  readonly attempt: number;
  readonly retryAfterMs: number | undefined;
  readonly options: ResolvedRetryOptions;
  readonly random?: () => number;
}): RetryDecision {
  if (input.attempt >= input.options.maxAttempts) {
    return { kind: "stop" };
  }
  if (input.retryAfterMs !== undefined) {
    return input.retryAfterMs <= input.options.maxDelayMs
      ? { kind: "wait", delayMs: input.retryAfterMs }
      : { kind: "stop" };
  }
  const ceiling = Math.min(input.options.maxDelayMs, input.options.baseDelayMs * 2 ** (input.attempt - 1));
  const random = input.random ?? Math.random;
  return { kind: "wait", delayMs: Math.floor(random() * ceiling) };
}

/** Resolves after `ms`, or returns `"aborted"` as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<"slept" | "aborted"> {
  if (signal?.aborted === true) {
    return Promise.resolve("aborted");
  }
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("slept");
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
