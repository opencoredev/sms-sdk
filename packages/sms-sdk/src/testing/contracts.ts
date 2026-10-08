import type {
  AdapterMessage,
  AdapterSendOutcome,
  Delivery,
  RejectionCategory,
  SmsAdapter,
  SmsCapabilities,
} from "../core/adapters.js";
import { createSmsClient } from "../core/client.js";
import { isFallbackEligible, UnsupportedFieldError, WebhookSignatureError } from "../core/errors.js";
import type { FetchLike } from "../core/http.js";
import type { SmsSendInput } from "../core/types.js";
import type { SmsEvent } from "../webhooks/events.js";
import { mockFetch, type MockReply, type MockResponse, type RecordedRequest } from "./fetch.js";

/** Builds the adapter under test around a fake `fetch`. */
export type AdapterFactory = (fetch: FetchLike) => SmsAdapter;

/** Expected request body. `form` and `json` must match exactly. */
export type ExpectedBody =
  | { readonly kind: "form"; readonly params: Readonly<Record<string, string | readonly string[]>> }
  | { readonly kind: "json"; readonly value: unknown };

/** A webhook case: build a signed request and the event fields it must produce. */
export type WebhookContractCase = {
  readonly name: string;
  readonly request: () => Promise<Request>;
  /** Fields the parsed event must contain (compared with deep equality per field). */
  readonly expected: Readonly<Record<string, unknown>> & { readonly type: SmsEvent["type"] };
};

/** Fixtures that describe one adapter's documented HTTP behavior. */
export type AdapterContractFixtures = {
  /** A message the adapter supports. */
  readonly message: AdapterMessage;
  /** The exact request the adapter must make for `message`. */
  readonly request: {
    readonly url: string;
    /** Headers that must be present (names compared case-insensitively). */
    readonly headers: Readonly<Record<string, string>>;
    readonly body: ExpectedBody;
  };
  readonly accepted: { readonly response: MockResponse; readonly providerId: string; readonly delivery: Delivery };
  /** A documented rejection that must not trigger fallback. */
  readonly permanentRejection: { readonly response: MockResponse; readonly category: RejectionCategory };
  /** A documented rejection that may trigger fallback (sender, account, or auth). */
  readonly eligibleRejection: { readonly response: MockResponse; readonly category: RejectionCategory };
  /** A documented rate-limit rejection. */
  readonly rateLimited: { readonly response: MockResponse; readonly retryAfterMs?: number };
  /** A 2xx response that does not prove acceptance (for example, missing the message ID). */
  readonly malformedSuccess: MockResponse;
  /** A 5xx response. */
  readonly serverError: MockResponse;
  /** Webhook checks, when the adapter's provider has a parser. */
  readonly webhooks?: {
    readonly parse: (request: Request) => Promise<SmsEvent>;
    readonly cases: readonly WebhookContractCase[];
    /** A request whose body or signature was altered after signing. */
    readonly tampered: () => Promise<Request>;
  };
};

/** One named contract check. `run` throws a descriptive error on failure. */
export type ContractCase = { readonly name: string; readonly run: () => Promise<void> };

/** Result of {@link runSmsAdapterContract}. */
export type ContractReport = {
  readonly adapter: string;
  readonly passed: boolean;
  readonly results: ReadonlyArray<{ readonly name: string; readonly passed: boolean; readonly error?: string }>;
};

/**
 * Returns the contract checks as separate cases, so each can be registered
 * with a test runner:
 *
 * ```ts
 * for (const check of smsAdapterContractCases(factory, fixtures)) {
 *   test(check.name, check.run);
 * }
 * ```
 */
export function smsAdapterContractCases(factory: AdapterFactory, fixtures: AdapterContractFixtures): ContractCase[] {
  const adapterName = factory(mockFetch({ status: 500 }).fetch).name;
  const named = (name: string, run: () => Promise<void>): ContractCase => ({ name: `${adapterName}: ${name}`, run });

  const cases: ContractCase[] = [
    named("declares consistent capabilities", async () => {
      checkCapabilities(factory(mockFetch({ status: 500 }).fetch));
    }),

    named("builds the documented request", async () => {
      const mock = mockFetch(fixtures.accepted.response);
      await sendOnce(factory(mock.fetch), fixtures.message);
      const [call] = mock.calls;
      assert(call !== undefined && mock.calls.length === 1, `expected exactly 1 request, got ${mock.calls.length}`);
      checkRequest(call, fixtures.request);
    }),

    named("passes the abort signal to fetch", async () => {
      const mock = mockFetch(fixtures.accepted.response);
      const controller = new AbortController();
      await factory(mock.fetch).send(fixtures.message, { signal: controller.signal, attempt: 1 });
      assert(mock.calls[0]?.signal === controller.signal, "fetch must receive context.signal");
    }),

    named("normalizes an accepted response", async () => {
      const outcome = await sendOnce(factory(mockFetch(fixtures.accepted.response).fetch), fixtures.message);
      assert(outcome.kind === "accepted", `expected accepted, got ${describe(outcome)}`);
      assertEqual(outcome.providerId, fixtures.accepted.providerId, "providerId");
      assertEqual(outcome.delivery, fixtures.accepted.delivery, "delivery");
    }),

    named("maps a permanent rejection without fallback", async () => {
      const outcome = await sendOnce(factory(mockFetch(fixtures.permanentRejection.response).fetch), fixtures.message);
      assert(outcome.kind === "rejected", `expected rejected, got ${describe(outcome)}`);
      assertEqual(outcome.category, fixtures.permanentRejection.category, "category");
      assert(!isFallbackEligible(outcome.category), `${outcome.category} must not be fallback-eligible`);
      assertEqual(outcome.details.provider, adapterName, "details.provider");
    }),

    named("maps an eligible rejection", async () => {
      const outcome = await sendOnce(factory(mockFetch(fixtures.eligibleRejection.response).fetch), fixtures.message);
      assert(outcome.kind === "rejected", `expected rejected, got ${describe(outcome)}`);
      assertEqual(outcome.category, fixtures.eligibleRejection.category, "category");
      assert(isFallbackEligible(outcome.category), `${outcome.category} must be fallback-eligible`);
    }),

    named("maps a confirmed rate limit", async () => {
      const outcome = await sendOnce(factory(mockFetch(fixtures.rateLimited.response).fetch), fixtures.message);
      assert(outcome.kind === "rejected", `expected rejected, got ${describe(outcome)}`);
      assertEqual(outcome.category, "rate_limited", "category");
      assertEqual(outcome.retryAfterMs, fixtures.rateLimited.retryAfterMs, "retryAfterMs");
    }),

    named("treats a network error as unknown", async () => {
      const outcome = await sendOnce(factory(mockFetch({ throws: new TypeError("fetch failed") }).fetch), fixtures.message);
      assert(outcome.kind === "unknown", `expected unknown, got ${describe(outcome)}`);
    }),

    named("treats an aborted in-flight request as unknown", async () => {
      const controller = new AbortController();
      const pending = factory(mockFetch({ hangUntilAborted: true }).fetch).send(fixtures.message, {
        signal: controller.signal,
        attempt: 1,
      });
      controller.abort(new DOMException("timed out", "TimeoutError"));
      const outcome = await pending;
      assert(outcome.kind === "unknown", `expected unknown, got ${describe(outcome)}`);
    }),

    named("treats a malformed 2xx as unknown", async () => {
      const outcome = await sendOnce(factory(mockFetch(fixtures.malformedSuccess).fetch), fixtures.message);
      assert(outcome.kind === "unknown", `expected unknown, got ${describe(outcome)}`);
    }),

    named("treats a non-JSON 2xx as unknown", async () => {
      const reply: MockReply = { status: 200, body: "<html>ok</html>", headers: { "content-type": "text/html" } };
      const outcome = await sendOnce(factory(mockFetch(reply).fetch), fixtures.message);
      assert(outcome.kind === "unknown", `expected unknown, got ${describe(outcome)}`);
    }),

    named("treats a 5xx as unknown", async () => {
      const outcome = await sendOnce(factory(mockFetch(fixtures.serverError).fetch), fixtures.message);
      assert(outcome.kind === "unknown", `expected unknown, got ${describe(outcome)}`);
    }),

    named("rejects undeclared capabilities before fetch", async () => {
      const mock = mockFetch(fixtures.accepted.response);
      const adapter = factory(mock.fetch);
      const sms = createSmsClient({ adapters: [adapter] });
      for (const input of unsupportedInputs(adapter.capabilities, fixtures.message)) {
        const error = await sms.send(input).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        assert(error instanceof UnsupportedFieldError, `expected UnsupportedFieldError, got ${String(error)}`);
      }
      assertEqual(mock.calls.length, 0, "requests made for unsupported fields");
    }),
  ];

  const webhooks = fixtures.webhooks;
  if (webhooks !== undefined) {
    for (const webhookCase of webhooks.cases) {
      cases.push(
        named(`webhook: ${webhookCase.name}`, async () => {
          const event = await webhooks.parse(await webhookCase.request());
          for (const [key, value] of Object.entries(webhookCase.expected)) {
            const actual: unknown = Object.entries(event).find(([eventKey]) => eventKey === key)?.[1];
            assertEqual(JSON.stringify(actual), JSON.stringify(value), `event.${key}`);
          }
        }),
      );
    }
    cases.push(
      named("webhook: rejects a tampered request", async () => {
        const error = await webhooks.parse(await webhooks.tampered()).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        assert(error instanceof WebhookSignatureError, `expected WebhookSignatureError, got ${String(error)}`);
      }),
    );
  }

  return cases;
}

/**
 * Runs every contract check and returns a report instead of throwing. Works
 * with any test runner:
 *
 * ```ts
 * const report = await runSmsAdapterContract(factory, fixtures);
 * expect(report.results.filter((r) => !r.passed)).toEqual([]);
 * ```
 */
export async function runSmsAdapterContract(
  factory: AdapterFactory,
  fixtures: AdapterContractFixtures,
): Promise<ContractReport> {
  const results: Array<{ name: string; passed: boolean; error?: string }> = [];
  for (const check of smsAdapterContractCases(factory, fixtures)) {
    try {
      await check.run();
      results.push({ name: check.name, passed: true });
    } catch (error) {
      results.push({ name: check.name, passed: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return {
    adapter: factory(mockFetch({ status: 500 }).fetch).name,
    passed: results.every((result) => result.passed),
    results,
  };
}

function sendOnce(adapter: SmsAdapter, message: AdapterMessage): Promise<AdapterSendOutcome> {
  return adapter.send(message, { signal: new AbortController().signal, attempt: 1 });
}

function checkCapabilities(adapter: SmsAdapter): void {
  const capabilities: SmsCapabilities = adapter.capabilities;
  assert(/^[a-z][a-z0-9-]*$/.test(adapter.name), `adapter name "${adapter.name}" must be lowercase`);
  assert(capabilities.sendText, "sendText must be true");
  assert(capabilities.senderTypes.length > 0, "senderTypes must not be empty");
  assertEqual(new Set(capabilities.senderTypes).size, capabilities.senderTypes.length, "unique senderTypes");
  const range = capabilities.validityPeriod;
  if (range !== null) {
    assert(
      Number.isInteger(range.minSec) && Number.isInteger(range.maxSec) && range.minSec > 0 && range.minSec <= range.maxSec,
      "validityPeriod must be a positive integer range",
    );
  }
  assert(
    adapter.support.status === "supported" || adapter.support.notes.length > 0,
    "partial adapters must explain why in support.notes",
  );
}

function checkRequest(call: RecordedRequest, expected: AdapterContractFixtures["request"]): void {
  assertEqual(call.method, "POST", "method");
  assertEqual(call.url, expected.url, "url");
  for (const [name, value] of Object.entries(expected.headers)) {
    assertEqual(call.headers[name.toLowerCase()], value, `header ${name}`);
  }
  if (expected.body.kind === "json") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(call.body);
    } catch {
      throw new Error("request body is not JSON");
    }
    assertEqual(JSON.stringify(sortKeys(parsed)), JSON.stringify(sortKeys(expected.body.value)), "json body");
    return;
  }
  const actual = new URLSearchParams(call.body);
  const actualKeys = [...new Set(actual.keys())].sort();
  assertEqual(actualKeys.join(","), Object.keys(expected.body.params).sort().join(","), "form keys");
  for (const [key, value] of Object.entries(expected.body.params)) {
    const expectedValues = typeof value === "string" ? [value] : [...value];
    assertEqual(actual.getAll(key).join("\n"), expectedValues.join("\n"), `form field ${key}`);
  }
}

function unsupportedInputs(capabilities: SmsCapabilities, message: AdapterMessage): SmsSendInput[] {
  const base: SmsSendInput = { to: message.to, body: "contract", from: "+15005550006" };
  const inputs: SmsSendInput[] = [];
  if (!capabilities.mms) {
    inputs.push({ ...base, mediaUrls: ["https://example.com/a.png"] });
  }
  if (!capabilities.scheduling) {
    inputs.push({ ...base, sendAt: new Date(Date.now() + 3_600_000) });
  }
  if (capabilities.validityPeriod === null) {
    inputs.push({ ...base, validityPeriodSec: 600 });
  }
  if (!capabilities.webhookUrlOverride) {
    inputs.push({ ...base, webhookUrl: "https://example.com/status" });
  }
  if (!capabilities.senderTypes.includes("short_code")) {
    inputs.push({ ...base, from: { shortCode: "12345" } });
  }
  if (!capabilities.senderTypes.includes("alphanumeric")) {
    inputs.push({ ...base, from: { senderId: "Acme" } });
  }
  if (!capabilities.senderTypes.includes("messaging_service")) {
    inputs.push({ ...base, from: { messagingService: "service-1" } });
  }
  return inputs;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, sortKeys(child)]),
    );
  }
  return value;
}

function describe(outcome: AdapterSendOutcome): string {
  switch (outcome.kind) {
    case "accepted":
      return "accepted";
    case "rejected":
      return `rejected (${outcome.category})`;
    case "unknown":
      return `unknown (${outcome.reason})`;
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}
