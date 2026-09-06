import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

test("docs redirects cover the Sandbox 2 ramp aliases", async () => {
  const raw = await readFile("../../apps/docs/vercel.json", "utf8");
  const config = JSON.parse(raw) as {
    redirects: { source: string; destination: string; permanent: boolean }[];
  };
  const map = Object.fromEntries(config.redirects.map((row) => [row.source, row.destination]));
  expect(map["/"]).toBe("/docs");
  expect(map["/docs/quickstart"]).toBe("/docs/sandbox/first-sandbox");
  expect(map["/docs/install"]).toBe("/docs/sandbox/install");
  expect(map["/docs/compare"]).toBe("/docs/sandbox/compare");
  expect(map["/docs/cli"]).toBe("/docs/sandbox/guides/cli");
  expect(map["/docs/hooks"]).toBe("/docs/sandbox/api/hooks");
  expect(map["/docs/providers/agentos"]).toBe("/docs/sandbox/guides/migrate-agentos");
  expect(map["/docs/agent-skill"]).toBe("/docs/sandbox/integrations/skill");
  expect(map["/docs/agents"]).toBe("/docs/sandbox/integrations");
  expect(map["/docs/agents/ai-sdk"]).toBe("/docs/sandbox/integrations/ai-sdk");
  expect(map["/docs/agents/harness"]).toBe("/docs/sandbox/integrations/ai-sdk-harness");
  expect(map["/docs/agents/skill"]).toBe("/docs/sandbox/integrations/skill");
  expect(map["/docs/agents/eve"]).toBe("/docs/sandbox/integrations/eve");
  expect(map["/docs/agents/mastra"]).toBe("/docs/sandbox/integrations/mastra");
  expect(config.redirects.every((row) => row.permanent)).toBe(true);
});
