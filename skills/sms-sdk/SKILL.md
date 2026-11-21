---
name: sms-sdk
description: Use when sending or receiving SMS from a TypeScript server with @opencoredev/sms-sdk, choosing or switching between Twilio, Telnyx, Plivo, Vonage, Bandwidth, and Sinch, handling send errors, idempotency, fallback, webhooks, or STOP/HELP opt-outs.
---

# SMS SDK

`@opencoredev/sms-sdk` sends SMS through Twilio, Telnyx, Plivo, Vonage, Bandwidth, or Sinch with one `send()`, and verifies and normalizes their webhooks. Zero runtime dependencies, ESM only, Node.js 20+ and Bun, server-side only.

## Start here

1. Fetch `https://www.sms-sdk.com/llms.txt` for the page list.
2. Read the quick start and the one provider page you need. Append `.md` to any docs URL for Markdown.
3. Read a reference page (`/reference/send`, `/reference/errors`, `/reference/webhook-events`) only when the task needs it.

## Default implementation

```ts
import { createSmsClient, HandoffUnknownError, memoryIdempotencyStore } from "@opencoredev/sms-sdk";
import { twilio } from "@opencoredev/sms-sdk/twilio";

const sms = createSmsClient({
  adapters: [
    twilio({ accountSid: process.env.TWILIO_ACCOUNT_SID ?? "", authToken: process.env.TWILIO_AUTH_TOKEN ?? "", from: "+15005550006" }),
  ],
  idempotency: { store: memoryIdempotencyStore() }, // use a shared store (Postgres, Redis) with more than one process
});

try {
  const result = await sms.send({ to: "+14155550123", body: "Your code is 123456.", idempotencyKey: "otp:user-1:2026-11-21T10:00" });
  console.log(result.provider, result.providerId, result.delivery); // delivery is "queued": accepted, not delivered
} catch (error) {
  if (error instanceof HandoffUnknownError) {
    // The message may have gone out. Never resend automatically.
  }
  throw error;
}
```

Import each adapter from its own subpath: `/twilio`, `/telnyx`, `/plivo`, `/vonage`, `/bandwidth`, `/sinch`. Webhooks are in `/webhooks`, test helpers in `/testing`.

## Rules

- `send()` resolves only when a provider accepted the message. Accepted is not delivered; delivery arrives by webhook or `sms.getMessage(providerId, { adapter })`.
- Check `error.retrySafe` before sending again. `HandoffUnknownError` is `retrySafe: false`: the outcome is unknown, so reconcile with the provider first and never retry it in a loop.
- Set `idempotencyKey` per logical message (not per attempt) and give the client an idempotency store. Without a store, the client only coalesces concurrent calls with the same key; later calls can send again.
- Fallback is off until `fallback: "on-known-rejection"`. It runs only after `auth`, `rate_limited`, `sender`, or `account` rejections, never after an unknown outcome or a `compliance` (opt-out) rejection. With fallback, set senders per adapter with `fromByAdapter` or each adapter's `from`.
- Pass `providerOptions: { twilio: { ... } }` for provider-only parameters. Unknown keys throw before any request.
- Call `sms.validate(input)` for a free local preflight: E.164, sender, capabilities, and segment estimate.
- Parse webhooks with `parseSmsWebhook()`, or `parseSmsWebhooks()` for Bandwidth and Sinch, which can batch several events per request. Pass the raw `Request` before reading its body. Store each `event.dedupeKey` and skip repeats; never assume order.
- Behind a proxy, pass `publicUrl` for Twilio and Plivo. Set `trustProxy: true` only when your own proxy sets `X-Forwarded-Host`.
- Never set `unsafeSkipVerification` outside unit tests; it throws in production. Use the signed request builders from `/testing` instead.
- Keep one suppression list across providers: `suppressionPolicy(list)` as `beforeSend`, and `applySuppressionEvent(list, event)` for each webhook event. Also add the number when a send is rejected with `category: "compliance"`.
- In tests, use `memory()` and `mockFetch()` from `/testing`. Nothing there touches the network.
- Bandwidth, Sinch, Plivo, and Vonage are `partial`; read `sms.capabilities()` or the provider page for what is not confirmed.

## Focused Markdown

Fetch one page as Markdown by appending `.md` to its URL, for example `https://www.sms-sdk.com/reference/errors.md`. The docs also run an MCP server at `https://www.sms-sdk.com/mcp`.
