---
"@opencoredev/sms-sdk": minor
---

Add `sms.getMessage()`, `parseSmsWebhooks()`, `fromByAdapter`, and suppression-list helpers, and reject invalid configuration and malformed input with typed errors.

- `sms.getMessage(providerId, { adapter?, signal? })` looks a message up with the provider and returns its delivery status, or `undefined` when the provider has no such message. Failures throw `MessageLookupError` (`retrySafe: false`). Implemented for all six adapters through the new optional `SmsAdapter.getMessage`; a Vonage adapter with JWT auth needs `reportsCredentials`.
- `parseSmsWebhooks()` returns every event in a request: each element of a Bandwidth callback and each Sinch `recipient_delivery_report` entry. `parseSmsWebhook()` now throws `WebhookPayloadError` for a multi-event payload; it used to return the first Sinch report and drop the rest. Bandwidth status events now include the recipient in `dedupeKey` (`bandwidth:{messageId}:{to}:{type}`) so per-recipient status callbacks do not collide.
- `fromByAdapter` on `send()` input sets a sender per adapter for fallback chains.
- `SuppressionList`, `memorySuppressionList()`, `suppressionPolicy()`, and `applySuppressionEvent()` connect STOP/START webhooks to `beforeSend`.
- Keyword events carry `mediaUrls`.
- `createSmsClient` throws `ConfigurationError` for `idempotency.ttlSec` or `staleReservationSec` that are not positive integers of at least 1 second (`ttlSec: 0` let a repeated key send twice), `timeoutMs` above `2147483647`, malformed `idempotency`/`retry` objects or stores, `retry.maxAttempts` outside 1 to 10, and retry delays outside 0 to `2147483647`.
- `validate()` returns issues instead of throwing for malformed runtime input, and `send()` throws `InvalidMessageError` for it.
- `sinch()` throws `ConfigurationError` for missing options; non-Latin-1 Basic credentials throw `ConfigurationError` instead of a `DOMException`. Sinch `Rejected` delivery status now maps to `undelivered` unless the provider error code is `40003` (`filtered`), and each Sinch `recipient_delivery_report` event takes `occurredAt` from that report's `at`.
- Plivo `rejected` status maps to `undelivered` in webhooks and `getMessage()`, and placeholder `ErrorCode`/`error_code` `000` is omitted.
- `beforeSend` throwing emits `onFailure`; an unexpected internal failure keeps the attempts made.
- `unsafeSkipVerification` throws `ConfigurationError` when `NODE_ENV` is `production`.
- Provider responses and inbound webhook request bodies are read up to 1 MiB; an oversized provider response is an unknown outcome, and an oversized webhook body throws `WebhookPayloadError` (`reason: "body_too_large"`) before signature verification.
- Every subpath export adds a `default` condition beside `import`. The package stays ESM only.
