import type {
  AdapterMessage,
  AdapterSendOutcome,
  AdapterSupport,
  Delivery,
  ProviderOptionsSpec,
  RejectionCategory,
  SendContext,
  SmsAdapter,
  SmsCapabilities,
  SmsFrom,
  UnknownReason,
} from "../core/adapters.js";

/** A scripted outcome, or a function that computes one per send. */
export type MemoryOutcome =
  | AdapterSendOutcome
  | ((message: AdapterMessage, context: SendContext) => AdapterSendOutcome | Promise<AdapterSendOutcome>);

/** One send recorded by a {@link MemoryAdapter}. */
export type MemorySentMessage = {
  readonly message: AdapterMessage;
  readonly attempt: number;
  readonly idempotencyKey: string | undefined;
  readonly outcome: AdapterSendOutcome;
};

/** Options for {@link memory}. */
export type MemoryAdapterOptions = {
  /** Adapter name. Default `"memory"`. */
  readonly name?: string;
  /** Default sender. Default `+15005550006`. */
  readonly from?: SmsFrom;
  /** Capability overrides. Defaults allow every field and sender type. */
  readonly capabilities?: Partial<SmsCapabilities>;
  /**
   * Provider options to accept, such as `TWILIO_PROVIDER_OPTIONS` with
   * `name: "twilio"`. Parsed fields are recorded in `sent[i].message.providerFields`.
   * Without it, any `providerOptions` entry for this adapter is rejected.
   */
  readonly providerOptions?: ProviderOptionsSpec;
  /** Outcomes used in order, one per send. After they run out, sends are accepted. */
  readonly outcomes?: readonly MemoryOutcome[];
};

/** An in-memory adapter that records sends and never touches the network. */
export type MemoryAdapter = SmsAdapter & {
  /** Every send, in order, including rejected and unknown ones. */
  readonly sent: readonly MemorySentMessage[];
  /** Queues more outcomes. */
  enqueue(...outcomes: MemoryOutcome[]): void;
  /** Clears recorded sends and queued outcomes. */
  reset(): void;
};

const MEMORY_CAPABILITIES: SmsCapabilities = {
  sendText: true,
  mms: true,
  scheduling: true,
  validityPeriod: { minSec: 1, maxSec: 604_800 },
  webhookUrlOverride: true,
  inbound: false,
  deliveryReceipts: false,
  senderTypes: ["long_code", "toll_free", "short_code", "alphanumeric", "messaging_service"],
  nativeIdempotency: false,
};

const MEMORY_SUPPORT: AdapterSupport = { status: "supported", notes: ["Test adapter: records sends in memory."] };

/**
 * Creates an in-memory adapter for tests and local development.
 *
 * ```ts
 * const adapter = memory({ outcomes: [rejectedOutcome("sender")] });
 * const sms = createSmsClient({ adapters: [adapter] });
 * ```
 */
export function memory(options: MemoryAdapterOptions = {}): MemoryAdapter {
  const name = options.name ?? "memory";
  const sent: MemorySentMessage[] = [];
  const queue: MemoryOutcome[] = [...(options.outcomes ?? [])];
  let counter = 0;

  return {
    name,
    capabilities: { ...MEMORY_CAPABILITIES, ...options.capabilities },
    support: MEMORY_SUPPORT,
    ...(options.providerOptions === undefined ? {} : { providerOptions: options.providerOptions }),
    defaultFrom: options.from ?? "+15005550006",
    sent,

    async send(message, context) {
      const next = queue.shift();
      counter += 1;
      const outcome =
        next === undefined
          ? acceptedOutcome(`${name}_${counter}`)
          : typeof next === "function"
            ? await next(message, context)
            : next;
      sent.push({ message, attempt: context.attempt, idempotencyKey: context.idempotencyKey, outcome });
      return outcome;
    },

    enqueue(...outcomes) {
      queue.push(...outcomes);
    },

    reset() {
      sent.length = 0;
      queue.length = 0;
      counter = 0;
    },
  };
}

/** An accepted outcome. */
export function acceptedOutcome(providerId: string, delivery: Delivery = "queued"): AdapterSendOutcome {
  return { kind: "accepted", providerId, delivery };
}

/** A rejected outcome with redacted details for a fake provider. */
export function rejectedOutcome(
  category: RejectionCategory,
  options: { readonly provider?: string; readonly retryAfterMs?: number; readonly code?: string } = {},
): AdapterSendOutcome {
  return {
    kind: "rejected",
    category,
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    details: {
      provider: options.provider ?? "memory",
      ...(options.code === undefined ? {} : { code: options.code }),
      message: `Simulated ${category} rejection.`,
    },
  };
}

/** An unknown outcome. */
export function unknownOutcome(reason: UnknownReason = "network"): AdapterSendOutcome {
  return { kind: "unknown", reason };
}
