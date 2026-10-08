/**
 * Opt-in live tests. They send real, billable messages and never run by default.
 *
 * Required:
 *   LIVE_SMS_TESTS=true
 *   LIVE_SMS_TO=+1...                      the recipient
 *   LIVE_SMS_ALLOWLIST=+1...,+44...        LIVE_SMS_TO must be listed here
 * Plus credentials for each provider to test (see .env.example). A provider
 * without credentials is skipped. Expected cost: one SMS segment per provider.
 */
import { describe, expect, test } from "bun:test";
import { adapterFromEnv, configuredSender, DOCTOR_PROVIDERS, PROVIDER_ENV } from "../../src/cli/config.js";
import { createSmsClient } from "../../src/core/client.js";
import { isE164 } from "../../src/core/e164.js";

const env = process.env;
const to = env["LIVE_SMS_TO"] ?? "";
const allowlist = (env["LIVE_SMS_ALLOWLIST"] ?? "").split(",").map((entry) => entry.trim());
const enabled = env["LIVE_SMS_TESTS"] === "true" && isE164(to) && allowlist.includes(to);

describe.skipIf(!enabled)("live sends (LIVE_SMS_TESTS=true)", () => {
  for (const provider of DOCTOR_PROVIDERS) {
    const configured =
      PROVIDER_ENV[provider].required.every((alternatives) => alternatives.some((name) => (env[name] ?? "").length > 0)) &&
      configuredSender(provider, env) !== undefined;

    test.skipIf(!configured)(`${provider} accepts one message`, async () => {
      if (!isE164(to)) throw new Error("LIVE_SMS_TO must be E.164");
      const sms = createSmsClient({ adapters: [adapterFromEnv(provider, env, undefined)] });
      const result = await sms.send({ to, body: `SMS SDK live test via ${provider}` });
      expect(result.handoff).toBe("accepted");
      expect(result.providerId.length).toBeGreaterThan(0);
    }, 30_000);
  }
});

test("live tests are off unless explicitly enabled with an allowlisted recipient", () => {
  expect(enabled).toBe(env["LIVE_SMS_TESTS"] === "true" && isE164(to) && allowlist.includes(to));
});
