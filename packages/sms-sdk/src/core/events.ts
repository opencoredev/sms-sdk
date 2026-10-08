import type { Delivery, RejectionCategory, SmsEncoding, UnknownReason } from "./adapters.js";

/**
 * One provider request made during a logical send. Safe to log: it holds no
 * message body, credentials, or full phone numbers.
 */
export type SendAttempt =
  | {
      readonly provider: string;
      readonly attempt: number;
      readonly outcome: "accepted";
      readonly providerId: string;
      readonly delivery: Delivery;
      readonly durationMs: number;
    }
  | {
      readonly provider: string;
      readonly attempt: number;
      readonly outcome: "rejected";
      readonly category: RejectionCategory;
      readonly httpStatus?: number;
      readonly providerCode?: string;
      readonly retryAfterMs?: number;
      readonly durationMs: number;
    }
  | {
      readonly provider: string;
      readonly attempt: number;
      readonly outcome: "unknown";
      readonly reason: UnknownReason;
      readonly httpStatus?: number;
      readonly durationMs: number;
    };

/** Fields shared by every hook event. Phone numbers are masked. */
export type SmsHookEventBase = {
  /** Library-scoped logical send ID. */
  readonly id: string;
  /** Masked destination, such as `+1********23`. */
  readonly to: string;
  readonly encoding: SmsEncoding;
  readonly segments: number;
  readonly idempotencyKey?: string;
};

/** Emitted after every provider request. */
export type SmsAttemptEvent = SmsHookEventBase & { readonly attempt: SendAttempt };

/** Emitted once when a logical send is accepted by a provider. */
export type SmsAcceptedEvent = SmsHookEventBase & {
  readonly provider: string;
  readonly providerId: string;
  readonly attempts: readonly SendAttempt[];
};

/** Emitted once when a logical send ends with an error. */
export type SmsFailureEvent = SmsHookEventBase & {
  /** The `code` of the thrown `SmsError`. */
  readonly errorCode: string;
  readonly retrySafe: boolean;
  readonly attempts: readonly SendAttempt[];
};

/**
 * Optional observability callbacks. Payloads are redacted. A hook that throws
 * or rejects is ignored so it cannot change the send outcome.
 */
export type SmsClientHooks = {
  readonly onAttempt?: (event: SmsAttemptEvent) => void | Promise<void>;
  readonly onAccepted?: (event: SmsAcceptedEvent) => void | Promise<void>;
  readonly onFailure?: (event: SmsFailureEvent) => void | Promise<void>;
};

/** Calls a hook and swallows any synchronous or asynchronous failure. */
export function emitHook<T>(hook: ((event: T) => void | Promise<void>) | undefined, event: T): void {
  if (hook === undefined) {
    return;
  }

  try {
    const result = hook(event);
    if (result instanceof Promise) {
      result.catch(() => undefined);
    }
  } catch {
    // Hooks are observability only; they must not change the send outcome.
  }
}
