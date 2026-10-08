import { WebhookPayloadError } from "../core/errors.js";
import type { WebhookProvider } from "./events.js";

/** Options shared by every provider's webhook parser. */
export type WebhookCommonOptions = {
  /** The incoming request. Its body is read once. */
  readonly request: Request;
  /**
   * Skips signature verification. For local tests only; never enable it in
   * production. Events parsed this way are not authenticated.
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

/** Returns the URL a provider signed, per {@link SignedUrlOptions}. */
export function resolveSignedUrl(request: Request, options: SignedUrlOptions): string {
  const requestUrl = new URL(request.url);
  if (options.publicUrl !== undefined) {
    return options.publicUrl.includes("?") ? options.publicUrl : `${options.publicUrl}${requestUrl.search}`;
  }
  if (options.trustProxy === true) {
    const proto = firstHeaderValue(request.headers.get("x-forwarded-proto")) ?? requestUrl.protocol.replace(":", "");
    const host = firstHeaderValue(request.headers.get("x-forwarded-host")) ?? request.headers.get("host") ?? requestUrl.host;
    return `${proto}://${host}${requestUrl.pathname}${requestUrl.search}`;
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
    if (!(key in record)) {
      record[key] = value;
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
