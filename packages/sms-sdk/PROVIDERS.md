# Provider evidence

Every provider behavior this SDK relies on, where it comes from, and what could not be confirmed. All sources were checked on 2026-10-08. Contract tests in `test/contracts/` and webhook tests in `test/webhooks/` exercise each fact with mocked HTTP; no test calls a provider unless `LIVE_SMS_TESTS=true`.

Rules applied to every adapter:

- A 2xx response is accepted only when it contains the documented message ID. Otherwise the outcome is unknown.
- A 4xx response is a rejection (the message was not created). The error code picks the category; unlisted codes are `request`, which never falls back.
- 5xx, 1xx/3xx, network errors, timeouts, and aborts after the request starts are unknown. They are never retried or failed over.
- No provider documents send idempotency for its SMS endpoint, so no adapter sends an idempotency key and `nativeIdempotency` is `false` everywhere.

## Twilio: supported

Sources:

- Message resource: https://www.twilio.com/docs/messaging/api/message-resource
- Error response format: https://www.twilio.com/docs/usage/twilios-response
- Error dictionary (machine-readable): https://www.twilio.com/docs/api/errors/twilio-error-codes.json
- Request validation: https://www.twilio.com/docs/usage/security#validating-requests
- Incoming message parameters: https://www.twilio.com/docs/messaging/guides/webhook-request
- Status callbacks: https://www.twilio.com/docs/messaging/guides/track-outbound-message-status and https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks
- Opt-out parameter: https://www.twilio.com/docs/messaging/twiml

Sending:

- Endpoint: `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json`, form-encoded. `AccountSid` matches `^AC[0-9a-fA-F]{32}$`.
- Auth: HTTP Basic with Account SID + Auth Token, or API Key SID + secret.
- Fields used: `To`, `From` or `MessagingServiceSid` (`^MG[0-9a-fA-F]{32}$`), `Body` (up to 1,600 characters), `MediaUrl` (up to 10), `StatusCallback`, `ValidityPeriod` (1-36000 seconds), `SendAt` (ISO 8601) with `ScheduleType=fixed` (Messaging Service only).
- Response ID: `sid`, `^(SM|MM)[0-9a-fA-F]{32}$`. Initial `status` is `queued`, or `accepted`/`scheduled` with a Messaging Service; all three map to delivery `queued`.
- Error body: `{ code, message, more_info, status }`.

Error classification (Twilio code → category):

| Category | Codes / status |
|---|---|
| auth | HTTP 401, 20003 (Permission Denied), HTTP 403 without a listed code |
| rate_limited | HTTP 429, 20429 (Too many concurrent requests). Twilio documents 429 as "You have reached the Twilio API concurrency limit". |
| recipient | 21211 (Invalid 'To'), 21614 ('To' not a valid mobile number) |
| compliance | 21610 (Attempt to send to unsubscribed recipient) |
| sender | 21212, 21606, 21612, 21659, 21660, 21703 |
| account | 21408 (region permission disabled), 21608 (trial account, unverified number) |
| request | everything else, including 21602 (body required) and 21617 (body over 1,600) |

Twilio documents 503 as "temporarily unavailable. Try again later", but nothing proves the message was not created, so it is unknown.

Webhooks:

- Signature: `X-Twilio-Signature` = Base64(HMAC-SHA1(primary Auth Token, full URL + POST parameters sorted by name, each name and value appended with no delimiter)). Twilio's published example (URL `https://example.com/myapp.php?foo=1&bar=2`, token `12345`, signature `L/OH5YylLD5NRKLltdqwSvS0BnU=`) is a test vector.
- JSON bodies: the URL carries `bodySHA256` (hex SHA-256 of the body); the signature covers the URL only. Twilio's example hash `5ccde714...0aec9` is a test vector.
- Port: SMS URLs over HTTPS keep the port as configured; the verifier tries the URL with and without the default port, as Twilio's SDKs do.
- No timestamp is signed, so there is no replay window. Deduplicate.
- Twilio adds parameters without notice; all received parameters are signed and verified, and unknown ones are ignored when normalizing.
- Status callback fields: `MessageSid`, `MessageStatus`, `ErrorCode`, `From`, `To` (subset varies). Status values: `queued`, `accepted`, `scheduled`, `sending`, `sent`, `delivered`, `undelivered`, `failed`, `read`, `canceled`. Order is not guaranteed.
- `message.filtered` is emitted only for error 30007 ("Message filtered").
- Inbound fields: `MessageSid`, `From`, `To`, `Body`, `NumMedia`, `MediaUrl{N}`. `OptOutType` (`STOP`, `HELP`, `START`) is present only with Advanced Opt-Out enabled on a Messaging Service.

## Telnyx: supported

Sources:

- Send a message: https://developers.telnyx.com/api/messaging/send-message
- Messaging webhooks: https://developers.telnyx.com/docs/messaging/messages/receiving-webhooks
- Webhook delivery contract: https://developers.telnyx.com/development/api-fundamentals/webhooks/receiving-webhooks
- Error catalog: https://developers.telnyx.com/development/api-fundamentals/api-errors and https://developers.telnyx.com/data/api-errors.json
- Signature implementation in the official SDK: https://github.com/team-telnyx/telnyx-node/blob/master/src/lib/webhooks.ts

Sending:

- Endpoint: `POST https://api.telnyx.com/v2/messages`, JSON, `Authorization: Bearer <API key>`.
- Fields used: `to`, `from` (number, short code, or alphanumeric ID), `messaging_profile_id` (required for number pools and alphanumeric senders), `text`, `media_urls` with `type: "MMS"`, `webhook_url`, `send_at` (ISO 8601).
- No validity-period field exists in the request schema, so `validityPeriodSec` is unsupported.
- Response ID: `data.id`. Recipient status `data.to[0].status`: `queued`, `sending`, `sent`, `expired`, `sending_failed`, `delivery_unconfirmed`, `delivered`, `delivery_failed`, `read`.
- Error body: `{ errors: [{ code, title, detail, source, meta }] }`.

Error classification:

| Category | Codes |
|---|---|
| auth | 10009, 10010, 20001, 20002, 20003, 20006, 20008; HTTP 401/403 without a listed code |
| rate_limited | 10011 (Too many requests), 40318 (Message queue full, "Wait before resending"); HTTP 429 |
| compliance | 40300 (Blocked due to STOP message), 40322 (Blocked due to content) |
| recipient | 40310 (Invalid 'to'), 40301, 40319 |
| sender | 40305, 40306, 40308, 40315, 40320, 40321, 40329, 40330 |
| account | 20013, 20100, 40309, 40312, 40314, 40331, 40333 |
| request | everything else |

Telnyx does not document a `Retry-After` header; it is honored if present.

Webhooks:

- Headers `telnyx-signature-ed25519` (base64, 64 bytes) and `telnyx-timestamp` (Unix seconds).
- Signed string: `${timestamp}|${raw body}`. Public key: base64 of the raw 32-byte Ed25519 key from Mission Control, Keys & Credentials, Public Key. Verified with Web Crypto Ed25519.
- Replay window: Telnyx says to reject timestamps more than 5 minutes old; the SDK uses 300 seconds in both directions (configurable).
- Events: `message.received`, `message.sent`, `message.finalized`. `data.id` is the event ID (used as the dedupe key); `data.payload.id` is the message ID. Duplicates happen and order is not guaranteed.
- `message.filtered` is emitted only for error codes 40002 and 40003 (blocked as spam) and 40322 (blocked content). 40008 is not mapped to filtered because Telnyx's pages disagree on its meaning ("Filtered by carrier" vs "Undeliverable").
- Telnyx sends no opt-out flag on inbound messages, so STOP/HELP are keyword-derived.

## Plivo: partial

Sources:

- Send a message: https://www.plivo.com/docs/messaging/api/message/send-a-message
- API overview (status codes): https://www.plivo.com/docs/messaging/api/overview
- Message object and callbacks: https://www.plivo.com/docs/messaging/api/message
- Messaging signature validation: https://www.plivo.com/docs/messaging/concepts/signature-validation
- V3 signatures (Voice only): https://www.plivo.com/docs/voice/concepts/signature-validation
- Official SDK implementation: https://github.com/plivo/plivo-node/blob/master/lib/utils/security.js

Sending:

- Endpoint: `POST https://api.plivo.com/v1/Account/{auth_id}/Message/`, JSON, HTTP Basic (Auth ID, Auth Token).
- Fields used: `src` or `powerpack_uuid`, `dst` (E.164), `text`, `type` (`sms`/`mms`), `media_urls`, `url` + `method: "POST"`, `message_expiry` (documented range 5-10,799 seconds; the page also states a default of 10,800, which is outside that range).
- Response: `{ message, message_uuid: [id], api_id }`. The success status code is not stated; any 2xx with a non-empty `message_uuid` is accepted.
- Documented status codes: 400 invalid parameter, 401 authentication failed, 404, 405, 429 rate limit exceeded, 500.

Why partial:

- Plivo does not document its error response body. Only 401 (`auth`) and 429 (`rate_limited`) are classified; every other 4xx is `request` and does not fall back, even when the real cause is a sender problem.
- Messaging callbacks are signed with V2 only: `X-Plivo-Signature-V2` (or `X-Plivo-Signature-Ma-V2` for the main account) = Base64(HMAC-SHA256(Auth Token, callback URL without query string + `X-Plivo-Signature-V2-Nonce`)). Plivo documents V3 (which signs parameters) for Voice only. V2 does not sign the body and has no timestamp, so a captured callback could be replayed or its body altered without detection. Use HTTPS and deduplicate on `dedupeKey`.

Webhooks:

- Status callback fields: `From`, `To`, `MessageUUID`, `Status` (`queued`, `sent`, `delivered`, `undelivered`, `failed`, `read`), `Units`, `TotalRate`, `TotalAmount`, `ErrorCode` (`000` on success), `MCC`, `MNC`.
- Inbound fields: `From`, `To`, `Text`, `Type`, `MessageUUID`, `Media0`…`MediaN`.
- No `filtered` mapping (no documented evidence). No opt-out field; STOP/HELP are keyword-derived.

## Vonage: partial

API choice: the **Messages API** (`/v1/messages`), not the legacy SMS API (`rest.nexmo.com/sms/json`). The Messages API returns an HTTP status per request and signs webhooks with a JWT by default. The SMS API answers 200 with per-message status codes and uses a different signing scheme. The adapter and webhook parser use only the Messages API model.

Sources:

- Messages API reference: https://developer.vonage.com/en/api/messages
- Messages API error codes: https://developer.vonage.com/en/api-errors/messages
- Signed webhooks: https://developer.vonage.com/en/messages/concepts/signed-webhooks and https://developer.vonage.com/en/getting-started/concepts/webhooks
- Authentication: https://developer.vonage.com/en/getting-started/concepts/authentication
- `payload_hash` construction: https://developer.vonage.com/en/blog/validating-inbound-messages-from-the-vonage-messages-api-dr
- Basic auth and linked numbers: https://api.support.vonage.com/hc/en-us/articles/4412210010644

Sending:

- Endpoint: `POST https://{region}.nexmo.com/v1/messages` with region `api` (default), `api-eu`, `api-us`, or `api-ap`. JSON.
- Body: `message_type: "text"`, `channel: "sms"`, `to` and `from` without a leading `+`, `text`, optional `ttl` (20-604,800 seconds), `webhook_url`.
- Auth: Basic (API key and secret) or JWT (RS256 with the application private key; claims `application_id`, `iat`, `jti`, and `exp`, which defaults to 15 minutes and is set to 15 minutes here). Vonage documents that Basic auth does not support webhooks and returns 401 when the number is linked to an application. The Basic-auth adapter therefore reports no webhook, inbound, or receipt support.
- Response: `{ message_uuid }` (described as "Accepted"); any 2xx with `message_uuid` is accepted.
- Errors use RFC 7807 problem details (`type`, `title`, `detail`, `instance`). The error code is read from the `type` fragment (`...#1420`) or a numeric `title`.

Why partial:

- Vonage does not document which HTTP status each Messages API error code uses. Classification uses the documented statuses (401 auth, 402 low balance, 422 invalid parameters, 429 over the API limit) plus these codes: 1000/1241 rate_limited; 1170/1430 recipient; 1240/1476 compliance; 1120/1420 sender; 1060/1080/1160/1290/1460 account.
- `payload_hash` is described only as "a SHA-256 hash of the request payload". A Vonage blog post and support article describe it as the hex SHA-256 of the compact JSON payload. The verifier accepts a hash of the raw body or of its compact re-serialization, and checks it only when the claim is present.
- Vonage does not document a freshness window for `iat`; the SDK uses 300 seconds (configurable).
- Short codes and MMS (a separate Messages API channel) are not supported.

Webhooks:

- `Authorization: Bearer <JWT>`, HS256, signed with the signature secret for the API key in the `api_key` claim. Only `alg: "HS256"` is accepted.
- Status fields: `message_uuid`, `to`, `from`, `timestamp`, `status` (`submitted`, `delivered`, `rejected`, `undeliverable`), optional `error { type, title, detail }`.
- Inbound fields: `message_uuid`, `to`, `from`, `timestamp`, `text`, optional `sms.keyword` (the first word, uppercased). `sms.keyword` is not treated as a provider opt-out signal; STOP/HELP are keyword-derived from `text`.
- `message.filtered` is emitted only for error codes 1210 (Anti-Spam Rejection), 1470/1472 (Fraud Defender), and 1480-1483 (entity, header, content, consent filters).
- Numbers arrive without `+`; digit-only numbers are normalized to `+digits`.

## Not verified

- No adapter has been run against a live account in this repository. `test/integration/live.test.ts` sends one message per configured provider when `LIVE_SMS_TESTS=true` and the recipient is in `LIVE_SMS_ALLOWLIST`.
- Twilio's SDK webhook examples (signatures `Np1nax6u...` and `hqeF3G9H...`) do not state their Auth Token, so only the manual example is used as a vector.
- Plivo and Vonage signature schemes are implemented from documentation and SDK source; neither provider publishes a fixed test vector.
