import { describe, expect, test } from "bun:test";
import { createSmsClient } from "../../src/core/client.js";
import { ConfigurationError, PolicyRejectedError } from "../../src/core/errors.js";
import { applySuppressionEvent, memorySuppressionList, suppressionPolicy } from "../../src/core/suppression.js";
import { memory } from "../../src/testing/memory.js";
import { parseSmsWebhooks } from "../../src/webhooks/index.js";
import { rejection } from "../helpers.js";

const optedOut = "+14155550123";

describe("memorySuppressionList", () => {
  test("adds, checks, and removes numbers", () => {
    const list = memorySuppressionList(["+14155550100"]);
    list.add(optedOut);
    list.add(optedOut);
    expect(list.has(optedOut)).toBe(true);
    expect(list.numbers()).toEqual(["+14155550100", optedOut]);
    list.remove(optedOut);
    expect(list.has(optedOut)).toBe(false);
  });
});

describe("suppressionPolicy", () => {
  test("blocks a suppressed recipient before any request and never falls back", async () => {
    const primary = memory({ name: "primary" });
    const backup = memory({ name: "backup" });
    const sms = createSmsClient({
      adapters: [primary, backup],
      fallback: "on-known-rejection",
      beforeSend: suppressionPolicy(memorySuppressionList([optedOut])),
    });
    const error = await rejection(sms.send({ to: optedOut, body: "Sale today" }));
    expect(error).toBeInstanceOf(PolicyRejectedError);
    expect(error).toMatchObject({ reason: "recipient suppressed", retrySafe: true });
    expect(primary.sent.length + backup.sent.length).toBe(0);
  });

  test("allows everyone else", async () => {
    const sms = createSmsClient({ adapters: [memory()], beforeSend: suppressionPolicy(memorySuppressionList([optedOut])) });
    await expect(sms.send({ to: "+14155550199", body: "hi" })).resolves.toMatchObject({ handoff: "accepted" });
  });

  test("works with an async list", async () => {
    const numbers = new Set([optedOut]);
    const list = {
      has: async (phoneNumber: string) => numbers.has(phoneNumber),
      add: async (phoneNumber: string) => void numbers.add(phoneNumber),
      remove: async (phoneNumber: string) => void numbers.delete(phoneNumber),
    };
    const sms = createSmsClient({ adapters: [memory()], beforeSend: suppressionPolicy(list) });
    await expect(sms.send({ to: optedOut, body: "hi" })).rejects.toBeInstanceOf(PolicyRejectedError);
  });

  test("fails the send with ConfigurationError when has() returns something other than a boolean", async () => {
    for (const unclear of [undefined, null, 0, "false", {}]) {
      const adapter = memory();
      const list = {
        has: async () => unclear as unknown as boolean,
        add: () => {},
        remove: () => {},
      };
      const sms = createSmsClient({ adapters: [adapter], beforeSend: suppressionPolicy(list) });
      await expect(sms.send({ to: "+14155550199", body: "hi" })).rejects.toBeInstanceOf(ConfigurationError);
      expect(adapter.sent).toHaveLength(0);
    }
  });
});

describe("applySuppressionEvent", () => {
  test("a webhook STOP suppresses the sender, and a later START lifts it", async () => {
    const list = memorySuppressionList();
    const sms = createSmsClient({ adapters: [memory()], beforeSend: suppressionPolicy(list) });
    const auth = { authorization: `Basic ${btoa("u:p")}` };
    const inbound = (text: string, id: string): Request =>
      new Request("https://example.com/bw", {
        method: "POST",
        headers: auth,
        body: JSON.stringify([{ type: "message-received", message: { id, from: optedOut, to: ["+15005550006"], text } }]),
      });

    for (const event of await parseSmsWebhooks({ provider: "bandwidth", request: inbound("STOP", "m1"), credentials: { username: "u", password: "p" } })) {
      expect(await applySuppressionEvent(list, event)).toBe("added");
    }
    await expect(sms.send({ to: optedOut, body: "hi" })).rejects.toBeInstanceOf(PolicyRejectedError);

    expect(await applySuppressionEvent(list, { type: "recipient.opted_in", from: optedOut })).toBe("removed");
    await expect(sms.send({ to: optedOut, body: "hi" })).resolves.toMatchObject({ handoff: "accepted" });
  });

  test.each([
    [{ type: "message.delivered", from: optedOut }],
    [{ type: "recipient.help", from: optedOut }],
    [{ type: "recipient.opted_out" }],
  ])("ignores %j", async (event) => {
    const list = memorySuppressionList();
    expect(await applySuppressionEvent(list, event)).toBe("ignored");
    expect(list.numbers()).toEqual([]);
  });
});
