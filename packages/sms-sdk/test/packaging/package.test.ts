import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const PACKAGE_DIR = resolve(import.meta.dir, "../..");
const SUBPATHS = ["", "/twilio", "/telnyx", "/plivo", "/vonage", "/webhooks", "/testing", "/encoding"];
const ADAPTERS = ["twilio", "telnyx", "plivo", "vonage"];

type PackFile = { path: string };
let packedFiles: string[] = [];
let consumerDir = "";

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
}

beforeAll(() => {
  run("bun", ["run", "build"], PACKAGE_DIR);
  const report: unknown = JSON.parse(run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], PACKAGE_DIR));
  const first: unknown = Array.isArray(report) ? report[0] : undefined;
  const files: unknown = typeof first === "object" && first !== null && "files" in first ? first.files : undefined;
  packedFiles = Array.isArray(files) ? files.map((file: PackFile) => file.path) : [];

  // Install the real tarball into a throwaway consumer project.
  consumerDir = mkdtempSync(join(tmpdir(), "sms-sdk-consumer-"));
  const tarball = run("npm", ["pack", "--ignore-scripts", "--pack-destination", consumerDir], PACKAGE_DIR).trim().split("\n").at(-1) ?? "";
  const target = join(consumerDir, "node_modules", "@opencoredev", "sms-sdk");
  mkdirSync(target, { recursive: true });
  run("tar", ["-xzf", join(consumerDir, tarball), "-C", target, "--strip-components=1"], consumerDir);
  writeFileSync(join(consumerDir, "package.json"), JSON.stringify({ name: "consumer", type: "module", private: true }));
}, 180_000);

describe("published package", () => {
  test("ships only dist and documentation files", () => {
    expect(packedFiles.length).toBeGreaterThan(0);
    const allowed = /^(dist\/.+|README\.md|CHANGELOG\.md|LICENSE|PROVIDERS\.md|package\.json)$/;
    expect(packedFiles.filter((path) => !allowed.test(path))).toEqual([]);
    expect(packedFiles.some((path) => path.startsWith("dist/cli/bin.js"))).toBe(true);
    expect(packedFiles.some((path) => /(^|\/)test\/|\.test\.|\.env/.test(path))).toBe(false);
  });

  test("every export target is in the tarball", () => {
    const manifest: { exports: Record<string, string | { types: string; import: string }> } = JSON.parse(
      readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"),
    );
    for (const target of Object.values(manifest.exports)) {
      const paths = typeof target === "string" ? [target] : [target.types, target.import];
      for (const path of paths) {
        expect(packedFiles).toContain(path.replace(/^\.\//, ""));
      }
    }
  });

  test("has zero runtime and peer dependencies", () => {
    const manifest: Record<string, unknown> = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8"));
    expect(manifest["dependencies"]).toBeUndefined();
    expect(manifest["peerDependencies"]).toBeUndefined();
    expect(manifest["optionalDependencies"]).toBeUndefined();
    expect(manifest["sideEffects"]).toBe(false);
  });

  test("every subpath imports under Node", () => {
    const script = `
      const subpaths = ${JSON.stringify(SUBPATHS)};
      const out = {};
      for (const subpath of subpaths) {
        const mod = await import("@opencoredev/sms-sdk" + subpath);
        out[subpath || "."] = Object.keys(mod).length;
      }
      console.log(JSON.stringify(out));
    `;
    const counts: Record<string, number> = JSON.parse(run("node", ["--input-type=module", "-e", script], consumerDir));
    for (const subpath of SUBPATHS) {
      expect(counts[subpath || "."]).toBeGreaterThan(0);
    }
  });

  test("every subpath imports under Bun", () => {
    const file = join(consumerDir, "smoke.mjs");
    writeFileSync(
      file,
      `for (const subpath of ${JSON.stringify(SUBPATHS)}) { await import("@opencoredev/sms-sdk" + subpath); }\nconsole.log("ok");\n`,
    );
    expect(run("bun", [file], consumerDir).trim()).toBe("ok");
  });

  test("a send works end to end from the installed package under Node", () => {
    const script = `
      import { createSmsClient } from "@opencoredev/sms-sdk";
      import { twilio } from "@opencoredev/sms-sdk/twilio";
      import { mockFetch } from "@opencoredev/sms-sdk/testing";
      const fake = mockFetch({ status: 201, body: { sid: "SM0123456789abcdef0123456789abcdef", status: "queued" } });
      const sms = createSmsClient({ adapters: [twilio({ accountSid: "AC0123456789abcdef0123456789abcdef", authToken: "t", from: "+15005550006", fetch: fake.fetch })] });
      const result = await sms.send({ to: "+14155550123", body: "hi" });
      console.log(result.providerId, fake.calls.length);
    `;
    expect(run("node", ["--input-type=module", "-e", script], consumerDir).trim()).toBe("SM0123456789abcdef0123456789abcdef 1");
  });

  test("Telnyx Ed25519 webhook verification works under Node", () => {
    const script = `
      import { parseSmsWebhook } from "@opencoredev/sms-sdk/webhooks";
      import { generateTelnyxKeyPair, signedTelnyxRequest } from "@opencoredev/sms-sdk/testing";
      const keys = await generateTelnyxKeyPair();
      const body = { data: { event_type: "message.finalized", id: "e1", payload: { id: "m1", to: [{ status: "delivered" }] } } };
      const request = await signedTelnyxRequest({ privateKey: keys.privateKey, url: "https://example.com/t", body });
      const event = await parseSmsWebhook({ provider: "telnyx", request, credentials: { publicKey: keys.publicKey } });
      console.log(event.type);
    `;
    expect(run("node", ["--input-type=module", "-e", script], consumerDir).trim()).toBe("message.delivered");
  });

  test("the CLI runs under Node from the installed package", () => {
    const output = run("node", [join(consumerDir, "node_modules/@opencoredev/sms-sdk/dist/cli/bin.js"), "--help"], consumerDir);
    expect(output).toContain("Usage: sms-sdk doctor");
  });
});

describe("module isolation", () => {
  const dist = join(PACKAGE_DIR, "dist");

  function reachable(entry: string): Set<string> {
    const seen = new Set<string>();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop();
      if (file === undefined || seen.has(file)) continue;
      seen.add(file);
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/(?:import|export)[^"']*?from\s*["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)) {
        const specifier = match[1] ?? match[2];
        if (specifier !== undefined) {
          queue.push(resolve(dirname(file), specifier));
        }
      }
    }
    return seen;
  }

  test.each(ADAPTERS.map((adapter) => [adapter]))("dist/providers/%s.js never loads another adapter", (adapter) => {
    const files = [...reachable(join(dist, "providers", `${adapter}.js`))].map((file) => file.slice(dist.length + 1));
    const others = ADAPTERS.filter((other) => other !== adapter).map((other) => `providers/${other}.js`);
    expect(files.filter((file) => others.includes(file))).toEqual([]);
    expect(files.some((file) => file.startsWith("webhooks/") || file.startsWith("testing/") || file.startsWith("cli/"))).toBe(false);
  });

  test("the root entry loads no adapter, webhook, or CLI code", () => {
    const files = [...reachable(join(dist, "index.js"))].map((file) => file.slice(dist.length + 1));
    expect(files.filter((file) => /^(providers|webhooks|testing|cli)\//.test(file))).toEqual([]);
  });

  test("built files never import a bare package", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (entry.name.endsWith(".js")) {
          const source = readFileSync(path, "utf8");
          // Line-anchored so code samples inside JSDoc comments are ignored.
          for (const match of source.matchAll(/^\s*(?:import|export)\b[^\n]*?from\s*["']([^."'][^"']*)["']/gm)) {
            offenders.push(`${path.slice(dist.length + 1)}: ${match[1] ?? ""}`);
          }
        }
      }
    };
    walk(dist);
    expect(offenders).toEqual([]);
  });
});
