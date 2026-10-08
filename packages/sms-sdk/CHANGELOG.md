# Changelog

## 0.1.0 (unreleased)

First public version.

- `createSmsClient` with `send()`, `validate()`, and `capabilities()`. `send()` resolves only on provider acceptance; rejections and unknown outcomes throw typed errors with `code`, `retrySafe`, and redacted `attempts`.
- Adapters: Twilio (supported), Telnyx (supported), Plivo (partial), Vonage Messages API with Basic or JWT auth (partial). See PROVIDERS.md.
- Opt-in fallback (`fallback: "on-known-rejection"`) for auth, rate-limit, sender, and account rejections only. Never after unknown outcomes.
- Rate-limit retries with exponential backoff, full jitter, and bounded `Retry-After`. Per-request timeout and `AbortSignal` support.
- Idempotency store contract with atomic `reserve` and owner-checked `finalize`, plus `memoryIdempotencyStore()`.
- GSM-7 and UCS-2 segment estimates, including extension characters and surrogate pairs at segment boundaries.
- `/webhooks`: verified, normalized events for all four providers, with dedupe keys and STOP/HELP detection.
- `/testing`: `memory()` adapter, `mockFetch()`, signed webhook request builders, and `runSmsAdapterContract()`.
- `sms-sdk doctor`: dry-run configuration check with a gated `--live` send.
