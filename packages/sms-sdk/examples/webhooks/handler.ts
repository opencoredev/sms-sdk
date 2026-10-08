/**
 * A plain fetch handler for SMS webhooks: works with Bun.serve, Deno.serve,
 * Hono, Next.js route handlers, and Cloudflare Workers.
 */
import { parseSmsWebhook, WebhookSignatureError, type SmsEvent } from "@opencoredev/sms-sdk/webhooks";

export type WebhookEnv = {
  readonly TWILIO_AUTH_TOKEN: string;
  readonly TELNYX_PUBLIC_KEY: string;
  /** Public base URL configured in the provider consoles, such as https://example.com. */
  readonly PUBLIC_BASE_URL: string;
};

/** Your application logic. Replace the in-memory set with a database table keyed by dedupeKey. */
export type EventSink = {
  readonly seen: Set<string>;
  readonly handled: SmsEvent[];
};

export function createWebhookHandler(env: WebhookEnv, sink: EventSink): (request: Request) => Promise<Response> {
  return async (request) => {
    const path = new URL(request.url).pathname;
    let event: SmsEvent;
    try {
      if (path === "/webhooks/twilio") {
        event = await parseSmsWebhook({
          provider: "twilio",
          request,
          publicUrl: `${env.PUBLIC_BASE_URL}/webhooks/twilio`,
          credentials: { authToken: env.TWILIO_AUTH_TOKEN },
        });
      } else if (path === "/webhooks/telnyx") {
        event = await parseSmsWebhook({ provider: "telnyx", request, credentials: { publicKey: env.TELNYX_PUBLIC_KEY } });
      } else {
        return new Response("Not found", { status: 404 });
      }
    } catch (error) {
      if (error instanceof WebhookSignatureError) {
        return new Response("Invalid signature", { status: 401 });
      }
      throw error;
    }

    // Providers retry and reorder deliveries. Process each event once.
    if (sink.seen.has(event.dedupeKey)) {
      return new Response(null, { status: 204 });
    }
    sink.seen.add(event.dedupeKey);
    sink.handled.push(event);

    switch (event.type) {
      case "recipient.opted_out":
        // Add event.from to your suppression list; use beforeSend to enforce it.
        break;
      case "message.delivered":
      case "message.undelivered":
      case "message.filtered":
        // Update the message row matched by event.providerId.
        break;
      default:
        break;
    }
    return new Response(null, { status: 204 });
  };
}
