# Provider evidence

Verified 2026-10-08 against official documentation URLs. HTTP behavior is covered by mocked contract tests; live carrier tests require `LIVE_SMS_TESTS=true` and an allowlisted recipient.

- Twilio Messages API: https://www.twilio.com/docs/messaging/api/message-resource (POST `/2010-04-01/Accounts/{AccountSid}/Messages.json`, Basic auth, form fields `To`, `From`, `Body`, response `sid`). Request validation: https://www.twilio.com/docs/usage/security#validating-requests (HMAC-SHA1 URL + sorted POST parameters; JSON body variant uses bodySHA256). Adapter supports outbound text/MMS and delivery callbacks.
- Telnyx Messaging API: https://developers.telnyx.com/docs/messaging/messages (POST `/v2/messages`, Bearer auth, `from/to/text`, response `data.id`). Webhooks: https://developers.telnyx.com/docs/api/v2/webhooks (Ed25519 over timestamp + raw body, five-minute tolerance). Adapter supports outbound text and callbacks.
- Plivo Message API: https://www.plivo.com/docs/messaging/api/message (POST `/v1/Account/{auth_id}/Message/`, Basic auth, `src/dst/text`, `message_uuid`). Webhook signature behavior is marked partial pending current vector verification.
- Vonage SMS API: https://developer.vonage.com/en/messaging/sms/overview (POST `https://rest.nexmo.com/sms/json`, `api_key/api_secret/from/to/text`, status `0` accepted). This intentionally uses the SMS API rather than Messages API because it has a stable SMS endpoint and credential model. Webhook signature behavior is marked partial.

Provider status/error mappings are conservative: authentication is definite rejection; documented 4xx validation is known rejection; network errors, malformed 2xx, and generic 5xx are unknown. No native idempotency header is sent because these APIs do not provide a verified equivalent for this package contract.
