# Contributing

## Setup

```bash
bun install
cd packages/sms-sdk
bun run check-types   # src, tests, and examples
timeout 600 bun test  # unit, contract, webhook, CLI, examples, packaging
bun run build         # dist/ via tsc
```

Tests mock `fetch` and never contact a provider. `test/integration/live.test.ts` sends real messages only with `LIVE_SMS_TESTS=true`, a `LIVE_SMS_TO` listed in `LIVE_SMS_ALLOWLIST`, and provider credentials (see `.env.example`). Never enable it in CI for pull requests.

## Rules

- No runtime or peer dependencies. Use `fetch`, `URL`, `URLSearchParams`, `AbortController`, and Web Crypto.
- An adapter file must not import another adapter, webhook, testing, or CLI module. The packaging test enforces this on the built output.
- No `any`. Parse provider responses as `unknown` and narrow them.
- Never log or serialize credentials, message bodies, or full phone numbers. Use `providerInfo()` and `redactText()` for provider text.
- Every provider fact needs an official source in PROVIDERS.md with the date you checked it. If something cannot be confirmed, mark the adapter `partial` and say why in `support.notes`.

## Adding an adapter

1. Create `src/providers/<name>.ts` exporting a factory that returns `SmsAdapter`:
   - `name`: lowercase, unique.
   - `capabilities`: only what the provider documents. A flag you cannot verify is `false`.
   - `support`: `{ status: "supported" | "partial", notes }`.
   - `validate(message)`: provider-specific local checks (ID formats, field combinations).
   - `send(message, context)`: one request through `exchange()` from `src/core/http.ts`, passing `context.signal`. Return `accepted` only with the documented message ID, `rejected` only for 4xx responses that prove the message was not created, and `unknown` for everything else. Do not throw.
2. Map provider error codes to `RejectionCategory`. Only `auth`, `rate_limited`, `sender`, and `account` trigger fallback, so put a code there only when another provider could plausibly accept the same message. Opt-outs and blocks are `compliance`.
3. Add a subpath to `package.json` `exports` and to `tsconfig.json` `paths`.
4. Write `test/contracts/<name>.test.ts` with `AdapterContractFixtures` taken from the provider's documented examples, and register the checks:

   ```ts
   import { smsAdapterContractCases } from "../../src/testing/contracts.js";

   for (const check of smsAdapterContractCases((fetch) => myProvider({ apiKey: "k", fetch }), fixtures)) {
     test(check.name, check.run);
   }
   ```

   The harness checks capability consistency, the exact request, signal propagation, accepted/rejected/rate-limited mapping, and that network errors, aborts, malformed 2xx, non-JSON 2xx, and 5xx are unknown. It also checks that undeclared capabilities throw `UnsupportedFieldError` before any request.
5. For webhooks, add `src/webhooks/<name>.ts` that verifies before parsing, register it in `parseSmsWebhook`, add signed-request builders to `src/testing/webhooks.ts`, and add `webhooks` cases (including a tampered request) to the fixtures.
6. Document the adapter in PROVIDERS.md, README.md, and the doctor environment table in `src/cli/config.ts`.
