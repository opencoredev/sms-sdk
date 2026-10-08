/**
 * Twilio first, Telnyx as an explicit fallback for known rejections.
 *
 * Offline by default: the mocked Twilio API rejects the sender (error 21606),
 * which is fallback-eligible, and the mocked Telnyx API accepts.
 *   bun examples/failover/index.ts
 */
import { fileURLToPath } from "node:url";
import {
  AllProvidersRejectedError,
  createSmsClient,
  HandoffUnknownError,
  ProviderRejectedError,
  type SmsSendResult,
} from "@opencoredev/sms-sdk";
import { telnyx } from "@opencoredev/sms-sdk/telnyx";
import { mockFetch } from "@opencoredev/sms-sdk/testing";
import { twilio } from "@opencoredev/sms-sdk/twilio";

export type FailoverOutcome =
  | { readonly kind: "sent"; readonly result: SmsSendResult }
  | { readonly kind: "rejected"; readonly message: string }
  | { readonly kind: "unknown"; readonly message: string };

export async function run(): Promise<FailoverOutcome> {
  const fakeTwilio = mockFetch({
    status: 400,
    body: { code: 21606, message: "The 'From' phone number is not a valid, SMS-capable inbound phone number", status: 400 },
  });
  const fakeTelnyx = mockFetch({
    status: 200,
    body: { data: { id: "40385f64-5717-4562-b3fc-2c963f66afa6", to: [{ phone_number: "+14155550123", status: "queued" }] } },
  });

  const sms = createSmsClient({
    adapters: [
      // Each provider sends from a number provisioned on that provider.
      twilio({ accountSid: "AC0123456789abcdef0123456789abcdef", authToken: "example", from: "+15005550006", fetch: fakeTwilio.fetch }),
      telnyx({ apiKey: "example", from: "+15005550007", fetch: fakeTelnyx.fetch }),
    ],
    fallback: "on-known-rejection",
  });

  try {
    const result = await sms.send({
      to: "+14155550123",
      body: "Your appointment is tomorrow at 9:00.",
      idempotencyKey: "appointment:123:reminder:v1",
    });
    return { kind: "sent", result };
  } catch (error) {
    if (error instanceof HandoffUnknownError) {
      // The message may have been accepted. Do not resend; reconcile first.
      return { kind: "unknown", message: error.message };
    }
    if (error instanceof AllProvidersRejectedError || error instanceof ProviderRejectedError) {
      // Nothing was accepted, so error.retrySafe is true.
      return { kind: "rejected", message: error.message };
    }
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outcome = await run();
  if (outcome.kind === "sent") {
    console.log(`Sent via ${outcome.result.provider} after trying ${outcome.result.attemptedProviders.join(" -> ")}`);
  } else {
    console.log(`${outcome.kind}: ${outcome.message}`);
  }
}
