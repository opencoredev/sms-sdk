import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const required = [
  "index.mdx",
  "compare.mdx",
  "install.mdx",
  "first-sandbox.mdx",
  "limits.mdx",
  "api/sandboxes.mdx",
  "api/hooks.mdx",
  "providers/index.mdx",
  "providers/memory.mdx",
  "providers/cloudflare.mdx",
  "integrations/index.mdx",
  "integrations/skill.mdx",
  "guides/migrate-0-2.mdx",
  "guides/migrate-agentos.mdx",
  "guides/cli.mdx",
  "reference/live-tests.mdx",
  "reference/package-exports.mdx",
];

test("Sandbox 2 docs inventory exists", () => {
  for (const page of required) {
    expect(existsSync(`../../apps/docs/content/docs/sandbox/${page}`)).toBe(true);
  }
});

test("docs app is a TanStack Start SPA", () => {
  const pkg = JSON.parse(readFileSync("../../apps/docs/package.json", "utf8")) as {
    dependencies?: Record<string, string>;
  };
  expect(pkg.dependencies?.next).toBeUndefined();
  expect(pkg.dependencies?.["@tanstack/react-start"]).toBeDefined();
});

test("docs navigation keeps one agent group and puts SDK Reference last", () => {
  const root = readMeta("meta.json");
  const agents = readMeta("integrations/meta.json");
  const providers = readMeta("providers/meta.json");
  const guides = readMeta("guides/meta.json");

  expect(root.pages.at(-1)).toBe("reference");
  expect(root.pages).not.toContain("agents");
  expect(root.pages).not.toContain("agent-skill");
  expect(agents.title).toBe("Agents");
  expect(agents.pages).toContain("skill");
  expect(providers.pages).not.toContain("agentos");
  expect(guides.pages).toContain("migrate-agentos");
});

function readMeta(path: string): { title: string; pages: string[] } {
  return JSON.parse(
    readFileSync(`../../apps/docs/content/docs/sandbox/${path}`, "utf8"),
  ) as { title: string; pages: string[] };
}
