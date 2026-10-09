# Changelog

## 0.1.0

First public version.

- `providerOptions` on `send()` input: typed, per-adapter provider parameters (`{ twilio: { shortenUrls: true }, telnyx: { autoDetect: true } }`) plus an unvalidated `extra` passthrough. Each adapter subpath adds its key by module augmentation of `SmsProviderOptions`. Unknown keys, wrong types, and fields the SDK sets throw before any request; options apply only to their own adapter, are listed in `validate().providerOptionsFor`, and are part of the idempotency fingerprint. Adapters declare accepted options with `SmsAdapter.providerOptions` and receive them as `AdapterMessage.providerFields`.
- `createSmsClient` with `send()`, `validate()`, and `capabilities()`. `send()` resolves only on provider acceptance; rejections and unknown outcomes throw typed errors with `code`, `retrySafe`, and redacted `attempts`.
- Adapters: Twilio (supported), Telnyx (supported), Plivo (partial), Vonage Messages API with Basic or JWT auth (partial). See PROVIDERS.md.
- Opt-in fallback (`fallback: "on-known-rejection"`) for auth, rate-limit, sender, and account rejections only. Never after unknown outcomes.
- Rate-limit retries with exponential backoff, full jitter, and bounded `Retry-After`. A 429 counts as a rate limit only when the body carries the provider's documented rate-limit error; a bare 429 is an unknown outcome. Per-request timeout and `AbortSignal` support.
- Idempotency store contract with atomic `reserve` and owner-checked `finalize`, plus `memoryIdempotencyStore()`.
- GSM-7 and UCS-2 segment estimates, including extension characters and surrogate pairs at segment boundaries.
- `/webhooks`: verified, normalized events for all four providers, with dedupe keys and STOP/HELP detection.
- `/testing`: `memory()` adapter, `mockFetch()`, signed webhook request builders, and `runSmsAdapterContract()`.
- `sms-sdk doctor`: dry-run configuration check with a gated `--live` send.
