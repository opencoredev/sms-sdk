# SMS SDK

This repository is the home of SMS SDK and its docs.

- **SMS SDK** means `@opencoredev/sms-sdk`, a provider-agnostic SMS transport library in `packages/sms-sdk`.
- **Adapter** means one provider integration (Twilio, Telnyx, Plivo, Vonage, Bandwidth, Sinch) exported from its own subpath.
- **Handoff** means whether a provider accepted a send: `accepted`, `rejected`, or `unknown`. Handoff is not delivery.
- **Docs site** means the Blume app in `apps/docs`. It has a landing page at `/` and docs under section folders.
- **Email SDK** and **Sandbox SDK** under `packages/` are reference copies of sibling OpenCore packages, not products of this repo.

Docs follow the `tanstack-docs` skill (`~/.agents/skills/tanstack-docs`).

## Releases

`@opencoredev/sms-sdk` is on npm. Releases go through Changesets, the same way as Social SDK:

1. A change to `packages/sms-sdk` ships with a changeset (`bun run changeset`). CI fails a pull request that changes the package without one. Docs-only changes need none.
2. When it reaches `main`, `.github/workflows/release.yml` opens or updates the "chore: version package" pull request.
3. Merging that pull request publishes to npm through npm trusted publishing (OIDC, provenance, no token). Only Leo merges it.

The workflow runs only while the repository variable `SMS_SDK_RELEASE_ENABLED` is `true`. Never run `npm publish` by hand.

## Docs site

The docs deploy to Vercel as a server build (`deployment: vercel()`), which serves `llms.txt`, Markdown for every page, and an MCP server at `/mcp`. The site URL comes from Vercel's `VERCEL_PROJECT_PRODUCTION_URL`, so a custom domain needs no code change. Brand assets: `apps/docs/public/logo.svg` and `icon.svg`, and the README banner at `.github/assets/readme-banner.png` with its HTML source beside it.

