import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import { estimateSegments } from "../../../../packages/sms-sdk/src/core/encoding.ts";
import { breakDown } from "./segments";

const here = dirname(fileURLToPath(import.meta.url));
const encodingSource = resolve(here, "../../../../packages/sms-sdk/src/core/encoding.ts");
const pagePath = resolve(here, "../tools/sms-segment-calculator.astro");

const samples = [
  "",
  "Hi",
  "a".repeat(160),
  "a".repeat(161),
  "a".repeat(306),
  "a".repeat(307),
  "€".repeat(80),
  "€".repeat(81),
  `${"a".repeat(152)}€`,
  "Your package is ready 📦",
  "😀".repeat(35),
  "😀".repeat(36),
  `${"a".repeat(66)}😀`,
  "Hi Sam, your table at Rosa’s is confirmed for Friday at 7:30 PM. Reply C to cancel.",
  "Café opens at 9 € 5",
  "Line one\nLine two\r\n{braces} [brackets] ~tilde~ |pipe| ^caret^ \\back\\",
];

describe("breakDown", () => {
  test.each(samples)("agrees with estimateSegments for %p", (body) => {
    const result = breakDown(body);
    const expected = estimateSegments(body);
    expect(result.preview).toEqual(expected);
    expect(result.segments.length).toBe(expected.segments);
    expect(result.segments.reduce((total, segment) => total + segment.units, 0)).toBe(expected.units);
    expect(result.segments.flatMap((segment) => segment.characters.map((character) => character.text)).join("")).toBe(body);
    const last = result.segments.at(-1);
    if (last !== undefined) expect(expected.unitsPerSegment - last.units).toBe(expected.remainingInSegment);
    for (const segment of result.segments) expect(segment.units).toBeLessThanOrEqual(expected.unitsPerSegment);
  });

  test("marks extension and UCS-2 characters", () => {
    const kinds = breakDown("a€ê").segments.flatMap((segment) => segment.characters.map((character) => character.kind));
    expect(kinds).toEqual(["basic", "extension", "unicode"]);
  });
});

describe("serverExample on the calculator page", () => {
  const extract = async (): Promise<string> => {
    const source = await readFile(pagePath, "utf8");
    const raw = source.match(/const serverExample = `([\s\S]*?)`;/)?.[1];
    if (raw === undefined) throw new Error("serverExample not found in sms-segment-calculator.astro");
    return raw.replaceAll("\\`", "`").replaceAll("\\${", "${");
  };

  test("type-checks against the SDK source", async () => {
    const code = await extract();
    const work = await mkdtemp(join(tmpdir(), "sms-segment-sample-"));
    const file = join(work, "sample.ts");
    await writeFile(file, `${code}\nexport {};\n`);
    const program = ts.createProgram([file], {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2023.d.ts", "lib.dom.d.ts"],
      types: [],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      paths: { "@opencoredev/sms-sdk/encoding": [encodingSource] },
    });
    const messages = ts
      .getPreEmitDiagnostics(program)
      .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    expect(messages).toEqual([]);
  });

  test("prints what its comments say", async () => {
    const code = await extract();
    const work = await mkdtemp(join(tmpdir(), "sms-segment-sample-"));
    const file = join(work, "sample.ts");
    await writeFile(file, code.replace('"@opencoredev/sms-sdk/encoding"', JSON.stringify(encodingSource)));

    const printed: string[] = [];
    const original = console.log;
    console.log = (...values: unknown[]) => {
      printed.push(values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
    };
    try {
      await import(file);
    } finally {
      console.log = original;
    }

    const expected = code
      .split("\n")
      .filter((line) => line.startsWith("console.log("))
      .map((line) => line.split("// ")[1] ?? "");
    expect(printed).toEqual(expected);
  });
});
