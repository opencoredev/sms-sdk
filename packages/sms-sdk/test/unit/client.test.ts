import { describe, expect, test } from "bun:test";
import { createSmsClient } from "../../src/core/client.js";
import {
  AllProvidersRejectedError,
  ConfigurationError,
  HandoffUnknownError,
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
  });
});
