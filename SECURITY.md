# Security policy

Report security issues privately through [GitHub private vulnerability reporting](https://github.com/opencoredev/sms-sdk/security/advisories/new). Do not open a public issue for a vulnerability.

Include the package version, the affected adapter or entry point (such as `@opencoredev/sms-sdk/webhooks`), and the smallest example that shows the problem. Remove credentials, phone numbers, and message content first.

Webhook signature checks, idempotency, and anything that could send a message twice or to the wrong recipient are in scope.

## Supported versions

Fixes ship in the latest published version of `@opencoredev/sms-sdk`.
