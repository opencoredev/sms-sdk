import { timingSafeEqual } from "../core/crypto.js";
import { ConfigurationError, WebhookPayloadError, WebhookSignatureError } from "../core/errors.js";
import { basicAuthorization, isRecord, MAX_RESPONSE_BYTES, readBoundedText } from "../core/http.js";
import type { SmsEvent, WebhookProvider } from "./events.js";

/** Largest inbound webhook body read before verification, in bytes (1 MiB). */
export const MAX_WEBHOOK_BYTES = MAX_RESPONSE_BYTES;

/** Reads a webhook request body up to {@link MAX_WEBHOOK_BYTES}, failing with {@link WebhookPayloadError} (`reason: "body_too_large"`) if exceeded. */
export async function readWebhookBody(request: Request, provider: WebhookProvider): Promise<string> {
  let headers: Headers;
  let url: string;
  let method: string;
  let body: ReadableStream<Uint8Array> | null;
  let bodyUsed: boolean;
  let bodyLocked = false;
  try {
    if (!isRecord(request)) {
      throw new ConfigurationError(`The ${provider} webhook parser requires a Request object.`);
    }
    headers = request.headers;
    url = request.url;
    method = request.method;
    body = request.body;
    bodyUsed = request.bodyUsed;
    if (
      !isRecord(headers) ||
      typeof headers.get !== "function" ||
      typeof url !== "string" ||
      typeof method !== "string" ||
      (body !== null && (!isRecord(body) || typeof body.getReader !== "function"))
    ) {
      throw new ConfigurationError(`The ${provider} webhook parser requires a Request object.`);
    }
    headers.get("content-length");
    if (body !== null) {
      bodyLocked = body.locked === true;
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError(`The ${provider} webhook parser requires a Request object.`);
  }
  if (bodyUsed === true || bodyLocked) {
    throw new ConfigurationError(`The ${provider} webhook request body is locked or has already been read.`);
  }
  let text: string | undefined;
  try {
    text = await readBoundedText(request, MAX_WEBHOOK_BYTES);
  } catch (cause) {
    throw new WebhookPayloadError(`The ${provider} webhook body could not be read.`, {
      provider,
      reason: "body_unreadable",
      cause,
    });
  }
  if (text === undefined) {
    throw new WebhookPayloadError(`The ${provider} webhook body exceeded ${MAX_WEBHOOK_BYTES} bytes.`, {
      provider,
      reason: "body_too_large",
    });
  }
  return text;
}

/** Options shared by every provider's webhook parser. */
export type WebhookCommonOptions = {
  /** The incoming request. Its body is read once. */
  readonly request: Request;
  /**
   * Skips signature verification. For local tests only. Refused with
   * `ConfigurationError` when `process.env.NODE_ENV` is `"production"`.
   * Events parsed this way are not authenticated.
   */
  readonly unsafeSkipVerification?: boolean;
  /** Match STOP/HELP keywords in inbound text when the provider sends no signal. Default `true`. */
  readonly detectKeywords?: boolean;
  /** Clock for timestamp checks, in epoch milliseconds. Default `Date.now`. */
  readonly now?: () => number;
};

/** Options for providers that sign the request URL (Twilio, Plivo). */
export type SignedUrlOptions = {
  /**
   * The exact URL the provider calls, as configured in the provider console,
   * such as `https://example.com/webhooks/twilio`. Use it when the app runs
   * behind a proxy or load balancer that changes the host, scheme, or port.
   * If it has no query string, the request's query string is appended.
   */
  readonly publicUrl?: string;
  /**
   * Build the URL from `X-Forwarded-Proto` and `X-Forwarded-Host` when no
   * `publicUrl` is given. Enable only when a proxy you control sets these
   * headers; otherwise a client can forge them. Default `false`.
   */
  readonly trustProxy?: boolean;
};

/**
 * True when the caller asked to skip verification.
 *
 * @throws {ConfigurationError} when skipping is requested and `NODE_ENV` is `"production"`.
 */
export function skipVerification(
  options: Pick<WebhookCommonOptions, "unsafeSkipVerification" | "now">,
): boolean {
  if (!isRecord(options)) {
    throw new ConfigurationError("Webhook options must be an object.");
  }
  if (options.now !== undefined && typeof options.now !== "function") {
    throw new ConfigurationError("Webhook now option must be a function.");
  }
  if (options.unsafeSkipVerification !== true) {
    return false;
  }
  if (readNodeEnv()?.trim().toLowerCase() === "production") {
    throw new ConfigurationError(
      "unsafeSkipVerification is refused when NODE_ENV is production. Verify webhooks with real credentials.",
    );
  }
  return true;
}

/** `process.env.NODE_ENV`, or `undefined` in runtimes without `process` (browsers, some edge runtimes). */
function readNodeEnv(): string | undefined {
  return typeof process === "undefined" ? undefined : process.env?.["NODE_ENV"];
}

/**
 * The single event of a batch, for the single-event parsers.
 *
 * @throws {WebhookPayloadError} when the payload carries more than one event.
 */
export function onlyEvent(provider: WebhookProvider, events: readonly SmsEvent[]): SmsEvent {
  const [first, ...rest] = events;
  if (first === undefined || rest.length > 0) {
    throw new WebhookPayloadError(
      `The ${provider} webhook carries ${events.length} events; use parseSmsWebhooks to read every event.`,
      { provider },
    );
  }
  return first;
}

/** Returns the URL a provider signed, per {@link SignedUrlOptions}. */
export function resolveSignedUrl(request: Request, options: SignedUrlOptions, provider?: WebhookProvider): string {
  let requestUrl: URL;
  try {
    requestUrl = new URL(request.url);
  } catch {
    throw new ConfigurationError("The webhook request has an invalid URL.");
  }
  if (options.publicUrl !== undefined) {
    if (typeof options.publicUrl !== "string" || options.publicUrl.length === 0 || /[\p{Cc}\p{Cf}\p{Z}\s]/u.test(options.publicUrl)) {
      throw new ConfigurationError("publicUrl must be a valid http or https URL.");
    }
    if (options.publicUrl.includes("#")) {
      throw new ConfigurationError("publicUrl must not include a fragment.");
    }
    let parsed: URL;
    try {
      parsed = new URL(options.publicUrl);
    } catch {
      throw new ConfigurationError("publicUrl must be a valid http or https URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ConfigurationError("publicUrl must use http or https.");
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      throw new ConfigurationError("publicUrl must not include credentials.");
    }
    if (parsed.search === "" && options.publicUrl.includes("?")) {
      throw new ConfigurationError("publicUrl must not end with a bare '?'.");
    }
    return options.publicUrl.includes("?") ? options.publicUrl : `${options.publicUrl}${requestUrl.search}`;
  }
  if (options.trustProxy === true) {
    const proto = (firstHeaderValue(request.headers.get("x-forwarded-proto")) ?? requestUrl.protocol.replace(":", "")).toLowerCase();
    const host = firstHeaderValue(request.headers.get("x-forwarded-host")) ?? request.headers.get("host") ?? requestUrl.host;
    if (proto !== "http" && proto !== "https") {
      throw new WebhookSignatureError("Invalid X-Forwarded-Proto header.", {
        reason: "invalid_signature",
        provider: provider ?? "webhook",
      });
    }
    if (/[\\/?#@\s]/.test(host)) {
      throw new WebhookSignatureError("Invalid forwarded host header.", {
        reason: "invalid_signature",
        provider: provider ?? "webhook",
      });
    }
    const candidate = `${proto}://${host}${requestUrl.pathname}${requestUrl.search}`;
    try {
      const parsed = new URL(candidate);
      if (
        parsed.username !== "" ||
        parsed.password !== "" ||
        parsed.pathname !== requestUrl.pathname ||
        parsed.search !== requestUrl.search ||
        parsed.hash !== ""
      ) {
        throw new Error("Invalid host");
      }
    } catch {
      throw new WebhookSignatureError("Invalid forwarded host header.", {
        reason: "invalid_signature",
        provider: provider ?? "webhook",
      });
    }
    return candidate;
  }
  return request.url;
}

/** Reads form fields from a POST body or, for GET, the query string. Repeated keys keep every value. */
export function readFormParams(request: Request, rawBody: string): Array<[string, string]> {
  const source = request.method.toUpperCase() === "GET" ? new URL(request.url).searchParams : new URLSearchParams(rawBody);
  return [...source.entries()];
}

/** Converts form pairs to a record, keeping the first value of repeated keys. */
export function paramsToRecord(params: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!Object.hasOwn(record, key)) {
      Object.defineProperty(record, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  return record;
}

/** Reads a required string field or throws {@link WebhookPayloadError}. */
export function requireField(provider: WebhookProvider, fields: Record<string, string>, key: string): string {
  const value = fields[key];
  if (value === undefined || value.length === 0) {
    throw new WebhookPayloadError(`The ${provider} webhook is missing ${key}.`, { provider });
  }
  return value;
}

/** HTTP Basic credentials a provider sends on its callback requests. */
export type BasicCallbackCredentials = { readonly username: string; readonly password: string };

/**
 * Validates Basic callback credentials before checking request headers.
 *
 * @throws {ConfigurationError} when the credentials are missing, empty, or not Latin-1.
 */
export function requireBasicCredentials(credentials: BasicCallbackCredentials): string {
  if (
    !isRecord(credentials) ||
    typeof credentials.username !== "string" ||
    credentials.username.length === 0 ||
    typeof credentials.password !== "string" ||
    credentials.password.length === 0
  ) {
    throw new ConfigurationError("Basic webhook credentials require non-empty username and password.");
  }
  return basicAuthorization(credentials.username, credentials.password);
}

/**
 * Checks an `Authorization` header against Basic credentials in constant time.
 *
 * @throws {ConfigurationError} when the credentials are missing, empty, or not Latin-1.
 */
export function hasBasicAuthorization(header: string | null, credentials: BasicCallbackCredentials): boolean {
  const expected = requireBasicCredentials(credentials);
  if (header === null) {
    return false;
  }
  return timingSafeEqual(header, expected);
}

/**
 * Validates a webhook timestamp tolerance window in seconds.
 *
 * @throws {ConfigurationError} when `value` is not a finite number >= 0.
 */
export function requireTolerance(value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!(typeof value === "number" && Number.isFinite(value) && value >= 0)) {
    throw new ConfigurationError("toleranceSec must be a finite number of seconds >= 0.");
  }
  return value;
}

/** Parses a date string, returning `undefined` when absent or invalid. */
export function parseDate(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function firstHeaderValue(value: string | null): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first === undefined || first.length === 0 ? undefined : first;
}
