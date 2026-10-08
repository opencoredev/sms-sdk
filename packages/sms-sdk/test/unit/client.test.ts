import { describe, expect, test } from "bun:test";
import { createSmsClient } from "../../src/core/client.js";
import {
  AllProvidersRejectedError,
  HandoffUnknownError,
  PolicyRejectedError,
  ProviderAuthError,
  ProviderRateLimitedError,
  ProviderRejectedError,
  SendAbortedError,
} from "../../src/core/errors.js";
import type { SmsAcceptedEvent, SmsAttemptEvent, SmsFailureEvent } from "../../src/core/events.js";
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
