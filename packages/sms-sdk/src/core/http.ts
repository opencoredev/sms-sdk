import type { AdapterSendOutcome, ProviderErrorInfo } from "./adapters.js";
import { redactText } from "./redact.js";

/** A `fetch`-compatible function. Adapters accept one for testing and custom runtimes. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Outcome of one HTTP exchange. `failed` means no complete response was read. */
export type HttpExchange =
  | { readonly kind: "response"; readonly status: number; readonly headers: Headers; readonly text: string }
  | { readonly kind: "failed"; readonly cause: unknown };

/**
 * Performs one request and reads the whole body. Never throws: a network
 * error, abort, or body read failure becomes `failed`, which adapters must
 * treat as an unknown outcome.
 */
export async function exchange(
  fetcher: FetchLike,
  url: string,
  init: { readonly method: "POST"; readonly headers: Record<string, string>; readonly body: string; readonly signal: AbortSignal },
): Promise<HttpExchange> {
  try {
    const response = await fetcher(url, init);
    const text = await response.text();
    return { kind: "response", status: response.status, headers: response.headers, text };
  } catch (cause) {
    return { kind: "failed", cause };
  }
}

/** Parses JSON, returning `undefined` instead of throwing. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Narrows to a plain object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads a non-empty string property. */
export function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads a string or finite number property as a string. */
export function readCode(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parses a `Retry-After` header (delta-seconds or HTTP date) into
 * milliseconds. Returns `undefined` when absent or invalid.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** `Basic` authorization header value for ASCII credentials. */
export function basicAuthorization(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

/** Builds redacted {@link ProviderErrorInfo}. */
export function providerInfo(input: {
  readonly provider: string;
  readonly httpStatus?: number;
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly requestId?: string | null | undefined;
}): ProviderErrorInfo {
  return {
    provider: input.provider,
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.message === undefined ? {} : { message: redactText(input.message) }),
    ...(input.requestId === undefined || input.requestId === null ? {} : { requestId: input.requestId }),
  };
}

/**
 * Outcome for a response that is neither a documented success nor a
 * documented rejection: 5xx and anything outside 2xx/4xx is unknown.
 */
export function unknownForStatus(provider: string, status: number, requestId?: string | null): AdapterSendOutcome {
  return {
    kind: "unknown",
    reason: status >= 500 ? "server_error" : "unexpected_status",
    details: providerInfo({ provider, httpStatus: status, requestId }),
  };
}
