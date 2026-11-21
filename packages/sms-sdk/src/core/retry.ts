import { ConfigurationError } from "./errors.js";
import { isRecord } from "./http.js";
import type { RetryOptions } from "./types.js";

/** Highest accepted `retry.maxAttempts`. Retries only follow proven rate limits, so more is never useful. */
export const MAX_RETRY_ATTEMPTS = 10;

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

/**
 * Applies defaults and checks bounds. A `maxDelayMs` below `baseDelayMs` is
 * raised to `baseDelayMs`.
 *
 * @throws {ConfigurationError} when `maxAttempts` is not an integer from 1 to
 * {@link MAX_RETRY_ATTEMPTS}, or a delay is not a finite number of at least 0.
 */
export function resolveRetryOptions(options: RetryOptions | undefined): ResolvedRetryOptions {
  if (options !== undefined && !isRecord(options)) {
    throw new ConfigurationError("retry must be an object.");
  }
  const maxAttempts = options?.maxAttempts === undefined ? DEFAULT_RETRY.maxAttempts : options.maxAttempts;
  if (!(Number.isInteger(maxAttempts) && maxAttempts >= 1 && maxAttempts <= MAX_RETRY_ATTEMPTS)) {
    throw new ConfigurationError(`retry.maxAttempts must be an integer from 1 to ${MAX_RETRY_ATTEMPTS}.`);
  }
  const baseDelayMs = requireDelay(
    options?.baseDelayMs === undefined ? DEFAULT_RETRY.baseDelayMs : options.baseDelayMs,
    "baseDelayMs",
  );
  const maxDelayMs = Math.max(
    baseDelayMs,
    requireDelay(options?.maxDelayMs === undefined ? DEFAULT_RETRY.maxDelayMs : options.maxDelayMs, "maxDelayMs"),
  );
  return { maxAttempts, baseDelayMs, maxDelayMs };
}

function requireDelay(value: number, name: "baseDelayMs" | "maxDelayMs"): number {
  if (!(typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    throw new ConfigurationError(`retry.${name} must be a finite number of milliseconds, 0 or more.`);
  }
  return value;
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
