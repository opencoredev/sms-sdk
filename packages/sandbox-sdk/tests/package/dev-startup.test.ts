import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the workspace starts docs without replacing the built SDK", () => {
  const sdk = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
    scripts: { dev: string };
  };
  const root = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as {
    scripts: { dev: string };
  };

  expect(sdk.scripts.dev).toBe("tsdown --no-clean --watch src");
  expect(root.scripts.dev).toBe("bun run --cwd apps/docs dev");
});
