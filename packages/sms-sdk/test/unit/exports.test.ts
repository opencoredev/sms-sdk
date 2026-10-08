import { describe, expect, test } from "bun:test";
import * as root from "../../src/index.js";
import * as encoding from "../../src/core/encoding.js";
import * as twilio from "../../src/providers/twilio.js";
import * as telnyx from "../../src/providers/telnyx.js";
import * as plivo from "../../src/providers/plivo.js";
import * as vonage from "../../src/providers/vonage.js";
import * as webhooks from "../../src/webhooks/index.js";
import * as testing from "../../src/testing/index.js";

describe("public exports", () => {
  test("root exports the client, errors, and helpers", () => {
    expect(typeof root.createSmsClient).toBe("function");
    expect(typeof root.memoryIdempotencyStore).toBe("function");
    expect(typeof root.HandoffUnknownError).toBe("function");
    expect(typeof root.estimateSegments).toBe("function");
  });

  test("each subpath exports its entry point", () => {
    expect(typeof encoding.estimateSegments).toBe("function");
    expect(typeof twilio.twilio).toBe("function");
    expect(typeof telnyx.telnyx).toBe("function");
    expect(typeof plivo.plivo).toBe("function");
    expect(typeof vonage.vonage).toBe("function");
    expect(typeof webhooks.parseSmsWebhook).toBe("function");
    expect(typeof testing.memory).toBe("function");
    expect(typeof testing.runSmsAdapterContract).toBe("function");
  });
});
