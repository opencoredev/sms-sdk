# SMS SDK docs

The SMS SDK documentation site, built with [Blume](https://useblume.dev).

```bash
bun install          # from the repository root
bun run dev          # from the root, or `bun run dev` in apps/docs
bun run build        # in apps/docs; writes static HTML to dist/
bun run check:snippets  # in apps/docs; type-checks every ts snippet against the SDK source
```

- `docs/` holds the pages. Each folder is a sidebar group configured by its `meta.ts`.
- `pages/index.astro` is the landing page at `/`.
- `theme.css` holds the landing page styles and provider status colors.
- `blume.config.ts` sets the title, theme, search, redirects, and llms.txt details.
- `scripts/check-snippets.ts` type-checks doc and landing page snippets; `scripts/snippet-stubs/` holds the `./db`, `./sms`, and `./notify` modules snippets may import. Mark a block that should not be checked with `ignore="reason"` in its fence.
