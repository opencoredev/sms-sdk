# Changelog

## 0.2.0

### Minor Changes

- [#38](https://github.com/opencoredev/sms-sdk/pull/38) [`81a6aa9`](https://github.com/opencoredev/sms-sdk/commit/81a6aa97cfffa5d51472388e3fbbac34d85d8e3b) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Add `sms.getMessage()`, `parseSmsWebhooks()`, `fromByAdapter`, and suppression-list helpers, and reject invalid configuration and malformed input with typed errors.

  - `sms.getMessage(providerId, { adapter?, signal? })` looks a message up with the provider and returns its delivery status, or `undefined` when the provider has no such message. Failures throw `MessageLookupError` (`retrySafe: false`). Implemented for all six adapters through the new optional `SmsAdapter.getMessage`; a Vonage adapter with JWT auth needs `reportsCredentials`. `capabilities()` reports `messageLookup`.
  - `parseSmsWebhooks()` returns every event in a request: each element of a Bandwidth callback and each Sinch `recipient_delivery_report` entry. `parseSmsWebhook()` now throws `WebhookPayloadError` for a multi-event payload; it used to return the first Sinch report and drop the rest. Bandwidth status events now include the recipient in `dedupeKey` (`bandwidth:{messageId}:{to}:{type}`) so per-recipient status callbacks do not collide.
  - When one Bandwidth or Sinch callback carries several events, each event's `raw` holds only that event (its Bandwidth array element, or the Sinch body with just its report), so serializing the events does not repeat the batch.
  - `fromByAdapter` on `send()` input sets a sender per adapter for fallback chains.
  - `SuppressionList`, `memorySuppressionList()`, `suppressionPolicy()`, and `applySuppressionEvent()` connect STOP/START webhooks to `beforeSend`. `suppressionPolicy()` throws `ConfigurationError`, so nothing is sent, when `has()` returns anything other than a boolean.
  - Keyword events carry `mediaUrls`.
  - `createSmsClient` throws `ConfigurationError` for `idempotency.ttlSec` or `staleReservationSec` that are not positive integers of at least 1 second (`ttlSec: 0` let a repeated key send twice), `timeoutMs` above `2147483647`, malformed `idempotency`/`retry` objects or stores, `retry.maxAttempts` outside 1 to 10, and retry delays outside 0 to `2147483647`. `send()` throws `ConfigurationError` if `idempotency.store.reserve()` throws or returns a malformed record/result, and `memory()` / `memory().enqueue()` throw `ConfigurationError` for malformed options, capabilities, or outcomes. Sinch `expire_at` now anchors to `sendAt` when both `sendAt` and `validityPeriodSec` are set.
  - `validate()` returns issues instead of throwing for malformed runtime input, and `send()` throws `InvalidMessageError` for it. Custom `adapter.validate()` hooks fail closed with `InvalidMessageError` if they throw or return malformed/mutating issue objects, and `OPT_OUT_KEYWORDS` / `HELP_KEYWORDS` are frozen.
  - `createSmsClient`, all adapter factories (`twilio`, `telnyx`, `plivo`, `vonage`, `bandwidth`, `sinch`), `send()`, `getMessage()`, and the webhook parsers and verify helpers now fail closed with `ConfigurationError` for missing or malformed options, malformed adapters (including `capabilities.senderTypes`, `capabilities.validityPeriod`, and `providerOptions` specs), invalid `fallback`/`hooks`/`beforeSend`, invalid or non-http(s) `baseUrl` (including credentials, query, fragment, or Unicode whitespace/control characters) or `publicUrl` (including credentials, bare `?`, fragment, or Unicode whitespace/control characters; non-empty query strings remain supported), invalid Vonage `region`, non-function `fetch` or `now`, spoofed or non-`AbortSignal` `signal`, dot-segment `providerId` (`"."` or `".."`), missing/malformed/locked webhook `request`, unsupported webhook `provider`, empty Basic/HMAC/verify-helper secrets, invalid or non-http(s) URLs in Twilio/Plivo verify/compute helpers, unknown Sinch webhook `credentials.kind`, non-Latin-1 Basic credentials, and invalid `toleranceSec` (`NaN`, non-finite, negative, or non-number). `MessageLookupError#toJSON()`, `WebhookSignatureError#toJSON()`, `WebhookPayloadError#toJSON()`, and `HandoffUnknownError#toJSON()` now include `providerName` and `reason` when present. `SinchWebhookVerification` is exported from `@opencoredev/sms-sdk/webhooks`. Twilio error code `30007` maps to `filtered`, Sinch `Rejected` delivery status now maps to `undelivered` unless the provider error code is `40003` (`filtered`), and each Sinch `recipient_delivery_report` event takes `occurredAt` from that report's `at`.
  - Plivo `rejected` status maps to `undelivered` in webhooks and `getMessage()`, and placeholder `ErrorCode`/`error_code` `000` is omitted.
  - `beforeSend` fails closed with `PolicyRejectedError` on malformed or unrecognized decisions without stranding idempotency reservations, and throwing inside `beforeSend` emits `onFailure`. An unexpected internal failure keeps the attempts made.
  - `unsafeSkipVerification` throws `ConfigurationError` when `NODE_ENV` is `production`.
  - Provider responses and inbound webhook request bodies are read up to 1 MiB; an oversized provider response is an unknown outcome, an oversized webhook body throws `WebhookPayloadError` (`reason: "body_too_large"`) before signature verification, and an aborted or unreadable webhook body stream throws `WebhookPayloadError` (`reason: "body_unreadable"`).
  - Every subpath export adds a `default` condition beside `import`. The package stays ESM only.
  - `send()`, `validate()`, `createSmsClient()`, adapter factories, and webhook parsers snapshot caller-supplied inputs and options upfront (preserving class-instance `hooks`, `fromByAdapter`, and factory/sender getters), deep-freeze exported capability constants and `capabilities()`/`defaultFrom` copies, validate `Date` and `RegExp` brand slots, require plain objects for `providerOptions` entries and `extra`, trim only HTTP OWS around `trustProxy` headers, and treat non-string `verifyTelnyxSignature`/`verifySinchSignature` inputs as invalid signatures.
  - Provider error details (`error.provider.code`, `error.provider.requestId`) and serialized `providerName` fields are sanitized in `SmsError#toJSON()` and diagnostic messages to keep compact structural tokens and opaque hex IDs (UUIDs and 32-hex provider IDs) while dropping free-form text, credential-shaped tokens (`sk-live-...`, `user:secret`, `secret_token_...`), and phone-length digit runs; in-memory `error.providerName` keeps the registered adapter name and `SmsError#toJSON()` clones `attempts` and `provider`.
  - Concurrent `send()` calls with the same `idempotencyKey` coalesce synchronously before fingerprinting, isolate returned results per caller, and scope `AbortSignal` cancellation per caller so one caller aborting does not cancel an active peer's in-flight request (returning `SendAbortedError` when the shared send stops during rate-limit backoff or ends in a proven rejection, and `HandoffUnknownError` when acceptance or an unknown outcome is reached or another caller keeps the send going). `SendAbortedError` and `HandoffUnknownError` preserve each caller's `signal.reason` as `cause`.
  - `Retry-After` header parsing enforces strict RFC 9110 delta-seconds and calendar-exact HTTP-dates (IMF-fixdate, RFC 850 with the 50-year rule, and asctime), Sinch rejects overflowing `sendAt + validityPeriodSec` timestamps during validation, and overflowing `Retry-After` values stop retrying instead of falling back to backoff.
  - Workspace hygiene: removes stale reference copies of sibling products (`packages/email-sdk`, `packages/sandbox-sdk`, `skills/sandbox-sdk`) from this repository and renames the internal workspace config package from `@email-sdk/config` to `@sms-sdk/config`.

### Patch Changes

- [#5](https://github.com/opencoredev/sms-sdk/pull/5) [`8a0a5a4`](https://github.com/opencoredev/sms-sdk/commit/8a0a5a4861e79501c1f132a1cde0a6cfdf716a1c) Thanks [@leoisadev1](https://github.com/leoisadev1)! - Point the package homepage and README links at the docs site's own domain, www.sms-sdk.com.

## 0.1.1

### Patch Changes

- [`a321c5a`](https://github.com/opencoredev/sms-sdk/commit/a321c5abb26c50c5c066b44a898acf876e63d1d2) - Add the docs site as the package homepage and the SMS SDK banner to the README, and point its Contributing and Examples links at GitHub.

- [`acf9943`](https://github.com/opencoredev/sms-sdk/commit/acf9943ed11d320e5ef8f68013dd5f7869ec0877) - README: explain why Bandwidth and Sinch are partial, and list which providers have signed webhook request builders.

## 0.1.0

First public version.

- `providerOptions` on `send()` input: typed, per-adapter provider parameters (`{ twilio: { shortenUrls: true }, telnyx: { autoDetect: true } }`) plus an unvalidated `extra` passthrough. Each adapter subpath adds its key by module augmentation of `SmsProviderOptions`, which is declared in the package root so custom adapters can augment it too. Unknown keys, wrong types, and fields the SDK sets throw before any request; options apply only to their own adapter, are listed in `validate().providerOptionsFor`, and are part of the idempotency fingerprint. Adapters declare accepted options with `SmsAdapter.providerOptions` and receive them as `AdapterMessage.providerFields`.
- `createSmsClient` with `send()`, `validate()`, and `capabilities()`. `send()` resolves only on provider acceptance; rejections and unknown outcomes throw typed errors with `code`, `retrySafe`, and redacted `attempts`.
- Adapters: Twilio (supported), Telnyx (supported), Plivo (partial), Vonage Messages API with Basic or JWT auth (partial), Bandwidth (partial), and Sinch (partial). See PROVIDERS.md.
- Opt-in fallback (`fallback: "on-known-rejection"`) for auth, rate-limit, sender, and account rejections only. Never after unknown outcomes.
- Rate-limit retries with exponential backoff, full jitter, and bounded `Retry-After`. A 429 counts as a rate limit only when the body carries the provider's documented rate-limit error; a bare 429 is an unknown outcome. Per-request timeout and `AbortSignal` support.
- Idempotency store contract with atomic `reserve` and owner-checked `finalize`, plus `memoryIdempotencyStore()`.
- GSM-7 and UCS-2 segment estimates, including extension characters and surrogate pairs at segment boundaries.
- `/webhooks`: verified, normalized events for all six providers, with dedupe keys and STOP/HELP detection. Bandwidth requires the Basic credentials set on your Bandwidth application; Sinch takes Basic credentials or an HMAC secret.
- `/testing`: `memory()` adapter, `mockFetch()`, signed webhook request builders for Twilio, Telnyx, Plivo, and Vonage, and `runSmsAdapterContract()`.
- `sms-sdk doctor`: dry-run configuration check with a gated `--live` send.
