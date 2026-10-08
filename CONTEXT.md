# SMS SDK

This repository is the home of SMS SDK and its docs.

- **SMS SDK** means `@opencoredev/sms-sdk`, a provider-agnostic SMS transport library in `packages/sms-sdk`.
- **Adapter** means one provider integration (Twilio, Telnyx, Plivo, Vonage) exported from its own subpath.
- **Handoff** means whether a provider accepted a send: `accepted`, `rejected`, or `unknown`. Handoff is not delivery.
- **Docs site** means the Blume app in `apps/docs`. It has a landing page at `/` and docs under section folders.
- **Email SDK** and **Sandbox SDK** under `packages/` are reference copies of sibling OpenCore packages, not products of this repo.

Docs follow the `tanstack-docs` skill (`~/.agents/skills/tanstack-docs`).
