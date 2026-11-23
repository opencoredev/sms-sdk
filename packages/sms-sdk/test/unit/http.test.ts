import { describe, expect, test } from "bun:test";
import { createSmsClient } from "../../src/core/client.js";
import { ConfigurationError, HandoffUnknownError } from "../../src/core/errors.js";
import { basicAuthorization, exchange, MAX_RESPONSE_BYTES, type FetchLike } from "../../src/core/http.js";
import { bandwidth } from "../../src/providers/bandwidth.js";
import { twilio } from "../../src/providers/twilio.js";
import { parseSmsWebhook } from "../../src/webhooks/index.js";
import { rejection, TWILIO_SID } from "../helpers.js";

const signal = new AbortController().signal;

/** A response whose body streams `chunks` chunks of `chunkBytes` bytes, without a Content-Length header. */
function streamed(chunks: number, chunkBytes: number, status = 201): { readonly fetch: FetchLike; readonly pulled: () => number } {
  let pulled = 0;
  const chunk = new Uint8Array(chunkBytes).fill(0x61);
  return {
    pulled: () => pulled,
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulled >= chunks) {
              controller.close();
              return;
            }
            pulled += 1;
            controller.enqueue(chunk);
          },
        }),
        { status },
      ),
  };
}

describe("exchange body limit", () => {
  test("reads a body up to the limit", async () => {
    const source = streamed(4, 1024);
    const result = await exchange(source.fetch, "https://example.test", { method: "POST", headers: {}, body: "", signal });
    expect(result).toMatchObject({ kind: "response", status: 201 });
    expect(result.kind === "response" && result.text.length).toBe(4096);
  });

  test("stops reading a streamed body past the limit", async () => {
    const chunkBytes = 64 * 1024;
    const source = streamed(1_000, chunkBytes);
    const result = await exchange(source.fetch, "https://example.test", { method: "POST", headers: {}, body: "", signal });
    expect(result).toMatchObject({ kind: "failed", reason: "malformed_response" });
    expect(source.pulled()).toBeLessThanOrEqual(MAX_RESPONSE_BYTES / chunkBytes + 2);
  });

  test("refuses a declared Content-Length over the limit without reading the body", async () => {
    let pulls = 0;
    const fetcher: FetchLike = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(1));
          },
        }),
        { status: 200, headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) } },
      );
    const result = await exchange(fetcher, "https://example.test", { method: "POST", headers: {}, body: "", signal });
    expect(result).toMatchObject({ kind: "failed", reason: "malformed_response" });
    // A stream may pull once on its own to fill its queue; the client never reads further.
    expect(pulls).toBeLessThanOrEqual(1);
  });

  test("an oversized provider response is an unknown outcome, never a resend", async () => {
    const source = streamed(20, 64 * 1024);
    const sms = createSmsClient({
      adapters: [twilio({ accountSid: TWILIO_SID, authToken: "token", from: "+15005550006", fetch: source.fetch })],
    });
    const error = await rejection(sms.send({ to: "+14155550123", body: "hi" }));
    expect(error).toBeInstanceOf(HandoffUnknownError);
    expect(error).toMatchObject({ reason: "malformed_response", retrySafe: false });
  });
});

describe("Basic authorization encoding", () => {
  test("encodes Latin-1 credentials", () => {
    expect(basicAuthorization("user", "pass")).toBe(`Basic ${btoa("user:pass")}`);
  });

  test("throws ConfigurationError for characters outside Latin-1", () => {
    expect(() => basicAuthorization("user", "pass’word")).toThrow(ConfigurationError);
  });

  test("adapter construction throws ConfigurationError, not a DOMException", () => {
    expect(() => twilio({ accountSid: TWILIO_SID, authToken: "token✓" })).toThrow(ConfigurationError);
    expect(() =>
      bandwidth({ userId: "u", apiToken: "token", apiSecret: "secret\u{1F511}", applicationId: "app" }),
    ).toThrow(ConfigurationError);
  });

  test("webhook Basic credentials outside Latin-1 throw ConfigurationError", async () => {
    const request = new Request("https://example.test/bw", { method: "POST", body: "[]", headers: { authorization: "Basic x" } });
    await expect(
      parseSmsWebhook({ provider: "bandwidth", request, credentials: { username: "u", password: "p’" } }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
