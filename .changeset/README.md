# Changesets

Every change to `@opencoredev/sms-sdk` ships with a changeset:

```bash
bun run changeset
```

Pick the bump (patch, minor, or major) and write one line for the changelog. When the change merges to `main`, the release workflow opens a "chore: version package" PR that bumps the version and updates `packages/sms-sdk/CHANGELOG.md`. Merging that PR publishes to npm.
