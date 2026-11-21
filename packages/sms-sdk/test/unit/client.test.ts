import { describe, expect, test } from "bun:test";
import { createSmsClient } from "../../src/core/client.js";
import {
  AllProvidersRejectedError,
  ConfigurationError,
  HandoffUnknownError,
  IdempotencyConflictError,
  PolicyRejectedError,
  ProviderAuthError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  SendAbortedError,
} from "../../src/core/errors.js";
import { memoryIdempotencyStore } from "../../src/core/idempotency.js";
import type { SmsAcceptedEvent, SmsAttemptEvent, SmsFailureEvent } from "../../src/core/events.js";
import type { SmsSendInput } from "../../src/core/types.js";
import { acceptedOutcome, memory, rejectedOutcome, unknownOutcome } from "../../src/testing/memory.js";
import { rejection } from "../helpers.js";

const message = { to: "+14155550123", body: "Your order has shipped." } as const;
const fastRetry = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 50 };

describe("send: accepted", () => {
  test("returns a normalized accepted result", async () => {
    const adapter = memory({ outcomes: [acceptedOutcome("prov-1", "queued")] });
    const result = await createSmsClient({ adapters: [adapter] }).send(message);
    expect(result).toMatchObject({
      provider: "memory",
      providerId: "prov-1",
      handoff: "accepted",
      delivery: "queued",
      encoding: "gsm7",
      segments: 1,
      attemptedProviders: ["memory"],
      replayed: false,
    });
    expect(result.id).toMatch(/^sms_[0-9a-f]{32}$/);
    expect(result.attempts).toEqual([
      expect.objectContaining({ provider: "memory", attempt: 1, outcome: "accepted", providerId: "prov-1" }),
    ]);
  });

  test("acceptance is not reported as delivery", async () => {
    const result = await createSmsClient({ adapters: [memory()] }).send(message);
    expect(result.delivery).toBe("queued");
  });

  test("uses the adapter default sender when from is omitted", async () => {
    const adapter = memory({ from: "+15005550001" });
    await createSmsClient({ adapters: [adapter] }).send(message);
    expect(adapter.sent[0]?.message.from).toEqual({ kind: "phone_number", value: "+15005550001" });
  });

  test("a per-message from overrides the default", async () => {
    const adapter = memory({ from: "+15005550001" });
    await createSmsClient({ adapters: [adapter] }).send({ ...message, from: { senderId: "Acme" } });
    expect(adapter.sent[0]?.message.from).toEqual({ kind: "alphanumeric", value: "Acme" });
  });

  test("passes the idempotency key to the adapter context", async () => {
    const adapter = memory();
    await createSmsClient({ adapters: [adapter] }).send({ ...message, idempotencyKey: "order:1" });
    expect(adapter.sent[0]?.idempotencyKey).toBe("order:1");
  });
});

describe("send: rejection without fallback", () => {
  test("a permanent rejection throws ProviderRejectedError", async () => {
    const adapter = memory({ outcomes: [rejectedOutcome("recipient", { code: "21211" })] });
    const error = await rejection(createSmsClient({ adapters: [adapter] }).send(message));
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect(error).toMatchObject({ code: "provider_rejected", category: "recipient", retrySafe: true, fallbackEligible: false });
  });

  test("auth rejections throw ProviderAuthError", async () => {
    const error = await rejection(createSmsClient({ adapters: [memory({ outcomes: [rejectedOutcome("auth")] })] }).send(message));
    expect(error).toBeInstanceOf(ProviderAuthError);
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect(error).toMatchObject({ code: "provider_auth", category: "auth", fallbackEligible: true });
  });

  test("fallback is off by default even for eligible rejections", async () => {
    const primary = memory({ name: "primary", outcomes: [rejectedOutcome("sender")] });
    const secondary = memory({ name: "secondary" });
    const error = await rejection(createSmsClient({ adapters: [primary, secondary] }).send(message));
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect(secondary.sent).toHaveLength(0);
  });
});

describe("send: unknown outcomes", () => {
  test.each(["network", "malformed_response", "server_error", "unexpected_status"] as const)(
    "%s throws HandoffUnknownError and is never retried",
    async (reason) => {
      const adapter = memory({ outcomes: [unknownOutcome(reason)] });
      const error = await rejection(createSmsClient({ adapters: [adapter], retry: fastRetry }).send(message));
      expect(error).toBeInstanceOf(HandoffUnknownError);
      expect(error).toMatchObject({ code: "handoff_unknown", retrySafe: false, reason, providerName: "memory" });
      expect(adapter.sent).toHaveLength(1);
    },
  );

  test("an adapter that throws is treated as unknown", async () => {
    const adapter = memory({
      outcomes: [
        () => {
          throw new Error("adapter bug");
        },
      ],
    });
    const error = await rejection(createSmsClient({ adapters: [adapter] }).send(message));
    expect(error).toBeInstanceOf(HandoffUnknownError);
    expect(error).toMatchObject({ reason: "adapter_exception" });
  });
});

describe("send: fallback", () => {
  test("falls back after an eligible rejection when opted in", async () => {
    const primary = memory({ name: "primary", outcomes: [rejectedOutcome("sender", { provider: "primary" })] });
    const secondary = memory({ name: "secondary" });
    const result = await createSmsClient({ adapters: [primary, secondary], fallback: "on-known-rejection" }).send(message);
    expect(result.provider).toBe("secondary");
    expect(result.attemptedProviders).toEqual(["primary", "secondary"]);
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(["rejected", "accepted"]);
  });

  test.each(["auth", "account", "sender"] as const)("%s rejections are fallback-eligible", async (category) => {
    const primary = memory({ name: "primary", outcomes: [rejectedOutcome(category, { provider: "primary" })] });
    const secondary = memory({ name: "secondary" });
    const result = await createSmsClient({ adapters: [primary, secondary], fallback: "on-known-rejection" }).send(message);
    expect(result.provider).toBe("secondary");
  });

  test.each(["recipient", "compliance", "request"] as const)("%s rejections never fall back", async (category) => {
    const primary = memory({ name: "primary", outcomes: [rejectedOutcome(category, { provider: "primary" })] });
    const secondary = memory({ name: "secondary" });
    const error = await rejection(
      createSmsClient({ adapters: [primary, secondary], fallback: "on-known-rejection" }).send(message),
    );
    expect(error).toBeInstanceOf(ProviderRejectedError);
    expect(error).toMatchObject({ category, fallbackEligible: false });
    expect(secondary.sent).toHaveLength(0);
  });

  test("never falls back after an unknown outcome", async () => {
    const primary = memory({ name: "primary", outcomes: [unknownOutcome("timeout")] });
    const secondary = memory({ name: "secondary" });
    const error = await rejection(
      createSmsClient({ adapters: [primary, secondary], fallback: "on-known-rejection" }).send(message),
    );
    expect(error).toBeInstanceOf(HandoffUnknownError);
    expect(secondary.sent).toHaveLength(0);
  });

  test("never sends to a second adapter after acceptance", async () => {
    const primary = memory({ name: "primary" });
    const secondary = memory({ name: "secondary" });
    await createSmsClient({ adapters: [primary, secondary], fallback: "on-known-rejection" }).send(message);
    expect(primary.sent).toHaveLength(1);
    expect(secondary.sent).toHaveLength(0);
  });

  test("throws AllProvidersRejectedError with every attempt when all reject", async () => {
    const primary = memory({ name: "primary", outcomes: [rejectedOutcome("sender", { provider: "primary" })] });
    const secondary = memory({ name: "secondary", outcomes: [rejectedOutcome("account", { provider: "secondary" })] });
    const error = await rejection(
      createSmsClient({ adapters: [primary, secondary], fallback: "on-known-rejection" }).send(message),
    );
    expect(error).toBeInstanceOf(AllProvidersRejectedError);
    if (!(error instanceof AllProvidersRejectedError)) return;
    expect(error.retrySafe).toBe(true);
    expect(error.errors.map((inner) => [inner.providerName, inner.category])).toEqual([
      ["primary", "sender"],
      ["secondary", "account"],
    ]);
    expect(error.attempts.map((attempt) => attempt.provider)).toEqual(["primary", "secondary"]);
  });

  test("stops at a non-eligible rejection from a fallback adapter", async () => {
    const first = memory({ name: "first", outcomes: [rejectedOutcome("auth", { provider: "first" })] });
    const second = memory({ name: "second", outcomes: [rejectedOutcome("compliance", { provider: "second" })] });
    const third = memory({ name: "third" });
    const error = await rejection(
      createSmsClient({ adapters: [first, second, third], fallback: "on-known-rejection" }).send(message),
    );
    expect(error).toBeInstanceOf(AllProvidersRejectedError);
    expect(third.sent).toHaveLength(0);
  });

  test("skips fallback adapters that cannot send the message", async () => {
    const primary = memory({ name: "primary", outcomes: [rejectedOutcome("sender", { provider: "primary" })] });
    const noMms = memory({ name: "no-mms", capabilities: { mms: false } });
    const third = memory({ name: "third" });
    const result = await createSmsClient({ adapters: [primary, noMms, third], fallback: "on-known-rejection" }).send({
      ...message,
      mediaUrls: ["https://example.com/a.png"],
    });
    expect(result.provider).toBe("third");
    expect(noMms.sent).toHaveLength(0);
  });

  test("a beforeSend rejection never reaches any adapter", async () => {
    const primary = memory({ name: "primary" });
    const secondary = memory({ name: "secondary" });
    const sms = createSmsClient({
      adapters: [primary, secondary],
      fallback: "on-known-rejection",
      beforeSend: () => ({ kind: "reject", reason: "recipient opted out" }),
    });
    const error = await rejection(sms.send(message));
    expect(error).toBeInstanceOf(PolicyRejectedError);
    expect(error).toMatchObject({ code: "policy_rejected", reason: "recipient opted out", retrySafe: true });
    expect(primary.sent).toHaveLength(0);
    expect(secondary.sent).toHaveLength(0);
  });

  test("a beforeSend reason stays out of the message, toJSON, and hooks", async () => {
    const reason = "Jane Doe at +14155550123 is on the suppression list";
    const failures: unknown[] = [];
    const sms = createSmsClient({
      adapters: [memory()],
      beforeSend: () => ({ kind: "reject", reason }),
      hooks: {
        onFailure: (event) => {
          failures.push(event);
        },
      },
    });
    const error = await rejection(sms.send(message));
    expect(error).toBeInstanceOf(PolicyRejectedError);
    expect(error).toMatchObject({ reason, message: "Send blocked by the beforeSend policy." });
    const serialized = JSON.stringify([error, failures, String(error)]);
    expect(serialized).not.toContain("Jane");
    expect(serialized).not.toContain("4155550123");
    expect(serialized).toContain("policy_rejected");
    expect(failures).toHaveLength(1);
  });

  test("beforeSend receives the message and segment estimate", async () => {
    const seen: unknown[] = [];
    const sms = createSmsClient({
      adapters: [memory()],
      beforeSend: async (context) => {
        seen.push({ to: context.message.to, encoding: context.encoding, segments: context.segments });
        return { kind: "allow" };
      },
    });
    await sms.send(message);
    expect(seen).toEqual([{ to: "+14155550123", encoding: "gsm7", segments: 1 }]);
  });

  test("an exception in beforeSend propagates and nothing is sent", async () => {
    const adapter = memory();
    const sms = createSmsClient({
      adapters: [adapter],
      beforeSend: () => {
        throw new Error("suppression list unavailable");
      },
    });
    const error = await rejection(sms.send(message));
    expect(error).toEqual(new Error("suppression list unavailable"));
    expect(adapter.sent).toHaveLength(0);
  });

  test("an exception in beforeSend still emits onFailure", async () => {
    const failures: SmsFailureEvent[] = [];
    const sms = createSmsClient({
      adapters: [memory()],
      beforeSend: () => {
        throw new Error("suppression list unavailable");
      },
      hooks: { onFailure: (event) => void failures.push(event) },
    });
    await rejection(sms.send(message));
    expect(failures).toEqual([
      expect.objectContaining({ errorCode: "policy_rejected", retrySafe: true, attempts: [], to: expect.not.stringContaining("4155550123") }),
    ]);
  });
});

describe("send: unexpected chain failure", () => {
  test("keeps the attempts made before the chain threw", async () => {
    const primary = memory({ name: "primary", outcomes: [rejectedOutcome("sender")] });
    // A custom adapter that breaks the contract: a rejection with no details.
    const broken = memory({ name: "broken", outcomes: [() => JSON.parse('{"kind":"rejected","category":"request"}')] });
    const failures: SmsFailureEvent[] = [];
    const sms = createSmsClient({
      adapters: [primary, broken],
      fallback: "on-known-rejection",
      hooks: { onFailure: (event) => void failures.push(event) },
    });
    const error = await rejection(sms.send(message));
    expect(error).toBeInstanceOf(HandoffUnknownError);
    expect(error).toMatchObject({ reason: "adapter_exception", retrySafe: false });
    expect(error).toMatchObject({
      attempts: [
        expect.objectContaining({ provider: "primary", outcome: "rejected" }),
        expect.objectContaining({ provider: "broken", outcome: "unknown", reason: "adapter_exception" }),
      ],
    });
    expect(failures[0]?.attempts).toHaveLength(2);
  });
});

describe("send: retries", () => {
  test("retries a rate-limited rejection on the same adapter", async () => {
    const adapter = memory({ outcomes: [rejectedOutcome("rate_limited")] });
    const result = await createSmsClient({ adapters: [adapter], retry: fastRetry }).send(message);
    expect(adapter.sent.map((sent) => sent.attempt)).toEqual([1, 2]);
    expect(result.attempts.map((attempt) => attempt.outcome)).toEqual(["rejected", "accepted"]);
  });

  test("throws ProviderRateLimitedError when retries run out", async () => {
    const adapter = memory({ outcomes: [rejectedOutcome("rate_limited"), rejectedOutcome("rate_limited", { retryAfterMs: 5 })] });
    const error = await rejection(createSmsClient({ adapters: [adapter], retry: fastRetry }).send(message));
    expect(error).toBeInstanceOf(ProviderRateLimitedError);
    expect(error).toMatchObject({ code: "provider_rate_limited", retryAfterMs: 5, retrySafe: true });
    expect(adapter.sent).toHaveLength(2);
  });

  test("honors Retry-After within maxDelayMs", async () => {
    const adapter = memory({ outcomes: [rejectedOutcome("rate_limited", { retryAfterMs: 40 })] });
    const started = Date.now();
    await createSmsClient({ adapters: [adapter], retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 100 } }).send(message);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(adapter.sent).toHaveLength(2);
  });

  test("does not wait for a Retry-After longer than maxDelayMs", async () => {
    const adapter = memory({ outcomes: [rejectedOutcome("rate_limited", { retryAfterMs: 60_000 })] });
    const started = Date.now();
    const error = await rejection(createSmsClient({ adapters: [adapter], retry: fastRetry }).send(message));
    expect(error).toBeInstanceOf(ProviderRateLimitedError);
    expect(adapter.sent).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("falls back after rate-limit retries are exhausted", async () => {
    const primary = memory({
      name: "primary",
      outcomes: [rejectedOutcome("rate_limited", { provider: "primary" }), rejectedOutcome("rate_limited", { provider: "primary" })],
    });
    const secondary = memory({ name: "secondary" });
    const result = await createSmsClient({
      adapters: [primary, secondary],
      fallback: "on-known-rejection",
      retry: fastRetry,
    }).send(message);
    expect(result.provider).toBe("secondary");
    expect(result.attempts.map((attempt) => `${attempt.provider}:${attempt.attempt}`)).toEqual([
      "primary:1",
      "primary:2",
      "secondary:1",
    ]);
  });

  test.each(["sender", "auth", "account", "recipient", "compliance", "request"] as const)(
    "%s rejections are not retried on the same adapter",
    async (category) => {
      const adapter = memory({ outcomes: [rejectedOutcome(category)] });
      await rejection(createSmsClient({ adapters: [adapter], retry: { maxAttempts: 5, baseDelayMs: 1 } }).send(message));
      expect(adapter.sent).toHaveLength(1);
    },
  );

  test("maxAttempts 1 disables retries", async () => {
    const adapter = memory({ outcomes: [rejectedOutcome("rate_limited")] });
    await rejection(createSmsClient({ adapters: [adapter], retry: { maxAttempts: 1 } }).send(message));
    expect(adapter.sent).toHaveLength(1);
  });
});

describe("send: abort and timeout", () => {
  test("an already-aborted signal throws SendAbortedError without a request", async () => {
    const adapter = memory();
    const controller = new AbortController();
    controller.abort();
    const error = await rejection(createSmsClient({ adapters: [adapter] }).send(message, { signal: controller.signal }));
    expect(error).toBeInstanceOf(SendAbortedError);
    expect(error).toMatchObject({ retrySafe: true });
    expect(adapter.sent).toHaveLength(0);
  });

  test("aborting during a request is an unknown outcome", async () => {
    const controller = new AbortController();
    const adapter = memory({
      outcomes: [
        (_message, context) =>
          new Promise((resolve) => {
            context.signal.addEventListener("abort", () => resolve(unknownOutcome("network")));
            controller.abort();
          }),
      ],
    });
    const error = await rejection(createSmsClient({ adapters: [adapter] }).send(message, { signal: controller.signal }));
    expect(error).toBeInstanceOf(HandoffUnknownError);
    expect(error).toMatchObject({ reason: "aborted", retrySafe: false });
  });

  test("a per-request timeout is an unknown outcome and is not failed over", async () => {
    const primary = memory({
      name: "primary",
      outcomes: [
        (_message, context) =>
          new Promise((resolve) => context.signal.addEventListener("abort", () => resolve(unknownOutcome("network")))),
      ],
    });
    const secondary = memory({ name: "secondary" });
    const error = await rejection(
      createSmsClient({ adapters: [primary, secondary], fallback: "on-known-rejection", timeoutMs: 20 }).send(message),
    );
    expect(error).toBeInstanceOf(HandoffUnknownError);
    expect(error).toMatchObject({ reason: "timeout" });
    expect(secondary.sent).toHaveLength(0);
  });

  test("aborting during retry backoff throws SendAbortedError", async () => {
    const controller = new AbortController();
    const adapter = memory({ outcomes: [rejectedOutcome("rate_limited", { retryAfterMs: 1_000 })] });
    const pending = createSmsClient({ adapters: [adapter], retry: { maxAttempts: 2, maxDelayMs: 5_000 } }).send(message, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    const error = await rejection(pending);
    expect(error).toBeInstanceOf(SendAbortedError);
    expect(error).toMatchObject({ retrySafe: true });
    expect(adapter.sent).toHaveLength(1);
  });
});

describe("observability hooks", () => {
  test("emit redacted attempt, accepted, and failure events", async () => {
    const attempts: SmsAttemptEvent[] = [];
    const accepted: SmsAcceptedEvent[] = [];
    const failures: SmsFailureEvent[] = [];
    const hooks = {
      onAttempt: (event: SmsAttemptEvent) => void attempts.push(event),
      onAccepted: (event: SmsAcceptedEvent) => void accepted.push(event),
      onFailure: (event: SmsFailureEvent) => void failures.push(event),
    };
    const adapter = memory({ outcomes: [acceptedOutcome("p1"), rejectedOutcome("recipient")] });
    const sms = createSmsClient({ adapters: [adapter], hooks });
    await sms.send({ ...message, body: "Your code is 123456" });
    await rejection(sms.send({ ...message, body: "Your code is 654321" }));

    expect(attempts).toHaveLength(2);
    expect(accepted).toEqual([expect.objectContaining({ provider: "memory", providerId: "p1", to: "+1********23" })]);
    expect(failures).toEqual([expect.objectContaining({ errorCode: "provider_rejected", retrySafe: true })]);
    const serialized = JSON.stringify({ attempts, accepted, failures });
    expect(serialized).not.toContain("123456");
    expect(serialized).not.toContain("654321");
    expect(serialized).not.toContain("+14155550123");
  });

  test("a throwing hook does not change the outcome", async () => {
    const sms = createSmsClient({
      adapters: [memory()],
      hooks: {
        onAttempt: () => {
          throw new Error("metrics down");
        },
        onAccepted: async () => {
          throw new Error("async metrics down");
        },
      },
    });
    await expect(sms.send(message)).resolves.toMatchObject({ handoff: "accepted" });
  });
});

describe("send: fromByAdapter", () => {
  test("each adapter in a fallback chain sends from its own entry", async () => {
    const primary = memory({ name: "primary", from: "+15005550001", outcomes: [rejectedOutcome("sender")] });
    const backup = memory({ name: "backup", from: "+15005550002" });
    const sms = createSmsClient({ adapters: [primary, backup], fallback: "on-known-rejection" });
    await sms.send({
      ...message,
      from: "+15005550009",
      fromByAdapter: { primary: { senderId: "Acme" }, backup: "+15005550003", unconfigured: "+15005550004" },
    });
    expect(primary.sent[0]?.message.from).toEqual({ kind: "alphanumeric", value: "Acme" });
    expect(backup.sent[0]?.message.from).toEqual({ kind: "phone_number", value: "+15005550003" });
  });

  test("an adapter without an entry falls back to from, then its default", async () => {
    const a = memory({ name: "a", from: "+15005550001", outcomes: [rejectedOutcome("sender")] });
    const b = memory({ name: "b", from: "+15005550002", outcomes: [rejectedOutcome("sender")] });
    const c = memory({ name: "c", from: "+15005550003" });
    await createSmsClient({ adapters: [a, b, c], fallback: "on-known-rejection" }).send({
      ...message,
      fromByAdapter: { a: "+15005550007" },
    });
    expect([a, b, c].map((adapter) => adapter.sent[0]?.message.from.value)).toEqual(["+15005550007", "+15005550002", "+15005550003"]);
  });

  test("an invalid entry is reported for that adapter only", () => {
    const sms = createSmsClient({ adapters: [memory({ name: "a" }), memory({ name: "b" })] });
    const result = sms.validate({ ...message, fromByAdapter: { b: { shortCode: "1" } } });
    expect(result.adapterCandidates).toEqual(["a"]);
    expect(result.issues).toEqual([expect.objectContaining({ code: "invalid_sender", provider: "b" })]);
  });

  test("a non-object fromByAdapter is an invalid_field issue", () => {
    const sms = createSmsClient({ adapters: [memory()] });
    const input: SmsSendInput = JSON.parse('{"to":"+14155550123","body":"hi","fromByAdapter":"+15005550006"}');
    expect(sms.validate(input).issues).toContainEqual(expect.objectContaining({ code: "invalid_field", field: "fromByAdapter" }));
  });

  test("rejects null from, null config fields, oversized timeoutMs, and fractional idempotency seconds", () => {
    const sms = createSmsClient({ adapters: [memory()] });
    const nullFrom: SmsSendInput = JSON.parse('{"to":"+14155550123","body":"hi","from":null}');
    expect(sms.validate(nullFrom).supported).toBe(false);
    expect(sms.validate(nullFrom).issues).toContainEqual(expect.objectContaining({ code: "invalid_sender", field: "from" }));

    const nullFromWithByAdapter: SmsSendInput = JSON.parse(
      '{"to":"+14155550123","body":"hi","from":null,"fromByAdapter":{"memory":"+15005550006"}}',
    );
    expect(sms.validate(nullFromWithByAdapter).supported).toBe(false);

    expect(() =>
      createSmsClient({
        adapters: [memory()],
        idempotency: { store: memoryIdempotencyStore(), ttlSec: 0.5 },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        adapters: [memory()],
        idempotency: { store: memoryIdempotencyStore(), staleReservationSec: 0.5 },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        adapters: [memory()],
        idempotency: null as unknown as { store: ReturnType<typeof memoryIdempotencyStore> },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        adapters: [memory()],
        idempotency: {} as unknown as { store: ReturnType<typeof memoryIdempotencyStore> },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        adapters: [memory()],
        timeoutMs: null as unknown as number,
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        adapters: [memory()],
        timeoutMs: 2 ** 31,
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        adapters: [memory()],
        retry: null as unknown as { maxAttempts: number },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        adapters: [memory()],
        retry: { maxAttempts: null as unknown as number },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        adapters: [memory()],
        retry: { maxDelayMs: 2 ** 31 },
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        adapters: [memory()],
        retry: { baseDelayMs: 2 ** 31 },
      }),
    ).toThrow(ConfigurationError);
  });

  test("hardens frozen capability constants, stateful class hooks, vonage class/reportsCredentials, providerOptions scoping, Object.prototype adapter names, beforeSend thenables, and Twilio params", async () => {
    const { TWILIO_CAPABILITIES, twilio } = await import("../../src/providers/twilio.js");
    const { vonage } = await import("../../src/providers/vonage.js");
    const { computeTwilioSignature, verifyTwilioSignature } = await import("../../src/webhooks/twilio.js");

    // 1. Exported capability constants and capabilities() output are deep-frozen
    expect(Object.isFrozen(TWILIO_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(TWILIO_CAPABILITIES.senderTypes)).toBe(true);
    expect(Object.isFrozen(TWILIO_CAPABILITIES.validityPeriod)).toBe(true);
    const baseMem = memory({ from: { senderId: "ACME" } });
    const caps = createSmsClient({ adapters: [baseMem] }).capabilities();
    expect(Object.isFrozen(caps)).toBe(true);
    expect(Object.isFrozen(caps[0])).toBe(true);
    expect(Object.isFrozen(caps[0]?.capabilities)).toBe(true);
    expect(Object.isFrozen(caps[0]?.capabilities.senderTypes)).toBe(true);

    // Mutating caller-supplied from object does not mutate memory() defaultFrom
    const senderObj = { senderId: "ACME" };
    const memAdapter = memory({ from: senderObj });
    senderObj.senderId = "EVIL";
    const memClient = createSmsClient({ adapters: [memAdapter] });
    await memClient.send({ to: "+14155550123", body: "hi" });
    expect(memAdapter.sent[0]?.message.from).toEqual({ kind: "alphanumeric", value: "ACME" });

    // 2. Stateful class-instance hooks work with bound `this` and known hook getters are read once
    class StatefulHooks {
      accepted: string[] = [];
      onAccepted(e: { providerId: string }) {
        this.accepted.push(e.providerId);
      }
    }
    const statefulHooks = new StatefulHooks();
    const hookClient = createSmsClient({ adapters: [memory()], hooks: statefulHooks });
    await hookClient.send({ to: "+14155550123", body: "hi" });
    expect(statefulHooks.accepted).toHaveLength(1);

    let hookReads = 0;
    const singleReadHooks = {};
    Object.defineProperty(singleReadHooks, "onAccepted", {
      enumerable: true,
      get() {
        hookReads += 1;
        if (hookReads > 1) throw new Error("read twice");
        return () => {};
      },
    });
    createSmsClient({ adapters: [memory()], hooks: singleReadHooks });
    expect(hookReads).toBe(1);

    // 3. Vonage accepts class-instance options and single-reads/guards reportsCredentials
    class VonageBasicClass {
      get apiKey() {
        return "key12345";
      }
      get apiSecret() {
        return "sec1234567890";
      }
      get from() {
        return "+14155550100";
      }
    }
    const vonageFromClass = vonage(new VonageBasicClass() as unknown as Parameters<typeof vonage>[0]);
    expect(vonageFromClass.name).toBe("vonage");

    const pem = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----";
    expect(() =>
      vonage({
        applicationId: "app-1",
        privateKey: pem,
        reportsCredentials: {
          get apiKey(): string {
            throw new Error("reports boom");
          },
          apiSecret: "sec",
        },
      }),
    ).toThrow(ConfigurationError);

    let reportKeyReads = 0;
    vonage({
      applicationId: "app-1",
      privateKey: pem,
      reportsCredentials: {
        get apiKey() {
          reportKeyReads += 1;
          return "goodkey";
        },
        apiSecret: "sec",
      },
    });
    expect(reportKeyReads).toBe(1);

    // 4. Unconfigured providerOptions keys with throwing getters are ignored
    const memOnly = createSmsClient({ adapters: [memory()] });
    const res = memOnly.validate({
      to: "+14155550123",
      body: "hi",
      providerOptions: {
        get unconfigured() {
          throw new Error("should not read");
        },
      } as unknown as NonNullable<SmsSendInput["providerOptions"]>,
    });
    expect(res.supported).toBe(true);

    // 5. Adapter named "toString" does not trip Object.prototype in fromByAdapter
    const protoNamed = createSmsClient({ adapters: [memory({ name: "toString" })] });
    expect(protoNamed.validate({ to: "+14155550123", body: "hi", fromByAdapter: {} }).supported).toBe(true);

    // 6. Revoked Proxy for adapters, from, and missing adapter.support throw ConfigurationError
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(() => createSmsClient({ adapters: revoked.proxy as unknown as [ReturnType<typeof memory>] })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      twilio({
        accountSid: `AC${"a".repeat(32)}`,
        authToken: "tok",
        from: revoked.proxy as unknown as NonNullable<SmsSendInput["from"]>,
      }),
    ).toThrow(ConfigurationError);
    expect(() =>
      createSmsClient({
        adapters: [{ ...memory(), support: undefined as unknown as ReturnType<typeof memory>["support"] }],
      }),
    ).toThrow(ConfigurationError);

    // 7. beforeSend returning a throwing thenable or revoked Proxy fails closed with PolicyRejectedError
    const badThenableClient = createSmsClient({
      adapters: [memory()],
      beforeSend: () =>
        ({
          get then() {
            throw new Error("then-boom");
          },
        }) as unknown as { kind: "allow" },
    });
    await expect(badThenableClient.send({ to: "+14155550123", body: "hi" })).rejects.toThrow(PolicyRejectedError);

    const revokedPolicyClient = createSmsClient({
      adapters: [memory()],
      beforeSend: () => revoked.proxy as unknown as { kind: "allow" },
    });
    await expect(revokedPolicyClient.send({ to: "+14155550123", body: "hi" })).rejects.toThrow(PolicyRejectedError);

    // 8. Twilio verify/compute reject revoked or throwing params with ConfigurationError
    await expect(
      computeTwilioSignature({
        authToken: "tok",
        url: "https://example.com/hook",
        params: revoked.proxy as unknown as Array<[string, string]>,
      }),
    ).rejects.toThrow(ConfigurationError);

    const throwingParams: Array<[string, string]> = [];
    Object.defineProperty(throwingParams, 0, {
      enumerable: true,
      get() {
        throw new Error("param boom");
      },
    });
    Object.defineProperty(throwingParams, "length", { value: 1 });
    await expect(
      verifyTwilioSignature({
        authToken: "tok",
        url: "https://example.com/hook",
        params: throwingParams,
        signature: "abc",
      }),
    ).rejects.toThrow(ConfigurationError);

    // 9. Exported *_PROVIDER_OPTIONS are deep-frozen and custom specs are snapshotted upfront
    const { TWILIO_PROVIDER_OPTIONS } = await import("../../src/providers/twilio.js");
    expect(Object.isFrozen(TWILIO_PROVIDER_OPTIONS)).toBe(true);
    expect(Object.isFrozen(TWILIO_PROVIDER_OPTIONS.reserved)).toBe(true);
    const mutableSpec = {
      options: { tag: { type: "string" as const, wire: "tag" } },
      reserved: ["to"],
    };
    const specClient = createSmsClient({
      adapters: [memory({ name: "custom", providerOptions: mutableSpec })],
    });
    mutableSpec.reserved.length = 0;
    expect(
      specClient.validate({
        to: "+14155550123",
        body: "hi",
        providerOptions: {
          custom: { extra: { to: "+19990000000" } },
        } as unknown as NonNullable<SmsSendInput["providerOptions"]>,
      }).supported,
    ).toBe(false);

    // 10. Class-instance capabilities and validityPeriod prototype getters are preserved
    class Range {
      get minSec() {
        return 1;
      }
      get maxSec() {
        return 10;
      }
    }
    class ProtoCaps {
      get sendText(): true {
        return true;
      }
      get mms() {
        return true;
      }
      get scheduling() {
        return false;
      }
      get validityPeriod() {
        return new Range();
      }
      get webhookUrlOverride() {
        return false;
      }
      get inbound() {
        return false;
      }
      get deliveryReceipts() {
        return false;
      }
      get senderTypes() {
        return ["long_code"] as const;
      }
      get nativeIdempotency() {
        return false;
      }
    }
    let nameReads = 0;
    const protoClient = createSmsClient({
      adapters: [
        {
          get name() {
            nameReads += 1;
            return "proto";
          },
          capabilities: new ProtoCaps(),
          support: { status: "supported", notes: [] },
          defaultFrom: "+15005550006",
          async send() {
            return { kind: "accepted", providerId: "p1", delivery: "queued" };
          },
        },
      ],
    });
    expect(nameReads).toBe(1);
    expect(protoClient.capabilities()[0]?.capabilities.mms).toBe(true);
    expect(protoClient.validate({ to: "+14155550123", body: "hi", validityPeriodSec: 11 }).supported).toBe(false);
    expect(protoClient.validate({ to: "+14155550123", body: "hi", validityPeriodSec: 5 }).supported).toBe(true);

    // 11. memory() rejects null, revoked Proxy, throwing option getters, invalid outcomes, capabilities, and providerOptions
    expect(() => memory(null as unknown as Parameters<typeof memory>[0])).toThrow(ConfigurationError);
    expect(() => memory(revoked.proxy as unknown as Parameters<typeof memory>[0])).toThrow(ConfigurationError);
    expect(() =>
      memory({
        get name(): string {
          throw new Error("mem-boom");
        },
      }),
    ).toThrow(ConfigurationError);
    expect(() => memory({ outcomes: [42 as unknown as never] })).toThrow(ConfigurationError);
    expect(() => memory({ capabilities: { mms: "yes" as unknown as boolean } })).toThrow(ConfigurationError);
    expect(() => memory({ capabilities: { senderTypes: "abc" as unknown as never } })).toThrow(ConfigurationError);
    expect(() => memory({ capabilities: { sendText: false as unknown as true } })).toThrow(ConfigurationError);
    expect(() => memory({ providerOptions: "bad" as unknown as never })).toThrow(ConfigurationError);

    // 12. Class-instance ProviderOptionField preserves prototype getters and __proto__ option key does not mutate prototype
    class FieldDef {
      get type() {
        return "enum" as const;
      }
      get wire() {
        return "mode";
      }
      get values() {
        return ["a", "b"] as const;
      }
    }
    const protoFieldClient = createSmsClient({
      adapters: [
        {
          name: "proto-po",
          capabilities: new ProtoCaps(),
          support: { status: "supported", notes: [] },
          defaultFrom: "+15005550006",
          providerOptions: { options: { mode: new FieldDef() }, reserved: [] },
          async send() {
            return { kind: "accepted", providerId: "1", delivery: "queued" };
          },
        },
      ],
    });
    expect(
      protoFieldClient.validate({
        to: "+14155550123",
        body: "hi",
        providerOptions: { "proto-po": { mode: "a" } } as unknown as NonNullable<SmsSendInput["providerOptions"]>,
      }).supported,
    ).toBe(true);

    // 13. Single-read TOCTOU protection on capabilities/support/providerOptions and sendText: true enforcement
    let mmsReads = 0;
    const toctouClient = createSmsClient({
      adapters: [
        {
          name: "toctou",
          capabilities: {
            sendText: true,
            get mms() {
              mmsReads += 1;
              return mmsReads === 1 ? true : ("INJECTED" as unknown as boolean);
            },
            scheduling: false,
            validityPeriod: null,
            webhookUrlOverride: false,
            inbound: false,
            deliveryReceipts: false,
            senderTypes: ["long_code"],
            nativeIdempotency: false,
          },
          support: { status: "supported", notes: [] },
          async send() {
            return { kind: "accepted", providerId: "1", delivery: "queued" };
          },
        },
      ],
    });
    expect(mmsReads).toBe(1);
    expect(toctouClient.capabilities()[0]?.capabilities.mms).toBe(true);
    expect(() =>
      createSmsClient({
        adapters: [
          {
            ...memory(),
            capabilities: { ...memory().capabilities, sendText: false as unknown as true },
          },
        ],
      }),
    ).toThrow(ConfigurationError);

    // 14. Malformed send() outcome fails closed as HandoffUnknownError and does not strand idempotency lock
    const { memoryIdempotencyStore } = await import("../../src/testing/index.js");
    const badSendStore = memoryIdempotencyStore();
    const badSendClient = createSmsClient({
      adapters: [
        {
          name: "bad-send",
          capabilities: new ProtoCaps(),
          support: { status: "supported", notes: [] },
          defaultFrom: "+15005550006",
          async send() {
            return { kind: "queued", providerId: "p" } as unknown as never;
          },
        },
      ],
      idempotency: { store: badSendStore },
    });
    await expect(badSendClient.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-bad" })).rejects.toBeInstanceOf(
      HandoffUnknownError,
    );
    await expect(badSendClient.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-bad" })).rejects.toBeInstanceOf(
      HandoffUnknownError,
    );

    // 15. Malformed getMessage() outcome rejects with MessageLookupError
    const { MessageLookupError } = await import("../../src/core/errors.js");
    const badLookupClient = createSmsClient({
      adapters: [
        {
          name: "bad-lookup",
          capabilities: new ProtoCaps(),
          support: { status: "supported", notes: [] },
          defaultFrom: "+15005550006",
          async send() {
            return { kind: "accepted", providerId: "1", delivery: "queued" };
          },
          async getMessage() {
            return null as unknown as never;
          },
        },
      ],
    });
    await expect(badLookupClient.getMessage("m1")).rejects.toBeInstanceOf(MessageLookupError);

    // 16. Custom adapter rejected details.message does not leak full phone numbers into error.message or toJSON()
    const leakyRejectClient = createSmsClient({
      adapters: [
        {
          name: "leaky-reject",
          capabilities: new ProtoCaps(),
          support: { status: "supported", notes: [] },
          defaultFrom: "+15005550006",
          async send() {
            return {
              kind: "rejected",
              category: "request",
              details: { provider: "leaky-reject", message: "bad +14155550123 SECRET_BODY" },
            };
          },
        },
      ],
    });
    const leakyErr = (await rejection(leakyRejectClient.send({ to: "+14155550123", body: "hi" }))) as Error;
    expect(leakyErr.message).not.toContain("+14155550123");
    expect(leakyErr.message).not.toContain("SECRET_BODY");
    expect(JSON.stringify(leakyErr)).not.toContain("+14155550123");
    expect(JSON.stringify(leakyErr)).not.toContain("SECRET_BODY");

    // 17. Accepted send outcome validates delivery & reads providerId once; malformed fails closed
    const badDeliveryClient = createSmsClient({
      adapters: [
        {
          name: "bad-del",
          capabilities: new ProtoCaps(),
          support: { status: "supported", notes: [] },
          defaultFrom: "+15005550006",
          async send() {
            return { kind: "accepted", providerId: "id1", delivery: "bogus" } as unknown as never;
          },
        },
      ],
    });
    await expect(badDeliveryClient.send({ to: "+14155550123", body: "hi" })).rejects.toBeInstanceOf(HandoffUnknownError);

    let pidReads = 0;
    const toctouPidClient = createSmsClient({
      adapters: [
        {
          name: "pid-once",
          capabilities: new ProtoCaps(),
          support: { status: "supported", notes: [] },
          defaultFrom: "+15005550006",
          async send() {
            return {
              kind: "accepted",
              get providerId() {
                pidReads += 1;
                return pidReads === 1 ? "msg_ok" : (undefined as unknown as string);
              },
              delivery: "queued",
            };
          },
        },
      ],
    });
    const toctouPidRes = await toctouPidClient.send({ to: "+14155550123", body: "hi" });
    expect(toctouPidRes.providerId).toBe("msg_ok");
    expect(pidReads).toBe(1);

    // 18. getMessage() normalizes missing reason, empty status, throwing getters, and strips details.message
    const badLookupShapes = [
      { kind: "failed" },
      { kind: "failed", reason: 123 },
      { kind: "found", status: {} },
      {
        get kind() {
          throw new Error("getter-boom");
        },
      },
    ];
    for (const shape of badLookupShapes) {
      const c = createSmsClient({
        adapters: [
          {
            name: "bad-lkp",
            capabilities: new ProtoCaps(),
            support: { status: "supported", notes: [] },
            defaultFrom: "+15005550006",
            async send() {
              return { kind: "accepted", providerId: "1", delivery: "queued" };
            },
            async getMessage() {
              return shape as unknown as never;
            },
          },
        ],
      });
      await expect(c.getMessage("m1")).rejects.toBeInstanceOf(MessageLookupError);
    }

    const leakyLookupClient = createSmsClient({
      adapters: [
        {
          name: "leaky-lkp",
          capabilities: new ProtoCaps(),
          support: { status: "supported", notes: [] },
          defaultFrom: "+15005550006",
          async send() {
            return { kind: "accepted", providerId: "1", delivery: "queued" };
          },
          async getMessage() {
            return {
              kind: "failed",
              reason: "request",
              details: {
                provider: "leaky-lkp",
                code: "body secret +14155550123 alice@example.com",
                requestId: "body secret +14155550123 alice@example.com",
                message: "SECRET_KEY +14155550123 alice@example.com",
              },
            };
          },
        },
      ],
    });
    const leakyLookupErr = (await rejection(leakyLookupClient.getMessage("m1"))) as Error;
    expect(leakyLookupErr).toBeInstanceOf(MessageLookupError);
    expect(leakyLookupErr.message).not.toContain("SECRET_KEY");
    expect(JSON.stringify(leakyLookupErr)).not.toContain("+14155550123");
    expect(JSON.stringify(leakyLookupErr)).not.toContain("alice@example.com");

    // 19. memory().enqueue rejects malformed outcomes; malformed idempotency.store.reserve throws ConfigurationError
    expect(() => memory().enqueue({ kind: "queued" } as unknown as never)).toThrow(ConfigurationError);

    let capturedFp = "";
    const badReserveClient = createSmsClient({
      adapters: [memory()],
      idempotency: {
        store: {
          async get() {
            return null;
          },
          async reserve(i) {
            capturedFp = i.fingerprint;
            return {
              kind: "existing",
              record: { state: "accepted", fingerprint: capturedFp },
            } as unknown as never;
          },
          async finalize() {
            return { kind: "finalized" };
          },
        },
      },
    });
    await expect(
      badReserveClient.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-bad-res" }),
    ).rejects.toBeInstanceOf(ConfigurationError);

    // 20. sanitizeProviderDetails uses fallback adapter name and validates HTTP status 100..599
    const spoofedDetailsClient = createSmsClient({
      adapters: [
        {
          name: "spoof-adapter",
          capabilities: new ProtoCaps(),
          support: { status: "supported", notes: [] },
          defaultFrom: "+15005550006",
          async send() {
            return {
              kind: "rejected",
              category: "request",
              details: {
                provider: "forged +14155550123 secret",
                httpStatus: 14155550123,
                code: "BAD_REQ",
              },
            };
          },
        },
      ],
    });
    const spoofedErr = (await rejection(spoofedDetailsClient.send({ to: "+14155550123", body: "hi" }))) as {
      provider?: { provider?: string; httpStatus?: number };
    };
    expect(spoofedErr.provider?.provider).toBe("spoof-adapter");
    expect(spoofedErr.provider?.httpStatus).toBeUndefined();
    expect(JSON.stringify(spoofedErr)).not.toContain("14155550123");

    // 21. idempotency.store.reserve throwing getters & incomplete/TOCTOU accepted records throw ConfigurationError
    for (const badReturn of [
      {
        get kind() {
          throw new Error("kind boom");
        },
      },
      {
        kind: "existing",
        record: {
          state: "accepted",
          fingerprint: capturedFp,
          result: { provider: "memory", providerId: "m1", delivery: "queued" },
        },
      },
      {
        kind: "existing",
        record: {
          state: "accepted",
          fingerprint: capturedFp,
          result: (() => {
            let reads = 0;
            return {
              id: "sms_1",
              provider: "memory",
              providerId: "m1",
              handoff: "accepted",
              get delivery() {
                reads += 1;
                return reads === 1 ? "queued" : "EVIL";
              },
              encoding: "gsm7",
              segments: 1,
              attemptedProviders: ["memory"],
              attempts: [],
              replayed: false,
            };
          })(),
        },
      },
    ]) {
      const probeClient = createSmsClient({
        adapters: [memory()],
        idempotency: {
          store: {
            async get() {
              return null;
            },
            async reserve(i) {
              if (
                typeof badReturn === "object" &&
                badReturn !== null &&
                "record" in badReturn &&
                typeof badReturn.record === "object" &&
                badReturn.record !== null
              ) {
                (badReturn.record as { fingerprint: string }).fingerprint = i.fingerprint;
              }
              return badReturn as unknown as never;
            },
            async finalize() {
              return { kind: "finalized" };
            },
          },
        },
      });
      if ("record" in badReturn && (badReturn.record as { result?: { id?: string } }).result?.id === "sms_1") {
        const res = await probeClient.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-toctou" });
        expect(res.delivery).toBe("queued");
        expect(res.replayed).toBe(true);
      } else {
        await expect(
          probeClient.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-throw-res" }),
        ).rejects.toBeInstanceOf(ConfigurationError);
      }
    }

    // 22. memory().enqueue snapshots outcomes and wraps throwing getters in ConfigurationError
    expect(() =>
      memory().enqueue({
        get kind() {
          throw new Error("outcome boom");
        },
      } as unknown as never),
    ).toThrow(ConfigurationError);
    const mutableAccepted = { kind: "accepted" as const, providerId: "orig-1", delivery: "queued" as const };
    const snapMem = memory();
    snapMem.enqueue(mutableAccepted);
    (mutableAccepted as { providerId: string }).providerId = "mutated-2";
    const snapClient = createSmsClient({ adapters: [snapMem] });
    expect((await snapClient.send({ to: "+14155550123", body: "hi" })).providerId).toBe("orig-1");

    // 23. Webhook parsers read duck-typed Request getters only once
    const { parseTwilioWebhook } = await import("../../src/webhooks/index.js");
    let headerReads = 0;
    let urlReads = 0;
    let methodReads = 0;
    const rawHeaders = new Headers({ "content-type": "application/x-www-form-urlencoded" });
    const singleReadReq = {
      get headers() {
        headerReads += 1;
        if (headerReads > 1) throw new Error("headers read twice");
        return rawHeaders;
      },
      get url() {
        urlReads += 1;
        if (urlReads > 1) throw new Error("url read twice");
        return "https://example.com/webhooks/twilio";
      },
      get method() {
        methodReads += 1;
        if (methodReads > 1) throw new Error("method read twice");
        return "POST";
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("MessageSid=SM123&MessageStatus=delivered&To=%2B14155550123&From=%2B15005550006"));
          controller.close();
        },
      }),
      bodyUsed: false,
    } as unknown as Request;
    const parsedWebhook = await parseTwilioWebhook({
      request: singleReadReq,
      credentials: { authToken: "unused" },
      unsafeSkipVerification: true,
    });
    expect(parsedWebhook.type).toBe("message.delivered");
    expect(headerReads).toBe(1);
    expect(urlReads).toBe(1);
    expect(methodReads).toBe(1);

    // 24. Diagnostic tokens drop phone-length digit runs anywhere in token; hooks/callers cannot mutate stored idempotency records; reserve() errors normalize to ConfigurationError
    const phoneTokenClient = createSmsClient({
      adapters: [
        {
          name: "phone-tok",
          capabilities: new ProtoCaps(),
          support: { status: "supported", notes: [] },
          defaultFrom: "+15005550006",
          async send() {
            return {
              kind: "rejected",
              category: "request",
              details: { provider: "phone-tok", code: "recipient:14155550123", requestId: "to-14155550123" },
            };
          },
        },
      ],
    });
    const phoneTokErr = (await rejection(phoneTokenClient.send({ to: "+14155550123", body: "hi" }))) as Error;
    expect(JSON.stringify(phoneTokErr)).not.toContain("14155550123");

    const isoStore = memoryIdempotencyStore();
    const isoClient = createSmsClient({
      adapters: [memory()],
      idempotency: { store: isoStore },
      hooks: {
        onAccepted: (e) => {
          (e.attempts as unknown[]).length = 0;
        },
      },
    });
    const firstIso = await isoClient.send({ to: "+14155550123", body: "iso", idempotencyKey: "k-iso" });
    (firstIso as { providerId: string }).providerId = "TAMPERED";
    const replayIso = await isoClient.send({ to: "+14155550123", body: "iso", idempotencyKey: "k-iso" });
    expect(firstIso.attempts).toHaveLength(1);
    expect(replayIso.attempts).toHaveLength(1);
    expect(replayIso.providerId).toBe("memory_1");

    const throwingReserveClient = createSmsClient({
      adapters: [memory()],
      idempotency: {
        store: {
          async get() {
            return null;
          },
          async reserve() {
            throw new Error("db offline");
          },
          async finalize() {
            return { kind: "finalized" };
          },
        },
      },
    });
    await expect(
      throwingReserveClient.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-db" }),
    ).rejects.toBeInstanceOf(ConfigurationError);

    // 25. memory() preserves unknown.cause and rejects sparse arrays; Sinch expire_at anchors to sendAt
    const causeErr = new Error("socket reset");
    const causeClient = createSmsClient({
      adapters: [memory({ outcomes: [{ kind: "unknown", reason: "network", cause: causeErr }] })],
    });
    const unknownOut = (await rejection(causeClient.send({ to: "+14155550123", body: "hi" }))) as HandoffUnknownError;
    expect(unknownOut).toBeInstanceOf(HandoffUnknownError);
    expect(unknownOut.cause).toBe(causeErr);
    expect(() => memory({ outcomes: new Array(1) as unknown as never })).toThrow(ConfigurationError);
    expect(() => memory({ capabilities: { senderTypes: new Array(1) as unknown as never } })).toThrow(ConfigurationError);

    const { buildSinchRequest } = await import("../../src/providers/sinch.js");
    const futureSendAt = new Date("2030-01-01T12:00:00.000Z");
    const sinchReq = buildSinchRequest({
      to: "+14155550123",
      from: { kind: "phone_number", value: "+15005550006" },
      body: "hi",
      mediaUrls: [],
      sendAt: futureSendAt,
      validityPeriodSec: 3600,
    });
    expect(sinchReq.send_at).toBe("2030-01-01T12:00:00.000Z");
    expect(sinchReq.expire_at).toBe("2030-01-01T13:00:00.000Z");

    // 26. Oversized duck-typed webhook body without cancel() still reports body_too_large
    const { parseSmsWebhook } = await import("../../src/webhooks/index.js");
    const { WebhookPayloadError } = await import("../../src/core/errors.js");
    const noCancelErr = await rejection(
      parseSmsWebhook({
        provider: "twilio",
        request: {
          headers: new Headers({ "content-length": "2000000" }),
          url: "https://example.com/wh/twilio",
          method: "POST",
          body: {
            locked: false,
            getReader() {
              throw new Error("should not read");
            },
          },
          bodyUsed: false,
        } as unknown as Request,
        credentials: { authToken: "secret" },
      }),
    );
    expect(noCancelErr).toBeInstanceOf(WebhookPayloadError);
    expect((noCancelErr as { reason?: string }).reason).toBe("body_too_large");

    // 27. Suppression helpers validate malformed inputs with ConfigurationError
    const { memorySuppressionList, suppressionPolicy, applySuppressionEvent } = await import(
      "../../src/core/suppression.js"
    );
    expect(() => memorySuppressionList(123 as unknown as Iterable<string>)).toThrow(ConfigurationError);
    expect(() => suppressionPolicy(null as unknown as never)).toThrow(ConfigurationError);
    await expect(applySuppressionEvent(memorySuppressionList(), null as unknown as never)).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    await expect(
      applySuppressionEvent(
        {
          get add() {
            throw new Error("boom");
          },
          remove() {},
          has() {
            return false;
          },
        } as unknown as never,
        { type: "recipient.opted_out", from: "+14155550123" },
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);

    // 28. Diagnostic tokens keep opaque UUID/Twilio RQ IDs while dropping punctuated phone numbers; reserve() preserves cause; coalesced results are isolated; stored attempts reject HandoffUnknown-only reasons; webhook reads content-length & getReader once
    const diagClient = createSmsClient({
      adapters: [
        {
          name: "diag",
          capabilities: new ProtoCaps(),
          support: { status: "supported", notes: [] },
          defaultFrom: "+15005550006",
          async send() {
            return {
              kind: "rejected",
              category: "request",
              details: {
                provider: "diag",
                code: "to:1-415-555-0123",
                requestId: "3f2c1b7a-9d4e-4c1a-8b2f-202611210735",
              },
            };
          },
        },
      ],
    });
    const diagErr = (await rejection(diagClient.send({ to: "+14155550123", body: "hi" }))) as {
      provider?: { code?: string; requestId?: string };
    };
    expect(diagErr.provider?.code).toBeUndefined();
    expect(diagErr.provider?.requestId).toBe("3f2c1b7a-9d4e-4c1a-8b2f-202611210735");

    const dbErr = new Error("redis down");
    const causeResClient = createSmsClient({
      adapters: [memory()],
      idempotency: {
        store: {
          async get() {
            return null;
          },
          async reserve() {
            throw dbErr;
          },
          async finalize() {
            return { kind: "finalized" };
          },
        },
      },
    });
    const causeResErr = (await rejection(
      causeResClient.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-cause" }),
    )) as Error;
    expect(causeResErr).toBeInstanceOf(ConfigurationError);
    expect(causeResErr.cause).toBe(dbErr);

    const badAttemptReasonClient = createSmsClient({
      adapters: [memory()],
      idempotency: {
        store: {
          async get() {
            return null;
          },
          async reserve({ fingerprint }) {
            return {
              kind: "existing",
              record: {
                state: "accepted",
                fingerprint,
                result: {
                  id: "sms_1",
                  provider: "memory",
                  providerId: "p1",
                  handoff: "accepted",
                  delivery: "queued",
                  encoding: "gsm7",
                  segments: 1,
                  attemptedProviders: ["memory"],
                  attempts: [
                    { provider: "memory", attempt: 1, outcome: "unknown", reason: "stale_reservation", durationMs: 5 },
                  ],
                  replayed: false,
                },
              },
            } as unknown as never;
          },
          async finalize() {
            return { kind: "finalized" };
          },
        },
      },
    });
    await expect(
      badAttemptReasonClient.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-bad-reason" }),
    ).rejects.toBeInstanceOf(ConfigurationError);

    let clReads = 0;
    let grReads = 0;
    const whPayload = new TextEncoder().encode(
      JSON.stringify([{ type: "message-delivered", message: { id: "m1", from: "+15005550006", to: ["+14155550123"] } }]),
    );
    let whSent = false;
    const { parseSmsWebhooks } = await import("../../src/webhooks/index.js");
    await parseSmsWebhooks({
      provider: "bandwidth",
      credentials: { username: "u", password: "p" },
      request: {
        url: "https://example.com/wh",
        method: "POST",
        bodyUsed: false,
        headers: {
          get(n: string) {
            if (n.toLowerCase() === "content-length") {
              clReads += 1;
              return String(whPayload.byteLength);
            }
            if (n.toLowerCase() === "authorization") return `Basic ${btoa("u:p")}`;
            return null;
          },
        },
        body: {
          locked: false,
          get getReader() {
            grReads += 1;
            return () => ({
              async read() {
                if (whSent) return { done: true, value: undefined };
                whSent = true;
                return { done: false, value: whPayload };
              },
            });
          },
        },
      } as unknown as Request,
    });
    expect(clReads).toBe(1);
    expect(grReads).toBe(1);

    // 29. R25: coalesced fast sends without store share 1 call & isolate results; SmsError#toJSON clones attempts/provider; diagnostic tokens keep RQ+32-hex & drop colon/all-digit phone numbers; readBoundedText uses intrinsic byteLength
    let fastCalls = 0;
    const fastClient = createSmsClient({
      adapters: [
        {
          name: "fast",
          capabilities: new ProtoCaps(),
          support: { status: "supported", notes: [] },
          defaultFrom: "+15005550006",
          async send() {
            fastCalls += 1;
            return { kind: "accepted", providerId: "msg-fast", delivery: "queued" };
          },
        },
      ],
    });
    const [f1, f2, f3] = await Promise.all([
      fastClient.send({ to: "+14155550123", body: "hi", idempotencyKey: "fast-k1" }),
      fastClient.send({ to: "+14155550123", body: "hi", idempotencyKey: "fast-k1" }),
      fastClient.send({ to: "+14155550123", body: "hi", idempotencyKey: "fast-k1" }),
    ]);
    expect(fastCalls).toBe(1);
    expect(f1.replayed).toBe(false);
    expect(f2.replayed).toBe(true);
    expect(f3.replayed).toBe(true);
    (f1.attemptedProviders as string[]).push("tampered");
    (f1.attempts as unknown as Array<{ provider: string }>)[0]!.provider = "tampered";
    expect(f2.attemptedProviders).toEqual(["fast"]);
    expect(f2.attempts[0]!.provider).toBe("fast");

    const { sanitizeProviderDetails, readBoundedText } = await import("../../src/core/http.js");
    expect(
      sanitizeProviderDetails(
        { code: "415:555:0123", requestId: "RQ1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d" },
        "twilio",
      ),
    ).toEqual({
      provider: "twilio",
      requestId: "RQ1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
    });
    expect(
      sanitizeProviderDetails(
        { code: "415.555.0123", requestId: "RQ14155550123000000000000000000000" },
        "twilio",
      ),
    ).toEqual({ provider: "twilio" });
    expect(
      sanitizeProviderDetails(
        { requestId: "14155550-1234-4123-8123-414155550123" },
        "twilio",
      ),
    ).toEqual({ provider: "twilio" });

    const spoofChunk = new Uint8Array(64);
    Object.defineProperty(spoofChunk, "byteLength", { value: 1 });
    let spoofDone = false;
    const bounded = await readBoundedText(
      {
        headers: new Headers(),
        body: {
          getReader() {
            return {
              async read() {
                if (spoofDone) return { done: true, value: undefined };
                spoofDone = true;
                return { done: false, value: spoofChunk };
              },
              async cancel() {},
            };
          },
        } as unknown as ReadableStream<Uint8Array>,
      },
      32,
    );
    expect(bounded).toBeUndefined();

    const errJsonTest = new HandoffUnknownError("unknown", {
      reason: "network",
      provider: { provider: "p1", httpStatus: 500 },
      attempts: [{ provider: "p1", attempt: 1, outcome: "unknown", reason: "network", durationMs: 1 }],
    });
    const j1 = errJsonTest.toJSON();
    (j1.attempts as unknown as Array<{ provider: string }>)[0]!.provider = "mutated";
    (j1.provider as { provider: string }).provider = "mutated";
    expect(errJsonTest.toJSON().attempts[0]!.provider).toBe("p1");
    expect(errJsonTest.toJSON().provider!.provider).toBe("p1");
  });

  test("preserves valid 32-hex provider IDs with long digit runs while dropping all-decimal phone-padded IDs", async () => {
    const { sanitizeProviderDetails } = await import("../../src/core/http.js");
    expect(
      sanitizeProviderDetails(
        { requestId: "RQ0123456789abcdef0123456789abcdef" },
        "twilio",
      ),
    ).toEqual({
      provider: "twilio",
      requestId: "RQ0123456789abcdef0123456789abcdef",
    });
    expect(
      sanitizeProviderDetails(
        { requestId: "RQ14155550123000000000000000000000" },
        "twilio",
      ),
    ).toEqual({ provider: "twilio" });
  });

  test("isolates AbortSignal cancellation per caller across coalesced same-key sends", async () => {
    let adapterAborted = false;
    let adapterCalls = 0;
    const makeSlowClient = () =>
      createSmsClient({
        adapters: [
          {
            name: "slow",
            capabilities: memory().capabilities,
            support: { status: "supported", notes: [] },
            defaultFrom: "+15005550006",
            send(_msg, ctx) {
              adapterCalls += 1;
              return new Promise((resolve) => {
                const timer = setTimeout(() => {
                  resolve({ kind: "accepted", providerId: "slow-1", delivery: "queued" });
                }, 40);
                ctx.signal.addEventListener(
                  "abort",
                  () => {
                    adapterAborted = true;
                    clearTimeout(timer);
                    resolve({ kind: "unknown", reason: "aborted", cause: ctx.signal.reason });
                  },
                  { once: true },
                );
              });
            },
          },
        ],
      });

    // Leader aborts while peer stays active -> leader rejects aborted, peer resolves cleanly
    const c1 = makeSlowClient();
    const acLeader = new AbortController();
    const pLeader = c1.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-abort-1" }, { signal: acLeader.signal });
    const pPeer = c1.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-abort-1" });
    setTimeout(() => acLeader.abort(new Error("leader-cancel")), 5);
    const [rLeader, rPeer] = await Promise.allSettled([pLeader, pPeer]);
    expect(adapterCalls).toBe(1);
    expect(adapterAborted).toBe(false);
    expect(rLeader.status).toBe("rejected");
    if (rLeader.status === "rejected") {
      expect(rLeader.reason).toBeInstanceOf(HandoffUnknownError);
      expect((rLeader.reason as HandoffUnknownError).reason).toBe("aborted");
    }
    expect(rPeer.status).toBe("fulfilled");
    if (rPeer.status === "fulfilled") {
      expect(rPeer.value.providerId).toBe("slow-1");
    }

    // Peer aborts while leader stays active -> peer rejects aborted immediately, leader resolves cleanly
    adapterCalls = 0;
    const c2 = makeSlowClient();
    const acPeer = new AbortController();
    const pLeader2 = c2.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-abort-2" });
    const pPeer2 = c2.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-abort-2" }, { signal: acPeer.signal });
    setTimeout(() => acPeer.abort(new Error("peer-cancel")), 5);
    const [rLeader2, rPeer2] = await Promise.allSettled([pLeader2, pPeer2]);
    expect(adapterCalls).toBe(1);
    expect(adapterAborted).toBe(false);
    expect(rLeader2.status).toBe("fulfilled");
    expect(rPeer2.status).toBe("rejected");
    if (rPeer2.status === "rejected") {
      expect(rPeer2.reason).toBeInstanceOf(HandoffUnknownError);
      expect((rPeer2.reason as HandoffUnknownError).reason).toBe("aborted");
    }

    // Both abort -> underlying adapter signal aborts
    adapterCalls = 0;
    const c3 = makeSlowClient();
    const acA = new AbortController();
    const acB = new AbortController();
    const pA = c3.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-abort-3" }, { signal: acA.signal });
    const pB = c3.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-abort-3" }, { signal: acB.signal });
    setTimeout(() => {
      acA.abort();
      acB.abort();
    }, 5);
    const [rA, rB] = await Promise.allSettled([pA, pB]);
    expect(rA.status).toBe("rejected");
    expect(rB.status).toBe("rejected");
    expect(adapterAborted).toBe(true);

    // Same-tick immediate leader abort while peer joins -> peer still resolves cleanly
    adapterCalls = 0;
    adapterAborted = false;
    const c4 = makeSlowClient();
    const acImmediate = new AbortController();
    const pImmLeader = c4.send(
      { to: "+14155550123", body: "hi", idempotencyKey: "k-abort-4" },
      { signal: acImmediate.signal },
    );
    const pImmPeer = c4.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-abort-4" });
    acImmediate.abort(new Error("same-tick-leader"));
    const [rImmLeader, rImmPeer] = await Promise.allSettled([pImmLeader, pImmPeer]);
    expect(adapterCalls).toBe(1);
    expect(adapterAborted).toBe(false);
    expect(rImmLeader.status).toBe("rejected");
    expect(rImmPeer.status).toBe("fulfilled");
    if (rImmPeer.status === "fulfilled") {
      expect(rImmPeer.value.providerId).toBe("slow-1");
    }

    // Lone keyed caller abort mid-flight preserves attempts in HandoffUnknownError and frees key for immediate retry
    adapterCalls = 0;
    adapterAborted = false;
    const c5 = makeSlowClient();
    const acLone = new AbortController();
    const pLone = c5.send(
      { to: "+14155550123", body: "hi", idempotencyKey: "k-abort-5" },
      { signal: acLone.signal },
    );
    setTimeout(() => acLone.abort(new Error("lone-abort")), 5);
    const loneErr = await rejection(pLone);
    expect(loneErr).toBeInstanceOf(HandoffUnknownError);
    expect((loneErr as HandoffUnknownError).reason).toBe("aborted");
    expect((loneErr as HandoffUnknownError).attempts).toHaveLength(1);
    const retryRes = await c5.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-abort-5" });
    expect(retryRes.providerId).toBe("slow-1");
    expect(adapterCalls).toBe(2);

    // Lone keyed caller abort during retry backoff preserves SendAbortedError + attempts
    let backoffAttempts = 0;
    const failureCodes: string[] = [];
    const acBackoff = new AbortController();
    const c6 = createSmsClient({
      adapters: [
        {
          name: "rl",
          capabilities: memory().capabilities,
          support: { status: "supported", notes: [] },
          defaultFrom: "+15005550006",
          async send() {
            backoffAttempts += 1;
            setTimeout(() => acBackoff.abort(new Error("backoff-abort")), 10);
            return {
              kind: "rejected",
              category: "rate_limited",
              retryAfterMs: 500,
              details: { provider: "rl", httpStatus: 429, code: "429" },
            };
          },
        },
      ],
      retry: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 500 },
      hooks: {
        onFailure(event) {
          failureCodes.push(event.errorCode);
        },
      },
    });
    const backoffErr = await rejection(
      c6.send({ to: "+14155550123", body: "hi", idempotencyKey: "k-abort-6" }, { signal: acBackoff.signal }),
    );
    expect(backoffAttempts).toBe(1);
    expect(backoffErr).toBeInstanceOf(SendAbortedError);
    expect((backoffErr as SendAbortedError).attempts).toHaveLength(1);
    expect(((backoffErr as SendAbortedError).cause as Error).message).toBe("backoff-abort");
    expect(failureCodes).toEqual(["aborted"]);

    // R28: immediate peer abort rejects peer while leader succeeds (even on synchronous memory adapter)
    const syncClient = createSmsClient({ adapters: [memory()] });
    const acFastPeer = new AbortController();
    const fastInput = { to: "+14155550123" as const, body: "hi", idempotencyKey: "k-r28-peer" };
    const pFastLeader = syncClient.send(fastInput);
    const pFastPeer = syncClient.send(fastInput, { signal: acFastPeer.signal });
    acFastPeer.abort(new Error("fast-peer"));
    const [rFastLeader, rFastPeer] = await Promise.allSettled([pFastLeader, pFastPeer]);
    expect(rFastLeader.status).toBe("fulfilled");
    expect(rFastPeer.status).toBe("rejected");
    if (rFastPeer.status === "rejected") {
      expect(rFastPeer.reason).toBeInstanceOf(HandoffUnknownError);
      expect((rFastPeer.reason as HandoffUnknownError).reason).toBe("aborted");
    }

    // R28: same-tick leader abort + conflicting peer dispatches 0 adapter calls
    adapterCalls = 0;
    const cConflict = makeSlowClient();
    const acConflict = new AbortController();
    const pConfLeader = cConflict.send(
      { to: "+14155550123", body: "A", idempotencyKey: "k-r28-conflict" },
      { signal: acConflict.signal },
    );
    const pConfPeer = cConflict.send({ to: "+14155550123", body: "B", idempotencyKey: "k-r28-conflict" });
    acConflict.abort(new Error("abort-conflict-leader"));
    const [rConfLeader, rConfPeer] = await Promise.allSettled([pConfLeader, pConfPeer]);
    expect(adapterCalls).toBe(0);
    expect(rConfLeader.status).toBe("rejected");
    expect(rConfLeader.status === "rejected" && rConfLeader.reason).toBeInstanceOf(SendAbortedError);
    expect(rConfPeer.status).toBe("rejected");
    expect(rConfPeer.status === "rejected" && rConfPeer.reason).toBeInstanceOf(IdempotencyConflictError);

    // R28: both leader and matching peer abort in same tick -> 0 adapter calls, both reject
    adapterCalls = 0;
    const cBothImm = makeSlowClient();
    const acBoth1 = new AbortController();
    const acBoth2 = new AbortController();
    const pBoth1 = cBothImm.send(
      { to: "+14155550123", body: "same", idempotencyKey: "k-r28-both" },
      { signal: acBoth1.signal },
    );
    const pBoth2 = cBothImm.send(
      { to: "+14155550123", body: "same", idempotencyKey: "k-r28-both" },
      { signal: acBoth2.signal },
    );
    acBoth1.abort(new Error("both-1"));
    acBoth2.abort(new Error("both-2"));
    const [rBoth1, rBoth2] = await Promise.allSettled([pBoth1, pBoth2]);
    expect(adapterCalls).toBe(0);
    expect(rBoth1.status).toBe("rejected");
    expect(rBoth2.status).toBe("rejected");
    expect(rBoth2.status === "rejected" && rBoth2.reason).toBeInstanceOf(SendAbortedError);

    // R28: abort during async reserve() does not invoke beforeSend and finalizes as rejected
    let beforeSendCalls = 0;
    let finalizedState: string | undefined;
    let resolveReserve!: (value: { kind: "reserved"; reservationId: string }) => void;
    let markReserveStarted!: () => void;
    const reserveStarted = new Promise<void>((resolve) => {
      markReserveStarted = resolve;
    });
    const acReserve = new AbortController();
    const cReserve = createSmsClient({
      adapters: [memory()],
      beforeSend() {
        beforeSendCalls += 1;
        return { kind: "reject", reason: "should-not-run" };
      },
      idempotency: {
        store: {
          async get() {
            return null;
          },
          reserve() {
            markReserveStarted();
            return new Promise((resolve) => {
              resolveReserve = resolve;
            });
          },
          async finalize({ record }) {
            finalizedState = record.state;
            return { kind: "finalized" };
          },
        },
      },
    });
    const pReserve = cReserve.send(
      { to: "+14155550123", body: "hi", idempotencyKey: "k-r28-reserve" },
      { signal: acReserve.signal },
    );
    await reserveStarted;
    acReserve.abort(new Error("during-reserve"));
    resolveReserve({ kind: "reserved", reservationId: "res-1" });
    const reserveErr = await rejection(pReserve);
    expect(beforeSendCalls).toBe(0);
    expect(finalizedState).toBe("rejected");
    expect(reserveErr).toBeInstanceOf(SendAbortedError);

    // R28: HandoffUnknownError#toJSON includes reason and providerName, and overflowing Retry-After clamps finite so retry stops
    const hu = new HandoffUnknownError("timed out", {
      reason: "timeout",
      providerName: "twilio",
      attempts: [],
    });
    expect(hu.toJSON()).toMatchObject({ reason: "timeout", providerName: "twilio" });
    const { parseRetryAfter } = await import("../../src/core/http.js");
    const hugeRetry = parseRetryAfter("9".repeat(400));
    expect(hugeRetry).toBe(Number.MAX_SAFE_INTEGER);
  });
});
