---
"@opencoredev/sms-sdk": minor
---

Add SMS adapters and webhook normalization for Bandwidth and Sinch.

The Bandwidth and Sinch webhook parsers require `credentials`: Basic credentials for Bandwidth, and `{ kind: "basic" }` or `{ kind: "hmac" }` for Sinch. A request without valid authorization throws `WebhookSignatureError`.
