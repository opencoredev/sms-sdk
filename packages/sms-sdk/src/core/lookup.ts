import type { MessageLookupOutcome, SmsAdapter } from "./adapters.js";

/**
 * Runs one {@link SmsAdapter.getMessage} request with a per-request timeout
 * linked to the caller's signal. Never throws: an adapter exception becomes
 * `failed` with reason `adapter_exception`.
 */
export async function lookupOnce(input: {
  readonly adapter: SmsAdapter;
  readonly providerId: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
}): Promise<MessageLookupOutcome> {
  const getMessage = input.adapter.getMessage;
  if (getMessage === undefined) {
    return { kind: "failed", reason: "adapter_exception", cause: new TypeError(`${input.adapter.name} has no getMessage.`) };
  }
  if (input.signal?.aborted === true) {
    return { kind: "failed", reason: "aborted", cause: input.signal.reason };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("SMS provider lookup timed out.", "TimeoutError"));
  }, input.timeoutMs);
  const onCallerAbort = (): void => controller.abort(input.signal?.reason);
  input.signal?.addEventListener("abort", onCallerAbort, { once: true });

  let outcome: MessageLookupOutcome;
  try {
    outcome = await getMessage.call(input.adapter, input.providerId, { signal: controller.signal });
  } catch (cause) {
    outcome = { kind: "failed", reason: "adapter_exception", cause };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", onCallerAbort);
  }

  if (outcome.kind === "failed" && controller.signal.aborted) {
    return { ...outcome, reason: timedOut ? "timeout" : "aborted" };
  }
  return outcome;
}
