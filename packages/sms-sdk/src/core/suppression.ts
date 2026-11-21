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
  /** True when `phoneNumber` is suppressed. */
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
  const numbers = new Set(initial);
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
  return async (context) =>
    (await list.has(context.message.to)) ? { kind: "reject", reason: "recipient suppressed" } : { kind: "allow" };
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
  if (event.from === undefined || event.from.length === 0) {
    return "ignored";
  }
  switch (event.type) {
    case "recipient.opted_out":
      await list.add(event.from);
      return "added";
    case "recipient.opted_in":
      await list.remove(event.from);
      return "removed";
    default:
      return "ignored";
  }
}
