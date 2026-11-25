import { describe, expect, test } from "bun:test";
// Imported by package specifier, not relative path: tsconfig `paths` must map
// every subpath in package.json `exports`, so typecheck and tests resolve them.
import { createSmsClient } from "@opencoredev/sms-sdk";
import { bandwidth } from "@opencoredev/sms-sdk/bandwidth";
import { estimateSegments } from "@opencoredev/sms-sdk/encoding";
import { plivo } from "@opencoredev/sms-sdk/plivo";
import { sinch } from "@opencoredev/sms-sdk/sinch";
import { telnyx } from "@opencoredev/sms-sdk/telnyx";
import { memory } from "@opencoredev/sms-sdk/testing";
import { twilio } from "@opencoredev/sms-sdk/twilio";
import { vonage } from "@opencoredev/sms-sdk/vonage";
import { parseSmsWebhooks } from "@opencoredev/sms-sdk/webhooks";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("package specifiers", () => {
  test("every exported subpath resolves through tsconfig paths", () => {
    for (const value of [createSmsClient, bandwidth, estimateSegments, plivo, sinch, telnyx, memory, twilio, vonage, parseSmsWebhooks]) {
      expect(typeof value).toBe("function");
    }
  });

  test("tsconfig paths cover exactly the package exports", () => {
    const dir = resolve(import.meta.dir, "../..");
    const manifest: { exports: Record<string, unknown> } = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
    const tsconfig: { compilerOptions: { paths: Record<string, unknown> } } = JSON.parse(readFileSync(resolve(dir, "tsconfig.json"), "utf8"));
    const exported = Object.keys(manifest.exports)
      .filter((subpath) => subpath !== "./package.json")
      .map((subpath) => `@opencoredev/sms-sdk${subpath.slice(1)}`)
      .sort();
    expect(Object.keys(tsconfig.compilerOptions.paths).sort()).toEqual(exported);
  });
});
