import type { SerializedSmsError } from "./errors.js";
import type { SmsSendResult } from "./types.js";

/**
 * Persisted state of one idempotency key.
 *
 * - `reserved`: a sender owns the key and may be mid-request.
 * - `accepted`: the provider accepted the message; replays return `result`.
 * - `rejected`: every attempt was rejected; the key may be reserved again with the same payload.
 * - `unknown`: the outcome is unknown; replays throw `HandoffUnknownError` and never resend.
 */
export type IdempotencyRecord =
  | {
      readonly state: "reserved";
      readonly fingerprint: string;
      readonly reservationId: string;
      /** Epoch milliseconds when the reservation was made. */
      readonly reservedAt: number;
    }
  | { readonly state: "accepted"; readonly fingerprint: string; readonly result: SmsSendResult }
  | { readonly state: "rejected"; readonly fingerprint: string; readonly error: SerializedSmsError }
  | { readonly state: "unknown"; readonly fingerprint: string; readonly error: SerializedSmsError };

/** A record written by `finalize`: any state except `reserved`. */
export type FinalIdempotencyRecord = Exclude<IdempotencyRecord, { state: "reserved" }>;

/** Result of {@link IdempotencyStore.reserve}. */
export type ReserveResult =
  | { readonly kind: "reserved"; readonly reservationId: string }
  | { readonly kind: "existing"; readonly record: IdempotencyRecord };

/** Result of {@link IdempotencyStore.finalize}. */
export type FinalizeResult = { readonly kind: "finalized" } | { readonly kind: "not_owner" };

/**
 * Storage for idempotency keys, shared by every process that sends with the
 * same keys.
 *
 * Implementations must make `reserve` atomic (one compare-and-set, such as
 * `SET NX` in Redis or `INSERT ... ON CONFLICT DO NOTHING` in SQL). A `get`
 * followed by a `set` is not safe: two workers can both see "no record" and
 * both send.
 */
export interface IdempotencyStore {
  /** Reads the current record, or `null`. */
  get(key: string): Promise<IdempotencyRecord | null>;
  /**
   * Atomically claims `key`. Succeeds only when there is no record, or the
   * record is `rejected` with the same fingerprint. Otherwise returns the
   * existing record without changing it. Reservations must not expire into a
   * claimable state: an abandoned reservation means the outcome is unknown.
   */
  reserve(input: { readonly key: string; readonly fingerprint: string; readonly now: number }): Promise<ReserveResult>;
  /**
   * Replaces the reservation with a final record, only if `reservationId`
   * still owns the key. `ttlSec` is how long `accepted` and `rejected` records
   * must be kept. `unknown` records should be kept until an operator clears them.
   */
  finalize(input: {
    readonly key: string;
    readonly reservationId: string;
    readonly record: FinalIdempotencyRecord;
    readonly ttlSec: number;
    readonly now: number;
  }): Promise<FinalizeResult>;
}

/** A process-local {@link IdempotencyStore} with a `delete` method for manual reconciliation. */
export type MemoryIdempotencyStore = IdempotencyStore & {
  /** Removes a record, for example after reconciling an unknown outcome. */
  delete(key: string): Promise<void>;
  /** Number of stored records, including expired ones not yet swept. */
  readonly size: number;
};

type MemoryEntry = { readonly record: IdempotencyRecord; readonly expiresAt: number | null };

/**
 * An in-memory {@link IdempotencyStore}.
 *
 * It protects one process only. With several instances, serverless
 * functions, or restarts, use a shared store that implements atomic `reserve`.
 * `unknown` and `reserved` records never expire on their own.
 */
export function memoryIdempotencyStore(): MemoryIdempotencyStore {
  const entries = new Map<string, MemoryEntry>();

  const read = (key: string, now: number): IdempotencyRecord | null => {
    const entry = entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt !== null && entry.expiresAt <= now) {
      entries.delete(key);
      return null;
    }
    return entry.record;
  };

  return {
    async get(key) {
      return read(key, Date.now());
    },

    async reserve({ key, fingerprint, now }) {
      const existing = read(key, now);
      const claimable =
        existing === null || (existing.state === "rejected" && existing.fingerprint === fingerprint);
      if (!claimable) {
        return { kind: "existing", record: existing };
      }

      const reservationId = crypto.randomUUID();
      entries.set(key, {
        record: { state: "reserved", fingerprint, reservationId, reservedAt: now },
        expiresAt: null,
      });
      return { kind: "reserved", reservationId };
    },

    async finalize({ key, reservationId, record, ttlSec, now }) {
      const current = entries.get(key)?.record;
      if (current === undefined || current.state !== "reserved" || current.reservationId !== reservationId) {
        return { kind: "not_owner" };
      }

      const expiresAt = record.state === "unknown" ? null : now + ttlSec * 1000;
      entries.set(key, { record, expiresAt });
      return { kind: "finalized" };
    },

    async delete(key) {
      entries.delete(key);
    },

    get size() {
      return entries.size;
    },
  };
}

/**
 * SHA-256 fingerprint of the fields that make two sends "the same message".
 * Used to detect a key reused with a different payload.
 */
export async function fingerprintMessage(fields: {
  readonly to: string;
  readonly from: unknown;
  readonly body: string;
  readonly mediaUrls: readonly string[];
  readonly sendAt: string | null;
  readonly validityPeriodSec: number | null;
  readonly webhookUrl: string | null;
}): Promise<string> {
  const canonical = JSON.stringify([
    fields.to,
    fields.from ?? null,
    fields.body,
    fields.mediaUrls,
    fields.sendAt,
    fields.validityPeriodSec,
    fields.webhookUrl,
  ]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
