# SMS SDK

One TypeScript SDK for SMS providers. Send through Twilio, Telnyx, Plivo, or Vonage with one `send()` call, fail over only when a provider proves it rejected the message, and verify webhooks from all four.

Zero runtime dependencies. ESM. Node 20+ and Bun. Server-side only.

```bash
npm install @opencoredev/sms-sdk
```

## Send a message

```ts
import { createSmsClient } from "@opencoredev/sms-sdk";
import { twilio } from "@opencoredev/sms-sdk/twilio";

const sms = createSmsClient({
  adapters: [
    twilio({
      accountSid: process.env.TWILIO_ACCOUNT_SID!,
      authToken: process.env.TWILIO_AUTH_TOKEN!,
      from: "+15005550006", // a number provisioned on your Twilio account
    }),
  ],
});

const result = await sms.send({
  to: "+14155550123",
  body: "Your order has shipped.",
});

console.log(result.providerId, result.handoff, result.delivery); // "SM...", "accepted", "queued"
```

`send()` resolves only when the provider accepted the message. Acceptance means the provider queued it, not that a phone received it; delivery arrives later through a status webhook.

## Switch providers

The call site stays the same. Only the adapter changes:

```diff
- import { twilio } from "@opencoredev/sms-sdk/twilio";
+ import { telnyx } from "@opencoredev/sms-sdk/telnyx";

  const sms = createSmsClient({
    adapters: [
-     twilio({ accountSid, authToken, from: "+15005550006" }),
+     telnyx({ apiKey, from: "+15005550007" }),
    ],
  });

  await sms.send({ to: "+14155550123", body: "Your order has shipped." });
```

Switching providers still needs provider-side work: a sender provisioned on the new provider, any 10DLC or toll-free registration, and new webhook URLs. The SDK does not move numbers or registrations.

## Fail over safely

```ts
const sms = createSmsClient({
  adapters: [
    twilio({ accountSid, authToken, from: "+15005550006" }),
    telnyx({ apiKey, from: "+15005550007" }),
  ],
  fallback: "on-known-rejection",
});
```

Fallback is off by default. With `"on-known-rejection"` the client moves to the next adapter only after a rejection the provider proved, and only for rejections another provider might accept: bad credentials, rate limits, sender problems, and account problems. It never fails over for an invalid recipient, an opt-out or block, or a malformed request.

It never fails over or retries after a timeout, network error, 5xx, or unreadable response. The provider may have accepted the message, so the client throws `HandoffUnknownError` with `retrySafe: false`. Check the provider before resending.

| Outcome | What `send()` does | `retrySafe` |
|---|---|---|
| Provider accepted | resolves `{ handoff: "accepted" }` | – |
| Provider proved a rejection | throws `ProviderRejectedError` (or `ProviderAuthError`, `ProviderRateLimitedError`); with fallback, `AllProvidersRejectedError` | `true` |
| Outcome unknown | throws `HandoffUnknownError`; no retry, no fallback | `false` |
| Invalid input or unsupported field | throws before any request | `true` |

Rate-limit rejections are retried on the same adapter with exponential backoff and jitter, honoring `Retry-After` up to `retry.maxDelayMs`.

## Preview encoding and segments

```ts
const preview = sms.validate({ to: "+14155550123", body: "Your package is ready 📦" });
// { supported: true, encoding: "ucs2", segments: 1, units: 24, issues: [], adapterCandidates: ["twilio", "telnyx"], ... }
```

`validate()` is local and free. It checks E.164, the sender, adapter capabilities, and estimates GSM-7 or UCS-2 segments. Segment counts are estimates of billed units, not price quotes. Unsupported fields such as `mediaUrls`, `sendAt`, `validityPeriodSec`, `webhookUrl`, or a sender type the adapter lacks throw `UnsupportedFieldError` before any request.

## Idempotency

```ts
import { createSmsClient, memoryIdempotencyStore } from "@opencoredev/sms-sdk";

const sms = createSmsClient({ adapters, idempotency: { store: memoryIdempotencyStore() } });
await sms.send({ to, body, idempotencyKey: "order:123:shipped:v1" });
```

With a store, a repeated key returns the first result without sending again, a reused key with a different message throws `IdempotencyConflictError`, and an unknown outcome stays unknown instead of being resent. The memory store protects one process. For several instances, implement `IdempotencyStore` with an atomic `reserve` on your database. None of the four providers documents send idempotency, so exactly-once delivery is not possible after a crash mid-request.

## Webhooks

```ts
import { parseSmsWebhook, WebhookSignatureError } from "@opencoredev/sms-sdk/webhooks";

export async function POST(request: Request): Promise<Response> {
  try {
    const event = await parseSmsWebhook({
      provider: "twilio",
      request,
      publicUrl: "https://example.com/api/webhooks/twilio",
      credentials: { authToken: process.env.TWILIO_AUTH_TOKEN! },
    });
    if (event.type === "message.delivered") {
      // mark event.providerId delivered; skip repeats with event.dedupeKey
    }
    if (event.type === "recipient.opted_out") {
      // suppress event.from
    }
    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof WebhookSignatureError) return new Response(null, { status: 401 });
    throw error;
  }
}
```

The parser reads the raw body once and verifies the signature before reading any field. Events are normalized to `message.received`, `message.queued`/`sent`/`delivered`/`undelivered`/`filtered`, `recipient.opted_out`/`opted_in`/`help`, or `unrecognized`. STOP and HELP come from provider signals first (Twilio Advanced Opt-Out) and otherwise from whole-message keyword matching, marked `source: "keyword"`. The SDK never replies automatically.

## Providers

| Provider | Status | API | Senders | MMS | Scheduling | Validity | Webhooks |
|---|---|---|---|---|---|---|---|
| Twilio | supported | Messages `2010-04-01` | long code, toll-free, short code, alphanumeric, Messaging Service | yes | yes (Messaging Service) | 1-36000 s | HMAC-SHA1 |
| Telnyx | supported | Messaging v2 | long code, toll-free, short code, alphanumeric, messaging profile | yes | yes | no | Ed25519 |
| Plivo | partial | Message API | long code, toll-free, short code, alphanumeric, Powerpack | yes | no | 5-10799 s | HMAC-SHA256 V2 |
| Vonage | partial | Messages API v1 | long code, toll-free, alphanumeric | no | no | 20-604800 s | HS256 JWT (JWT auth only) |

Plivo and Vonage are partial because parts of their error responses are undocumented, so fewer rejections can be classified for fallback. [PROVIDERS.md](./PROVIDERS.md) lists every fact used, its source, and what could not be confirmed.

Sender availability also depends on country, registration, and account state. Capability flags are a baseline, not a promise that a route works.

## Testing

```ts
import { createSmsClient } from "@opencoredev/sms-sdk";
import { memory, rejectedOutcome } from "@opencoredev/sms-sdk/testing";

const adapter = memory({ outcomes: [rejectedOutcome("sender")] });
const sms = createSmsClient({ adapters: [adapter] });
// adapter.sent records every send; nothing touches the network
```

`/testing` also has `mockFetch()`, signed webhook request builders for all four providers, and `runSmsAdapterContract()` for adapter authors.

## Doctor

```bash
npx @opencoredev/sms-sdk doctor --adapter twilio --body "Hello 📦"
```

The default dry run makes no network calls. It checks environment variables, configuration, sender format, and the segment estimate, and reports credentials, registration, and webhook reachability as "not verified". `--live` sends one billable message and requires `--to`, `--confirm-to`, and `--confirm-from`.

## Compliance

The SDK can parse opt-outs and block sends through `beforeSend`, but your application owns consent records, suppression lists, quiet hours, US A2P 10DLC and toll-free verification, and local rules. Rules vary by country and carrier and change over time. Errors and hook payloads mask phone numbers and never include message bodies or credentials.

## Links

- [Provider evidence](./PROVIDERS.md)
- [Contributing and adding an adapter](./CONTRIBUTING.md)
- [Changelog](./CHANGELOG.md)
- [Examples](./examples)
- [GitHub](https://github.com/opencoredev/sms-sdk)

MIT License.
