/**
 * Send one SMS through Twilio.
 *
 * Runs against a mocked Twilio API by default, so nothing is sent:
 *   bun examples/twilio/index.ts
 *
 * To send a real (billable) message, set SMS_EXAMPLE_LIVE=true plus
 * TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, and SMS_EXAMPLE_TO.
 */
import { fileURLToPath } from "node:url";
import { createSmsClient, isE164, type SmsSendResult } from "@opencoredev/sms-sdk";
import { mockFetch } from "@opencoredev/sms-sdk/testing";
import { twilio } from "@opencoredev/sms-sdk/twilio";

type Env = Readonly<Record<string, string | undefined>>;

export async function run(env: Env): Promise<SmsSendResult> {
  const live = env["SMS_EXAMPLE_LIVE"] === "true";
  const from = env["TWILIO_FROM"] ?? "+15005550006";
  const to = env["SMS_EXAMPLE_TO"] ?? "+14155550123";
  if (!isE164(from) || !isE164(to)) {
    throw new Error("TWILIO_FROM and SMS_EXAMPLE_TO must be E.164 numbers such as +14155550123.");
  }

  // Offline: answer like Twilio's Message resource does (201 with a SID).
  const fakeTwilio = mockFetch({ status: 201, body: { sid: "SM0123456789abcdef0123456789abcdef", status: "queued" } });

  const sms = createSmsClient({
    adapters: [
      twilio({
        accountSid: env["TWILIO_ACCOUNT_SID"] ?? "AC0123456789abcdef0123456789abcdef",
        authToken: env["TWILIO_AUTH_TOKEN"] ?? "example-auth-token",
        from,
        ...(live ? {} : { fetch: fakeTwilio.fetch }),
      }),
    ],
  });

  return sms.send({ to, body: "Your order has shipped.", idempotencyKey: "order:123:shipped:v1" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await run(process.env);
  console.log(`${result.provider} accepted ${result.providerId} (handoff ${result.handoff}, delivery ${result.delivery})`);
}
