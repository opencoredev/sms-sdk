# SMS SDK docs

The SMS SDK documentation site, built with [Blume](https://useblume.dev).

```bash
bun install          # from the repository root
bun run dev          # from the root, or `bun run dev` in apps/docs
bun run build        # in apps/docs; writes static HTML to dist/
```

- `docs/` holds the pages. Each folder is a sidebar group configured by its `meta.ts`.
- `pages/index.astro` is the landing page at `/`.
- `theme.css` holds the landing page styles and provider status colors.
- `blume.config.ts` sets the title, theme, search, and llms.txt details.
