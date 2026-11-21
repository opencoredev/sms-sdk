import type { AdapterSendOutcome, Delivery, MessageLookupOutcome, ProviderErrorInfo } from "./adapters.js";
import { ConfigurationError, sanitizeDiagnosticToken, sanitizeProviderDetails } from "./errors.js";

export { sanitizeProviderDetails };

/** A `fetch`-compatible function. Adapters accept one for testing and custom runtimes. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Validates an adapter's optional `baseUrl`, defaulting when omitted. */
export function resolveBaseUrl(baseUrl: unknown, fallback: string, provider: string): string {
  if (baseUrl === undefined) {
    return fallback;
  }
  if (
    typeof baseUrl !== "string" ||
    baseUrl.length === 0 ||
    /[\p{Cc}\p{Cf}\p{Z}\s]/u.test(baseUrl) ||
    !/^https?:\/\/[^\\/?#]/i.test(baseUrl)
  ) {
    throw new ConfigurationError(`${provider} baseUrl must be a valid http or https URL.`);
  }
  if (baseUrl.includes("?") || baseUrl.includes("#")) {
    throw new ConfigurationError(`${provider} baseUrl must not include a query string or fragment.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ConfigurationError(`${provider} baseUrl must be a valid http or https URL.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigurationError(`${provider} baseUrl must use http or https.`);
  }
  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    /^https?:[\\/]*[^\\/?#]*@/i.test(baseUrl)
  ) {
    throw new ConfigurationError(`${provider} baseUrl must not include credentials.`);
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new ConfigurationError(`${provider} baseUrl must not include a query string or fragment.`);
  }
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
}

/** Validates an adapter's optional `fetch`, defaulting to the global `fetch`. */
export function resolveFetcher(fetcher: unknown, provider: string): FetchLike {
  if (fetcher === undefined) {
    return (input, init) => fetch(input, init);
  }
  if (typeof fetcher !== "function") {
    throw new ConfigurationError(`${provider} fetch must be a function.`);
  }
  return fetcher as FetchLike;
}

/** Largest provider response body read, in bytes. Provider JSON is a few kilobytes. */
export const MAX_RESPONSE_BYTES = 1_048_576;

/**
 * Outcome of one HTTP exchange. `failed` means no complete, readable response:
 * `reason` is `network` for a transport error or abort, and
 * `malformed_response` for a body over {@link MAX_RESPONSE_BYTES}.
 */
export type HttpExchange =
  | { readonly kind: "response"; readonly status: number; readonly headers: Headers; readonly text: string }
  | { readonly kind: "failed"; readonly reason: "network" | "malformed_response"; readonly cause: unknown };

/** A request {@link exchange} can send. */
export type HttpRequest = {
  readonly method: "GET" | "POST";
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal: AbortSignal;
};

/**
 * Performs one request and reads the body, up to {@link MAX_RESPONSE_BYTES}.
 * Never throws: a network error, abort, body read failure, or oversized body
 * becomes `failed`, which adapters must treat as an unknown outcome.
 */
export async function exchange(fetcher: FetchLike, url: string, init: HttpRequest): Promise<HttpExchange> {
  try {
    const response = await fetcher(url, init);
    const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    if (text === undefined) {
      return {
        kind: "failed",
        reason: "malformed_response",
        cause: new RangeError(`Provider response body exceeded ${MAX_RESPONSE_BYTES} bytes.`),
      };
    }
    return { kind: "response", status: response.status, headers: response.headers, text };
  } catch (cause) {
    return { kind: "failed", reason: "network", cause };
  }
}

const getTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)?.get;

const getDataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, "byteLength")?.get;

function intrinsicChunkByteLength(chunk: Uint8Array): number {
  if (chunk instanceof DataView && getDataViewByteLength !== undefined) {
    return Number(getDataViewByteLength.call(chunk));
  }
  if (getTypedArrayByteLength !== undefined) {
    return Number(getTypedArrayByteLength.call(chunk));
  }
  return chunk.byteLength;
}

/** Reads a response or request body as UTF-8, or returns `undefined` (and cancels the stream) once it passes `maxBytes`. */
export async function readBoundedText(
  source: { readonly headers: Headers; readonly body: ReadableStream<Uint8Array> | null },
  maxBytes: number,
): Promise<string | undefined> {
  const declared = Number(source.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      void Promise.resolve(source.body?.cancel?.()).catch(() => undefined);
    } catch {
      // Ignore cancel errors once the body is already rejected as oversized.
    }
    return undefined;
  }
  if (source.body === null) {
    return "";
  }
  const reader = source.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return text + decoder.decode();
    }
    total += intrinsicChunkByteLength(value);
    if (total > maxBytes) {
      try {
        void Promise.resolve(reader.cancel?.()).catch(() => undefined);
      } catch {
        // Ignore cancel errors once the body is already rejected as oversized.
      }
      return undefined;
    }
    text += decoder.decode(value, { stream: true });
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

/** Narrows to a non-null, non-array object (safe on revoked Proxies). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

/** True only for plain `{}` or `Object.create(null)` objects (safe on revoked Proxies). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  try {
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

const SENDER_KEYS = ["senderId", "shortCode", "messagingService"] as const;

/** Freezes an object sender by copying only recognized sender keys (preserving class getters). */
export function freezeSender<T>(value: T): T {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const copy: Record<string, unknown> = {};
  for (const key of SENDER_KEYS) {
    if (key in record) {
      Object.defineProperty(copy, key, {
        value: record[key],
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return Object.freeze(copy) as T;
}

/** Returns a deep-frozen copy of an adapter's capabilities object (preserving prototype getters). */
export function freezeCapabilities<
  T extends {
    readonly sendText: boolean;
    readonly mms: boolean;
    readonly scheduling: boolean;
    readonly validityPeriod: { readonly minSec: number; readonly maxSec: number } | null;
    readonly webhookUrlOverride: boolean;
    readonly inbound: boolean;
    readonly deliveryReceipts: boolean;
    readonly senderTypes: readonly unknown[];
    readonly nativeIdempotency: boolean;
  },
>(capabilities: T): T {
  const raw = capabilities as unknown as Record<string, unknown>;
  const validity = raw["validityPeriod"];
  const senderTypes = raw["senderTypes"];
  return Object.freeze({
    sendText: raw["sendText"],
    mms: raw["mms"],
    scheduling: raw["scheduling"],
    validityPeriod:
      validity === null
        ? null
        : isRecord(validity)
          ? Object.freeze({
              minSec: validity["minSec"],
              maxSec: validity["maxSec"],
            })
          : validity,
    webhookUrlOverride: raw["webhookUrlOverride"],
    inbound: raw["inbound"],
    deliveryReceipts: raw["deliveryReceipts"],
    senderTypes: Array.isArray(senderTypes) ? Object.freeze([...senderTypes]) : senderTypes,
    nativeIdempotency: raw["nativeIdempotency"],
  }) as unknown as T;
}

const regexpSourceGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, "source")?.get;
const regexpFlagsGetter = Object.getOwnPropertyDescriptor(RegExp.prototype, "flags")?.get;

function cloneRegExp(pattern: RegExp): RegExp {
  const source = regexpSourceGetter ? regexpSourceGetter.call(pattern) : pattern.source;
  const flags = regexpFlagsGetter ? regexpFlagsGetter.call(pattern) : pattern.flags;
  return new RegExp(source, flags);
}

const PROVIDER_OPTION_FIELD_KEYS = ["wire", "type", "maxLength", "pattern", "min", "max", "values"] as const;

function defineDataProp(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Returns a deep-frozen snapshot of a providerOptions spec (options, enum values, RegExp patterns, reserved, nestedPrefixes). */
export function freezeProviderOptionsSpec<const T>(spec: T): T {
  const raw = spec as unknown as Record<string, unknown>;
  const rawOptions = raw["options"];
  let frozenOptionsValue: unknown;
  if (isRecord(rawOptions)) {
    const frozenOptions: Record<string, unknown> = {};
    for (const key of Object.keys(rawOptions)) {
      const field = rawOptions[key];
      if (!isRecord(field)) {
        defineDataProp(frozenOptions, key, field);
        continue;
      }
      const fieldCopy: Record<string, unknown> = {};
      const fieldKeys = new Set([...Object.keys(field), ...PROVIDER_OPTION_FIELD_KEYS]);
      for (const prop of fieldKeys) {
        if (!(prop in field)) continue;
        const value = field[prop];
        if (prop === "values" && Array.isArray(value)) {
          defineDataProp(fieldCopy, prop, Object.freeze([...value]));
        } else if (prop === "pattern" && value instanceof RegExp) {
          defineDataProp(fieldCopy, prop, Object.freeze(cloneRegExp(value)));
        } else {
          defineDataProp(fieldCopy, prop, value);
        }
      }
      defineDataProp(frozenOptions, key, Object.freeze(fieldCopy));
    }
    frozenOptionsValue = Object.freeze(frozenOptions);
  } else {
    frozenOptionsValue = rawOptions;
  }
  const copy: Record<string, unknown> = {
    options: frozenOptionsValue,
  };
  const reserved = raw["reserved"];
  copy["reserved"] = Array.isArray(reserved) ? Object.freeze([...reserved]) : reserved;
  const nestedPrefixes = raw["nestedPrefixes"];
  if (nestedPrefixes !== undefined) {
    copy["nestedPrefixes"] = Array.isArray(nestedPrefixes) ? Object.freeze([...nestedPrefixes]) : nestedPrefixes;
  }
  return Object.freeze(copy) as unknown as T;
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

const MONTHS: Readonly<Record<string, number>> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11,
};

const IMF_FIXDATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const RFC850_DATE =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const ASCTIME_DATE =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{2}| \d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

function parseHttpDateParts(
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  const month = MONTHS[monthName];
  if (month === undefined || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return undefined;
  }
  const ms = Date.UTC(year, month, day, hour, minute, second);
  if (Number.isNaN(ms)) {
    return undefined;
  }
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return undefined;
  }
  return ms;
}

/**
 * Parses a `Retry-After` header (delta-seconds or RFC 9110 HTTP-date) into
 * milliseconds. Returns `undefined` when absent or invalid.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return Number.isFinite(ms) ? Math.min(ms, Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
  }

  let dateMs: number | undefined;
  const imf = IMF_FIXDATE.exec(trimmed);
  if (imf) {
    const [, dayStr, monthName, yearStr, hourStr, minStr, secStr] = imf;
    if (dayStr && monthName && yearStr && hourStr && minStr && secStr) {
      dateMs = parseHttpDateParts(
        Number(yearStr),
        monthName,
        Number(dayStr),
        Number(hourStr),
        Number(minStr),
        Number(secStr),
      );
    }
  } else {
    const rfc850 = RFC850_DATE.exec(trimmed);
    if (rfc850) {
      const [, dayStr, monthName, year2Str, hourStr, minStr, secStr] = rfc850;
      if (dayStr && monthName && year2Str && hourStr && minStr && secStr) {
        // RFC 9110 §5.6.7: interpret a two-digit year as the century closest to now,
        // moving timestamps more than 50 years in the future back by 100 years.
        const nowDate = new Date(now);
        const currentYear = nowDate.getUTCFullYear();
        const baseCentury = Math.floor(currentYear / 100) * 100;
        const day = Number(dayStr);
        const hour = Number(hourStr);
        const minute = Number(minStr);
        const second = Number(secStr);
        let year = baseCentury + Number(year2Str);
        const plus50 = Date.UTC(
          currentYear + 50,
          nowDate.getUTCMonth(),
          nowDate.getUTCDate(),
          nowDate.getUTCHours(),
          nowDate.getUTCMinutes(),
          nowDate.getUTCSeconds(),
          nowDate.getUTCMilliseconds(),
        );
        const minus50 = Date.UTC(
          currentYear - 50,
          nowDate.getUTCMonth(),
          nowDate.getUTCDate(),
          nowDate.getUTCHours(),
          nowDate.getUTCMinutes(),
          nowDate.getUTCSeconds(),
          nowDate.getUTCMilliseconds(),
        );
        let candidate = parseHttpDateParts(year, monthName, day, hour, minute, second);
        if (candidate !== undefined && candidate > plus50) {
          year -= 100;
          candidate = parseHttpDateParts(year, monthName, day, hour, minute, second);
        } else if (candidate !== undefined && candidate < minus50) {
          const nextCentury = parseHttpDateParts(year + 100, monthName, day, hour, minute, second);
          if (nextCentury !== undefined && nextCentury <= plus50) {
            candidate = nextCentury;
          }
        }
        dateMs = candidate;
      }
    } else {
      const asctime = ASCTIME_DATE.exec(trimmed);
      if (asctime) {
        const [, monthName, dayStr, hourStr, minStr, secStr, yearStr] = asctime;
        if (monthName && dayStr && hourStr && minStr && secStr && yearStr) {
          dateMs = parseHttpDateParts(
            Number(yearStr),
            monthName,
            Number(dayStr.trim()),
            Number(hourStr),
            Number(minStr),
            Number(secStr),
          );
        }
      }
    }
  }

  return dateMs === undefined ? undefined : Math.max(0, dateMs - now);
}

/**
 * `Basic` authorization header value.
 *
 * @throws {ConfigurationError} when a credential has a character outside
 * Latin-1, which HTTP Basic auth as sent here cannot encode.
 */
export function basicAuthorization(username: string, password: string): string {
  try {
    return `Basic ${btoa(`${username}:${password}`)}`;
  } catch {
    throw new ConfigurationError("Basic auth credentials must contain only Latin-1 characters.");
  }
}

/** Builds structural, log-safe {@link ProviderErrorInfo}. */
export function providerInfo(input: {
  readonly provider: string;
  readonly httpStatus?: number;
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly requestId?: string | null | undefined;
}): ProviderErrorInfo {
  const code = sanitizeDiagnosticToken(input.code, 64);
  const requestId = sanitizeDiagnosticToken(input.requestId, 128);
  return {
    provider: input.provider,
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(code === undefined ? {} : { code }),
    // Free-form response text can echo message bodies, PII, or credentials.
    // Keep log-safe diagnostics structural.
    ...(requestId === undefined ? {} : { requestId }),
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

/**
 * Lookup outcome for a response that is not a documented found or not-found
 * answer: 401/403 `auth`, 429 `rate_limited`, other 4xx `request`, 5xx
 * `server_error`, anything else `unexpected_status`.
 */
export function lookupFailureForStatus(input: {
  readonly provider: string;
  readonly status: number;
  readonly requestId?: string | null | undefined;
  readonly code?: string | undefined;
  readonly message?: string | undefined;
}): MessageLookupOutcome {
  const { status } = input;
  const reason =
    status === 401 || status === 403
      ? "auth"
      : status === 429
        ? "rate_limited"
        : status >= 400 && status < 500
          ? "request"
          : status >= 500
            ? "server_error"
            : "unexpected_status";
  return {
    kind: "failed",
    reason,
    details: providerInfo({
      provider: input.provider,
      httpStatus: status,
      code: input.code,
      message: input.message,
      requestId: input.requestId,
    }),
  };
}

/** Lookup outcome for a 2xx whose body does not have the documented shape. */
export function malformedLookup(provider: string, status: number, requestId?: string | null): MessageLookupOutcome {
  return { kind: "failed", reason: "malformed_response", details: providerInfo({ provider, httpStatus: status, requestId }) };
}

/**
 * A `found` lookup outcome. `errorCode` is kept only when `delivery` is
 * `undelivered` or `filtered`: providers also send placeholder codes such as
 * `0` for messages that did not fail.
 */
export function foundMessage(input: {
  readonly provider: string;
  readonly providerId: string;
  readonly delivery: Delivery;
  readonly providerStatus: string | undefined;
  readonly errorCode: string | undefined;
}): MessageLookupOutcome {
  const failed = input.delivery === "undelivered" || input.delivery === "filtered";
  return {
    kind: "found",
    status: {
      provider: input.provider,
      providerId: input.providerId,
      delivery: input.delivery,
      ...(input.providerStatus === undefined ? {} : { providerStatus: input.providerStatus }),
      ...(failed && input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    },
  };
}
