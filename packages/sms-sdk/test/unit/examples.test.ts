import { describe, expect, test } from "bun:test";
import { run as runFailover } from "../../examples/failover/index.js";
import { run as runTestAdapter } from "../../examples/test-adapter/index.js";
import { run as runTwilio } from "../../examples/twilio/index.js";
import { run as runWebhooks } from "../../examples/webhooks/index.js";

describe("examples run offline", () => {
  test("twilio sends through the mocked API", async () => {
    const result = await runTwilio({});
    expect(result).toMatchObject({ provider: "twilio", providerId: "SM0123456789abcdef0123456789abcdef", handoff: "accepted" });
  });

  test("failover moves to Telnyx after a known sender rejection", async () => {
    const outcome = await runFailover();
    expect(outcome.kind).toBe("sent");
    if (outcome.kind === "sent") {
      expect(outcome.result.attemptedProviders).toEqual(["twilio", "telnyx"]);
    }
  });

  test("webhooks verify, dedupe, and reject forgeries", async () => {
    const { statuses, sink } = await runWebhooks();
    expect(statuses).toEqual([204, 204, 204, 401]);
    expect(sink.handled.map((event) => event.type)).toEqual(["recipient.opted_out", "message.delivered"]);
  });

  test("test-adapter records sends and scripted rejections", async () => {
    const { sentBodies, rejectedCategory } = await runTestAdapter();
    expect(sentBodies).toEqual(["Your login code is 482913", "Your login code is 111222"]);
    expect(rejectedCategory).toBe("compliance");
  });
});
