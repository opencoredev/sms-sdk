# SMS SDK workspace

This repository holds `@opencoredev/sms-sdk` and its documentation site.

- `packages/sms-sdk`: the SDK. See [its README](packages/sms-sdk/README.md).
- `apps/docs`: the docs site, built with [Blume](https://useblume.dev).
- `packages/email-sdk` and `packages/sandbox-sdk`: copies of the Email SDK and Sandbox SDK, kept as reference for shared patterns. They are not built or tested by the root scripts.

```bash
bun install
bun run test        # SMS SDK tests
bun run typecheck   # SMS SDK types
bun run build       # SMS SDK, then the docs site
bun run dev         # docs dev server (blume dev)
```
