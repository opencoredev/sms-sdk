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
import { isValidProviderOptionsSpec } from "../core/client.js";
import { ConfigurationError } from "../core/errors.js";
import { freezeCapabilities, freezeProviderOptionsSpec, freezeSender, isRecord } from "../core/http.js";

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

/**
 * An in-memory adapter that records sends and never touches the network.
 * `getMessage` finds messages it accepted.
 */
export type MemoryAdapter = SmsAdapter & {
  /** Every send, in order, including rejected and unknown ones. */
  readonly sent: readonly MemorySentMessage[];
  /** Queues more outcomes. */
  enqueue(...outcomes: MemoryOutcome[]): void;
  /** Clears recorded sends and queued outcomes. */
  reset(): void;
};

const MEMORY_CAPABILITIES: SmsCapabilities = freezeCapabilities({
  sendText: true,
  mms: true,
  scheduling: true,
  validityPeriod: { minSec: 1, maxSec: 604_800 },
  webhookUrlOverride: true,
  inbound: false,
  deliveryReceipts: false,
  senderTypes: ["long_code", "toll_free", "short_code", "alphanumeric", "messaging_service"],
  nativeIdempotency: false,
});

const MEMORY_SUPPORT: AdapterSupport = Object.freeze({
  status: "supported",
  notes: Object.freeze(["Test adapter: records sends in memory."]),
});

/**
 * Creates an in-memory adapter for tests and local development.
 *
 * ```ts
 * const adapter = memory({ outcomes: [rejectedOutcome("sender")] });
 * const sms = createSmsClient({ adapters: [adapter] });
 * ```
 */
export function memory(options: MemoryAdapterOptions = {}): MemoryAdapter {
  let name: string;
  let queue: MemoryOutcome[];
  let defaultFrom: SmsFrom;
  let capabilities: SmsCapabilities;
  let providerOptions: ProviderOptionsSpec | undefined;
  try {
    if (!isRecord(options)) {
      throw new ConfigurationError("Memory adapter options must be an object.");
    }
    const rawName = options.name;
    if (rawName !== undefined && (typeof rawName !== "string" || rawName.length === 0)) {
      throw new ConfigurationError("Memory adapter name must be a non-empty string.");
    }
    name = rawName ?? "memory";
    const rawOutcomes = options.outcomes;
    if (rawOutcomes !== undefined && !Array.isArray(rawOutcomes)) {
      throw new ConfigurationError("Memory adapter outcomes must be an array.");
    }
    queue = rawOutcomes === undefined ? [] : rawOutcomes.map(snapshotMemoryOutcome);
    const sourceCaps = options.capabilities;
    const rawCaps = sourceCaps === undefined ? undefined : snapshotMemoryCapabilities(sourceCaps);
    capabilities = freezeCapabilities({
      sendText: rawCaps?.sendText ?? MEMORY_CAPABILITIES.sendText,
      mms: rawCaps?.mms ?? MEMORY_CAPABILITIES.mms,
      scheduling: rawCaps?.scheduling ?? MEMORY_CAPABILITIES.scheduling,
      validityPeriod:
        rawCaps && "validityPeriod" in rawCaps
          ? (rawCaps.validityPeriod ?? null)
          : MEMORY_CAPABILITIES.validityPeriod,
      webhookUrlOverride: rawCaps?.webhookUrlOverride ?? MEMORY_CAPABILITIES.webhookUrlOverride,
      inbound: rawCaps?.inbound ?? MEMORY_CAPABILITIES.inbound,
      deliveryReceipts: rawCaps?.deliveryReceipts ?? MEMORY_CAPABILITIES.deliveryReceipts,
      senderTypes: rawCaps?.senderTypes ?? MEMORY_CAPABILITIES.senderTypes,
      nativeIdempotency: rawCaps?.nativeIdempotency ?? MEMORY_CAPABILITIES.nativeIdempotency,
    });
    const rawProviderOptions = options.providerOptions;
    if (rawProviderOptions !== undefined) {
      if (!isRecord(rawProviderOptions)) {
        throw new ConfigurationError("Memory adapter providerOptions must be a valid ProviderOptionsSpec.");
      }
      const frozenSpec = freezeProviderOptionsSpec(rawProviderOptions);
      if (!isValidProviderOptionsSpec(frozenSpec)) {
        throw new ConfigurationError("Memory adapter providerOptions must be a valid ProviderOptionsSpec.");
      }
      providerOptions = frozenSpec;
    }
    defaultFrom = freezeSender(options.from ?? "+15005550006");
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw new ConfigurationError("Memory adapter options could not be read.");
  }
  const sent: MemorySentMessage[] = [];
  let counter = 0;

  return {
    name,
    capabilities,
    support: MEMORY_SUPPORT,
    ...(providerOptions === undefined ? {} : { providerOptions }),
    defaultFrom,
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

    // Finds messages this adapter accepted, with the delivery it reported then.
    async getMessage(providerId) {
      const accepted = sent.find((entry) => entry.outcome.kind === "accepted" && entry.outcome.providerId === providerId);
      if (accepted === undefined || accepted.outcome.kind !== "accepted") {
        return { kind: "not_found" };
      }
      const delivery = accepted.outcome.delivery;
      return { kind: "found", status: { provider: name, providerId, delivery, providerStatus: delivery } };
    },

    enqueue(...outcomes) {
      const snapped = outcomes.map(snapshotMemoryOutcome);
      queue.push(...snapped);
    },

    reset() {
      sent.length = 0;
      queue.length = 0;
      counter = 0;
    },
  };
}

const MEMORY_BOOLEAN_CAPABILITIES = [
  "mms",
  "scheduling",
  "webhookUrlOverride",
  "inbound",
  "deliveryReceipts",
  "nativeIdempotency",
] as const;

function snapshotMemoryCapabilities(value: unknown): Partial<SmsCapabilities> {
  if (!isRecord(value)) {
    throw new ConfigurationError("Memory adapter capabilities must be an object.");
  }
  const copy: Record<string, unknown> = {};
  if ("sendText" in value) {
    const sendText = value["sendText"];
    if (sendText !== undefined && sendText !== true) {
      throw new ConfigurationError("Memory adapter capabilities.sendText must be true.");
    }
    if (sendText !== undefined) {
      copy["sendText"] = sendText;
    }
  }
  for (const key of MEMORY_BOOLEAN_CAPABILITIES) {
    if (key in value) {
      const flag = value[key];
      if (flag !== undefined && typeof flag !== "boolean") {
        throw new ConfigurationError(`Memory adapter capabilities.${key} must be a boolean.`);
      }
      if (flag !== undefined) {
        copy[key] = flag;
      }
    }
  }
  if ("senderTypes" in value) {
    const senderTypes = value["senderTypes"];
    if (senderTypes !== undefined) {
      if (
        !Array.isArray(senderTypes) ||
        !senderTypes.every((item) => typeof item === "string" && MEMORY_CAPABILITIES.senderTypes.includes(item as never))
      ) {
        throw new ConfigurationError("Memory adapter capabilities.senderTypes must contain recognized sender types.");
      }
      copy["senderTypes"] = [...senderTypes];
    }
  }
  if ("validityPeriod" in value) {
    const range = value["validityPeriod"];
    if (range === null) {
      copy["validityPeriod"] = null;
    } else if (range !== undefined) {
      if (!isRecord(range)) {
        throw new ConfigurationError("Memory adapter validityPeriod must be a range or null.");
      }
      const minSec = range["minSec"];
      const maxSec = range["maxSec"];
      if (
        typeof minSec !== "number" ||
        !Number.isInteger(minSec) ||
        minSec <= 0 ||
        typeof maxSec !== "number" ||
        !Number.isInteger(maxSec) ||
        maxSec < minSec
      ) {
        throw new ConfigurationError("Memory adapter validityPeriod must be a positive integer range.");
      }
      copy["validityPeriod"] = { minSec, maxSec };
    }
  }
  return copy as Partial<SmsCapabilities>;
}

const VALID_MEMORY_DELIVERIES = new Set(["queued", "sent", "delivered", "undelivered", "filtered", "unknown"]);
const VALID_MEMORY_CATEGORIES = new Set(["auth", "rate_limited", "sender", "account", "recipient", "compliance", "request"]);
const VALID_MEMORY_UNKNOWN_REASONS = new Set([
  "network",
  "timeout",
  "aborted",
  "malformed_response",
  "server_error",
  "unexpected_status",
  "adapter_exception",
]);

function snapshotMemoryOutcome(value: unknown): MemoryOutcome {
  const invalid = (): ConfigurationError =>
    new ConfigurationError("Memory adapter outcomes must contain valid outcomes or functions.");
  try {
    if (typeof value === "function") {
      return value as MemoryOutcome;
    }
    if (!isRecord(value)) {
      throw invalid();
    }
    const kind = value["kind"];
    switch (kind) {
      case "accepted": {
        const providerId = value["providerId"];
        const delivery = value["delivery"];
        if (
          typeof providerId !== "string" ||
          providerId.length === 0 ||
          typeof delivery !== "string" ||
          !VALID_MEMORY_DELIVERIES.has(delivery)
        ) {
          throw invalid();
        }
        return Object.freeze({
          kind: "accepted",
          providerId,
          delivery: delivery as Delivery,
        });
      }
      case "rejected": {
        const category = value["category"];
        const rawDetails = value["details"];
        const retryAfterMs = value["retryAfterMs"];
        if (
          typeof category !== "string" ||
          !VALID_MEMORY_CATEGORIES.has(category) ||
          !isRecord(rawDetails)
        ) {
          throw invalid();
        }
        const detailsProvider = rawDetails["provider"];
        if (typeof detailsProvider !== "string" || detailsProvider.length === 0) {
          throw invalid();
        }
        if (
          retryAfterMs !== undefined &&
          (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 0)
        ) {
          throw invalid();
        }
        const httpStatus = rawDetails["httpStatus"];
        const code = rawDetails["code"];
        const message = rawDetails["message"];
        const requestId = rawDetails["requestId"];
        const details = Object.freeze({
          provider: detailsProvider,
          ...(typeof httpStatus === "number" ? { httpStatus } : {}),
          ...(typeof code === "string" ? { code } : {}),
          ...(typeof message === "string" ? { message } : {}),
          ...(typeof requestId === "string" ? { requestId } : {}),
        });
        return Object.freeze({
          kind: "rejected",
          category: category as RejectionCategory,
          details,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        });
      }
      case "unknown": {
        const reason = value["reason"];
        const rawDetails = value["details"];
        if (typeof reason !== "string" || !VALID_MEMORY_UNKNOWN_REASONS.has(reason)) {
          throw invalid();
        }
        if (rawDetails !== undefined && !isRecord(rawDetails)) {
          throw invalid();
        }
        const details =
          rawDetails === undefined
            ? undefined
            : (() => {
                const detailsProvider = rawDetails["provider"];
                if (typeof detailsProvider !== "string" || detailsProvider.length === 0) {
                  throw invalid();
                }
                const httpStatus = rawDetails["httpStatus"];
                const code = rawDetails["code"];
                const message = rawDetails["message"];
                const requestId = rawDetails["requestId"];
                return Object.freeze({
                  provider: detailsProvider,
                  ...(typeof httpStatus === "number" ? { httpStatus } : {}),
                  ...(typeof code === "string" ? { code } : {}),
                  ...(typeof message === "string" ? { message } : {}),
                  ...(typeof requestId === "string" ? { requestId } : {}),
                });
              })();
        return Object.freeze({
          kind: "unknown",
          reason: reason as UnknownReason,
          ...(details === undefined ? {} : { details }),
        });
      }
      default:
        throw invalid();
    }
  } catch (error) {
    if (error instanceof ConfigurationError) {
      throw error;
    }
    throw invalid();
  }
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
