/**
 * Demonstrates the webhook handler with locally signed requests.
 *   bun examples/webhooks/index.ts
 *
 * To serve it for real: Bun.serve({ fetch: createWebhookHandler(env, sink) }).
 */
import { fileURLToPath } from "node:url";
import { generateTelnyxKeyPair, signedTelnyxRequest, signedTwilioRequest } from "@opencoredev/sms-sdk/testing";
import { createWebhookHandler, type EventSink } from "./handler.js";

export async function run(): Promise<{ statuses: number[]; sink: EventSink }> {
  const telnyxKeys = await generateTelnyxKeyPair();
  const env = { TWILIO_AUTH_TOKEN: "example-auth-token", TELNYX_PUBLIC_KEY: telnyxKeys.publicKey, PUBLIC_BASE_URL: "https://example.com" };
  const sink: EventSink = { seen: new Set(), handled: [] };
  const handle = createWebhookHandler(env, sink);

  const twilioStop = () =>
    signedTwilioRequest({
      authToken: env.TWILIO_AUTH_TOKEN,
      url: "https://example.com/webhooks/twilio",
      params: { MessageSid: "SM0123456789abcdef0123456789abcdef", From: "+14155550123", To: "+15005550006", Body: "STOP" },
    });
  const telnyxDelivered = await signedTelnyxRequest({
    privateKey: telnyxKeys.privateKey,
    url: "https://example.com/webhooks/telnyx",
    body: {
      data: {
        event_type: "message.finalized",
        id: "evt-1",
        occurred_at: new Date().toISOString(),
        payload: { id: "40385f64-5717-4562-b3fc-2c963f66afa6", to: [{ phone_number: "+14155550123", status: "delivered" }] },
      },
    },
  });
  const forged = new Request("https://example.com/webhooks/twilio", {
    method: "POST",
    headers: { "x-twilio-signature": "forged" },
    body: "Body=STOP",
  });

  const statuses = [
    (await handle(await twilioStop())).status,
    (await handle(await twilioStop())).status, // duplicate delivery
    (await handle(telnyxDelivered)).status,
    (await handle(forged)).status,
  ];
  return { statuses, sink };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { statuses, sink } = await run();
  console.log(`HTTP statuses: ${statuses.join(", ")}`);
  for (const event of sink.handled) {
    console.log(`${event.provider}: ${event.type} (${event.dedupeKey})`);
  }
}
