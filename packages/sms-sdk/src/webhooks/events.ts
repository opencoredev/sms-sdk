/** Providers with a built-in webhook parser. */
export type WebhookProvider = "twilio" | "telnyx" | "plivo" | "vonage";

/** Fields every parsed webhook event carries. */
export type SmsEventBase = {
  readonly provider: WebhookProvider;
  /**
   * Stable key for deduplicating repeated deliveries of the same event.
   * Providers retry and reorder webhooks; store this key and skip repeats.
   */
  readonly dedupeKey: string;
  /** When the provider says the event happened, if the payload includes it. */
  readonly occurredAt?: Date;
  /** The verified provider payload: form fields as a string record, or parsed JSON. */
  readonly raw: unknown;
};

/** An inbound message. */
export type MessageReceivedEvent = SmsEventBase & {
  readonly type: "message.received";
  readonly providerId: string;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly mediaUrls: readonly string[];
};

/** Status event types, in lifecycle order. */
export type MessageStatusType =
  | "message.queued"
  | "message.sent"
  | "message.delivered"
  | "message.undelivered"
  | "message.filtered";

/**
 * A delivery status update for an outbound message. `message.filtered` is used
 * only when the provider's error code says the carrier or provider filtered it;
 * otherwise failures are `message.undelivered`.
 */
export type MessageStatusEvent = SmsEventBase & {
  readonly type: MessageStatusType;
  readonly providerId: string;
  /** The provider's own status value, such as `"undelivered"`. */
  readonly providerStatus: string;
  readonly errorCode?: string;
  readonly from?: string;
  readonly to?: string;
};

/**
 * An inbound opt-out, opt-in, or help request.
 *
 * `source: "provider"` means the provider flagged it (for example Twilio
 * `OptOutType`). `source: "keyword"` means this SDK matched the whole message
 * against a keyword list; carriers and providers may apply different rules.
 * The original inbound text is in `body`.
 */
export type RecipientKeywordEvent = SmsEventBase & {
  readonly type: "recipient.opted_out" | "recipient.opted_in" | "recipient.help";
  readonly providerId: string;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly source: "provider" | "keyword";
  readonly keyword: string;
};

/** A verified event this SDK does not map, such as a new provider status. Inspect `raw`. */
export type UnrecognizedEvent = SmsEventBase & {
  readonly type: "unrecognized";
  /** The provider's event type or status that was not mapped. */
  readonly providerEventType: string;
};

/** A normalized, verified webhook event. */
export type SmsEvent = MessageReceivedEvent | MessageStatusEvent | RecipientKeywordEvent | UnrecognizedEvent;

/** Whole-message keywords treated as opt-out requests. */
export const OPT_OUT_KEYWORDS: readonly string[] = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];

/** Whole-message keywords treated as help requests. */
export const HELP_KEYWORDS: readonly string[] = ["HELP", "INFO"];

/** A keyword match from {@link detectKeyword}. */
export type KeywordMatch = { readonly kind: "opted_out" | "help"; readonly keyword: string };

/**
 * Matches a whole inbound message against {@link OPT_OUT_KEYWORDS} and
 * {@link HELP_KEYWORDS}, ignoring case, surrounding whitespace, and trailing
 * `.`, `!`, or `?`. "Please stop texting me" does not match.
 */
export function detectKeyword(body: string): KeywordMatch | undefined {
  const normalized = body.trim().replace(/[.!?]+$/, "").trim().toUpperCase();
  if (OPT_OUT_KEYWORDS.includes(normalized)) {
    return { kind: "opted_out", keyword: normalized };
  }
  if (HELP_KEYWORDS.includes(normalized)) {
    return { kind: "help", keyword: normalized };
  }
  return undefined;
}

/**
 * Builds the event for an inbound message, applying provider-declared signals
 * first and keyword detection second (when enabled).
 */
export function inboundEvent(input: {
  readonly base: SmsEventBase;
  readonly providerId: string;
  readonly from: string;
  readonly to: string;
  readonly body: string;
  readonly mediaUrls: readonly string[];
  readonly providerSignal: "opted_out" | "opted_in" | "help" | undefined;
  readonly providerKeyword?: string;
  readonly detectKeywords: boolean;
}): MessageReceivedEvent | RecipientKeywordEvent {
  const common = { ...input.base, providerId: input.providerId, from: input.from, to: input.to, body: input.body };
  if (input.providerSignal !== undefined) {
    return {
      ...common,
      type: `recipient.${input.providerSignal}`,
      source: "provider",
      keyword: input.providerKeyword ?? input.body.trim().toUpperCase(),
    };
  }
  if (input.detectKeywords) {
    const match = detectKeyword(input.body);
    if (match !== undefined) {
      return { ...common, type: `recipient.${match.kind}`, source: "keyword", keyword: match.keyword };
    }
  }
  return { ...common, type: "message.received", mediaUrls: input.mediaUrls };
}
