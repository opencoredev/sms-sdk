import { ConfigurationError } from "./errors.js";
import { isRecord } from "./http.js";
import type { BeforeSendContext, PolicyDecision } from "./types.js";

/**
 * Numbers that must not receive messages, such as recipients who replied
 * STOP. Methods may be async so a list can live in a database or cache shared
 * by every process that sends.
 *
 * Numbers are compared exactly; store E.164, as webhook events and
 * `SmsSendInput.to` use.
 */
export interface SuppressionList {
  /**
   * True when `phoneNumber` is suppressed. Any value other than `true` or
   * `false` makes {@link suppressionPolicy} throw `ConfigurationError`, so the
   * send fails and nothing is sent.
   */
  has(phoneNumber: string): boolean | Promise<boolean>;
  /** Suppresses `phoneNumber`. Adding a number twice is a no-op. */
  add(phoneNumber: string): void | Promise<void>;
  /** Lifts the suppression, such as after the recipient replied START. */
  remove(phoneNumber: string): void | Promise<void>;
}

/** A {@link SuppressionList} held in process memory. */
export type MemorySuppressionList = SuppressionList & {
  /** Suppressed numbers, in insertion order. */
  readonly numbers: () => readonly string[];
};

/**
 * Creates an in-memory {@link SuppressionList}. It is lost on restart and not
 * shared between processes, so use it for tests and single-process tools; in
 * production, back {@link SuppressionList} with your database.
 */
export function memorySuppressionList(initial: Iterable<string> = []): MemorySuppressionList {
  const numbers = new Set<string>();
  try {
    if (typeof initial === "string") {
      throw new ConfigurationError("memorySuppressionList() requires an iterable of phone number strings.");
    }
    for (const entry of initial) {
      if (typeof entry !== "string") {
        throw new ConfigurationError("memorySuppressionList() requires an iterable of phone number strings.");
      }
      numbers.add(entry);
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("memorySuppressionList() requires an iterable of phone number strings.");
  }
  return {
    has: (phoneNumber) => numbers.has(phoneNumber),
    add: (phoneNumber) => {
      numbers.add(phoneNumber);
    },
    remove: (phoneNumber) => {
      numbers.delete(phoneNumber);
    },
    numbers: () => [...numbers],
  };
}

/**
 * A `beforeSend` policy that rejects sends to suppressed numbers with
 * `PolicyRejectedError` (reason `"recipient suppressed"`), so they are never
 * sent and never fall back to another adapter:
 *
 * ```ts
 * const optOuts = memorySuppressionList();
 * const sms = createSmsClient({ adapters: [twilio(options)], beforeSend: suppressionPolicy(optOuts) });
 * ```
 *
 * To combine it with other checks, call it from your own `beforeSend`.
 */
export function suppressionPolicy(list: SuppressionList): (context: BeforeSendContext) => Promise<PolicyDecision> {
  let hasFn: SuppressionList["has"];
  try {
    if (!isRecord(list)) {
      throw new ConfigurationError("suppressionPolicy() requires a valid SuppressionList.");
    }
    const rawHas = list["has"];
    if (typeof rawHas !== "function") {
      throw new ConfigurationError("suppressionPolicy() requires a valid SuppressionList.");
    }
    hasFn = (rawHas as SuppressionList["has"]).bind(list);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("suppressionPolicy() requires a valid SuppressionList.");
  }
  return async (context) => {
    const suppressed: unknown = await hasFn(context.message.to);
    if (typeof suppressed !== "boolean") {
      // An unclear answer, such as undefined from a failed read, must not allow the send.
      throw new ConfigurationError("SuppressionList.has() must return a boolean.");
    }
    return suppressed ? { kind: "reject", reason: "recipient suppressed" } : { kind: "allow" };
  };
}

/** The webhook event fields {@link applySuppressionEvent} reads. Every `SmsEvent` fits. */
export type SuppressionEventInput = { readonly type: string; readonly from?: string };

/**
 * Updates `list` from a verified webhook event: `recipient.opted_out` adds the
 * sender, `recipient.opted_in` removes it, and every other event is ignored.
 * Returns what it did. Call it with each event from `parseSmsWebhooks`.
 */
export async function applySuppressionEvent(
  list: SuppressionList,
  event: SuppressionEventInput,
): Promise<"added" | "removed" | "ignored"> {
  let addFn: SuppressionList["add"];
  let removeFn: SuppressionList["remove"];
  try {
    if (!isRecord(list)) {
      throw new ConfigurationError("applySuppressionEvent() requires a valid SuppressionList.");
    }
    const rawAdd = list["add"];
    const rawRemove = list["remove"];
    if (typeof rawAdd !== "function" || typeof rawRemove !== "function") {
      throw new ConfigurationError("applySuppressionEvent() requires a valid SuppressionList.");
    }
    addFn = (rawAdd as SuppressionList["add"]).bind(list);
    removeFn = (rawRemove as SuppressionList["remove"]).bind(list);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("applySuppressionEvent() requires a valid SuppressionList.");
  }
  let from: unknown;
  let type: unknown;
  try {
    if (!isRecord(event)) {
      throw new ConfigurationError("applySuppressionEvent() requires an event object.");
    }
    from = event.from;
    type = event.type;
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("applySuppressionEvent() requires an event object.");
  }
  if (typeof from !== "string" || from.length === 0) {
    return "ignored";
  }
  switch (type) {
    case "recipient.opted_out":
      await addFn(from);
      return "added";
    case "recipient.opted_in":
      await removeFn(from);
      return "removed";
    default:
      return "ignored";
  }
}
