import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseArgs, runDoctor } from "../../src/cli/doctor.js";
import { mockFetch } from "../../src/testing/fetch.js";
import { TWILIO_MESSAGE_SID, TWILIO_SID } from "../helpers.js";

const TOKEN = "super-secret-twilio-token";
const twilioEnv = { TWILIO_ACCOUNT_SID: TWILIO_SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_FROM: "+15005550006" };

type Run = { code: number; out: string; err: string; calls: number };

async function doctor(argv: string[], env: Record<string, string>, accepted = true): Promise<Run> {
  const mock = mockFetch(
    accepted ? { status: 201, body: { sid: TWILIO_MESSAGE_SID, status: "queued" } } : { status: 400, body: { code: 21211, message: "bad" } },
  );
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDoctor({
    argv,
    env,
    fetch: mock.fetch,
    io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) },
  });
  return { code, out: out.join("\n"), err: err.join("\n"), calls: mock.calls.length };
}

let globalFetchCalls = 0;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalFetchCalls = 0;
  const spy = async (): Promise<Response> => {
    globalFetchCalls += 1;
    return new Response("{}", { status: 500 });
  };
  globalThis.fetch = Object.assign(spy, { preconnect: originalFetch.preconnect });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("doctor dry run", () => {
  test("passes with complete configuration and makes no network calls", async () => {
    const run = await doctor(["doctor", "--adapter", "twilio", "--to", "+14155550123"], twilioEnv);
    expect(run.code).toBe(0);
    expect(run.calls).toBe(0);
    expect(globalFetchCalls).toBe(0);
    expect(run.out).toContain("dry run, no network calls");
    expect(run.out).toContain("[ok]           TWILIO_ACCOUNT_SID set");
    expect(run.out).toContain("Nothing was sent.");
  });

  test("never claims unverified facts", async () => {
    const run = await doctor(["doctor", "--adapter", "twilio"], twilioEnv);
    expect(run.out).toContain("[not verified] credentials");
    expect(run.out).toContain("[not verified] sender provisioning, 10DLC/toll-free registration, and campaign status");
    expect(run.out).toContain("[not verified] webhook URL reachability");
    expect(run.out).not.toMatch(/\[ok\].*(approved|registered|reachable|valid credentials)/i);
  });

  test("hides secret values and masks numbers", async () => {
    const run = await doctor(["doctor", "--adapter", "twilio", "--to", "+14155550123"], twilioEnv);
    expect(run.out).not.toContain(TOKEN);
    expect(run.out).toContain("TWILIO_AUTH_TOKEN set (value hidden)");
    expect(run.out).not.toContain("+14155550123");
    expect(run.out).not.toContain("+15005550006");
  });

  test("previews encoding and segments as an estimate", async () => {
    const run = await doctor(["doctor", "--adapter", "telnyx", "--body", "Hello 📦"], { TELNYX_API_KEY: "k", TELNYX_FROM: "+15005550006" });
    expect(run.out).toContain("UCS2, 8 UTF-16 units, 1 segment (estimate, not a price quote)");
    expect(run.out).toContain('characters forcing UCS-2: "📦"');
  });

  test("fails on missing variables and malformed config", async () => {
    const run = await doctor(["doctor", "--adapter", "twilio"], { TWILIO_ACCOUNT_SID: "bad" });
    expect(run.code).toBe(1);
    expect(run.out).toContain("[fail]         TWILIO_AUTH_TOKEN or TWILIO_API_KEY_SID missing");
    expect(run.out).toContain("accountSid must be AC");
    expect(run.out).toContain("no sender");
  });

  test("reports capability problems for the chosen sender", async () => {
    const run = await doctor(["doctor", "--adapter", "vonage", "--from", "12345"], { VONAGE_API_KEY: "k", VONAGE_API_SECRET: "s" });
    expect(run.code).toBe(1);
    expect(run.out).toContain("[fail]         from: vonage does not support short code senders.");
  });

  test("reports an invalid recipient", async () => {
    const run = await doctor(["doctor", "--adapter", "twilio", "--to", "4155550123"], twilioEnv);
    expect(run.code).toBe(1);
    expect(run.out).toContain("recipient is not E.164");
  });

  test.each([
    ["plivo", { PLIVO_AUTH_ID: "MA1", PLIVO_AUTH_TOKEN: "t", PLIVO_POWERPACK_UUID: "pp-1" }],
    ["vonage", { VONAGE_API_KEY: "k", VONAGE_API_SECRET: "s", VONAGE_FROM: "Acme" }],
    ["telnyx", { TELNYX_API_KEY: "k", TELNYX_FROM: "+15005550006" }],
  ] as const)("%s dry run passes with its environment", async (adapter, env) => {
    const run = await doctor(["doctor", "--adapter", adapter], env);
    expect(run.code).toBe(0);
    expect(run.calls).toBe(0);
  });

  test("partial adapters print their caveats", async () => {
    const run = await doctor(["doctor", "--adapter", "plivo"], { PLIVO_AUTH_ID: "MA1", PLIVO_AUTH_TOKEN: "t", PLIVO_FROM: "+15005550006" });
    expect(run.out).toContain("support: partial");
    expect(run.out).toContain("does not document its API error body");
  });
});

describe("doctor --live gating", () => {
  const live = ["doctor", "--adapter", "twilio", "--live"];

  test("requires --to", async () => {
    const run = await doctor(live, twilioEnv);
    expect(run.code).toBe(2);
    expect(run.calls).toBe(0);
  });

  test("requires a matching --confirm-to", async () => {
    const run = await doctor([...live, "--to", "+14155550123", "--confirm-to", "+14155550124", "--confirm-from", "+15005550006"], twilioEnv);
    expect(run.code).toBe(2);
    expect(run.err).toContain("--confirm-to");
    expect(run.calls).toBe(0);
  });

  test("requires --confirm-from equal to the configured sender, and names it", async () => {
    const run = await doctor([...live, "--to", "+14155550123", "--confirm-to", "+14155550123"], twilioEnv);
    expect(run.code).toBe(2);
    expect(run.err).toContain("--confirm-from +15005550006");
    expect(run.calls).toBe(0);
  });

  test("a mismatched --confirm-from is refused", async () => {
    const run = await doctor(
      [...live, "--to", "+14155550123", "--confirm-to", "+14155550123", "--from", "+15005550009", "--confirm-from", "+15005550006"],
      twilioEnv,
    );
    expect(run.code).toBe(2);
    expect(run.calls).toBe(0);
  });

  test("does not send when checks fail", async () => {
    const run = await doctor([...live, "--to", "+14155550123", "--confirm-to", "+14155550123", "--confirm-from", "+15005550006"], {
      TWILIO_ACCOUNT_SID: TWILIO_SID,
      TWILIO_FROM: "+15005550006",
    });
    expect(run.code).toBe(1);
    expect(run.calls).toBe(0);
  });

  test("sends exactly one message when fully confirmed", async () => {
    const run = await doctor([...live, "--to", "+14155550123", "--confirm-to", "+14155550123", "--confirm-from", "+15005550006"], twilioEnv);
    expect(run.code).toBe(0);
    expect(run.calls).toBe(1);
    expect(run.out).toContain(`accepted by twilio: providerId ${TWILIO_MESSAGE_SID}, delivery queued (not handset delivery)`);
  });

  test("reports a provider rejection with its retry safety", async () => {
    const run = await doctor(
      [...live, "--to", "+14155550123", "--confirm-to", "+14155550123", "--confirm-from", "+15005550006"],
      twilioEnv,
      false,
    );
    expect(run.code).toBe(1);
    expect(run.calls).toBe(1);
    expect(run.out).toContain("provider_rejected");
    expect(run.out).toContain("retrySafe: true");
  });
});

describe("doctor arguments", () => {
  test.each([
    [[], "help"],
    [["--help"], "help"],
    [["doctor", "--help"], "help"],
    [["doctor"], "error"],
    [["doctor", "--adapter", "sinch"], "error"],
    [["doctor", "--adapter"], "error"],
    [["doctor", "--adapter", "twilio", "--bogus"], "error"],
    [["send"], "error"],
    [["doctor", "--adapter", "twilio", "--to", "+14155550123"], "ok"],
  ] as const)("%j parses as %s", (argv, kind) => {
    expect(parseArgs(argv).kind).toBe(kind);
  });

  test("usage errors exit 2", async () => {
    const run = await doctor(["doctor", "--adapter", "nope"], {});
    expect(run.code).toBe(2);
    expect(run.err).toContain("--adapter must be one of twilio, telnyx, plivo, vonage");
  });

  test("help exits 0", async () => {
    const run = await doctor(["--help"], {});
    expect(run.code).toBe(0);
    expect(run.out).toContain("Usage: sms-sdk doctor");
  });
});
