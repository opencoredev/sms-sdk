import type { SmsAdapter, SmsFrom } from "../core/adapters.js";
import type { FetchLike } from "../core/http.js";
import { plivo } from "../providers/plivo.js";
import { telnyx } from "../providers/telnyx.js";
import { twilio } from "../providers/twilio.js";
import { vonage } from "../providers/vonage.js";

/** Providers the doctor CLI can check. */
export const DOCTOR_PROVIDERS = ["twilio", "telnyx", "plivo", "vonage"] as const;

/** A provider name accepted by `--adapter`. */
export type DoctorProvider = (typeof DOCTOR_PROVIDERS)[number];

/** Environment variables read by the doctor CLI and the examples. */
export const PROVIDER_ENV: Readonly<
  Record<DoctorProvider, { readonly required: readonly (readonly string[])[]; readonly optional: readonly string[]; readonly secret: readonly string[] }>
> = {
  twilio: {
    required: [["TWILIO_ACCOUNT_SID"], ["TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SID"]],
    optional: ["TWILIO_API_KEY_SECRET", "TWILIO_FROM", "TWILIO_MESSAGING_SERVICE_SID"],
    secret: ["TWILIO_AUTH_TOKEN", "TWILIO_API_KEY_SECRET"],
  },
  telnyx: {
    required: [["TELNYX_API_KEY"]],
    optional: ["TELNYX_FROM", "TELNYX_MESSAGING_PROFILE_ID"],
    secret: ["TELNYX_API_KEY"],
  },
  plivo: {
    required: [["PLIVO_AUTH_ID"], ["PLIVO_AUTH_TOKEN"]],
    optional: ["PLIVO_FROM", "PLIVO_POWERPACK_UUID"],
    secret: ["PLIVO_AUTH_TOKEN"],
  },
  vonage: {
    required: [["VONAGE_API_KEY", "VONAGE_APPLICATION_ID"]],
    optional: ["VONAGE_API_SECRET", "VONAGE_PRIVATE_KEY", "VONAGE_FROM"],
    secret: ["VONAGE_API_SECRET", "VONAGE_PRIVATE_KEY"],
  },
};

type Env = Readonly<Record<string, string | undefined>>;

/** Narrows a string to a {@link DoctorProvider}. */
export function isDoctorProvider(value: string | undefined): value is DoctorProvider {
  return DOCTOR_PROVIDERS.some((provider) => provider === value);
}

/**
 * Parses a sender from an environment value or `--from` flag: `+...` is
 * E.164, 3-8 digits is a short code, anything else is an alphanumeric ID.
 */
export function parseSenderValue(value: string): SmsFrom {
  if (value.startsWith("+")) {
    return `+${value.slice(1)}`;
  }
  if (/^\d{3,8}$/.test(value)) {
    return { shortCode: value };
  }
  return { senderId: value };
}

/** The configured default sender for a provider, and the text to confirm it with. */
export function configuredSender(provider: DoctorProvider, env: Env): { readonly from: SmsFrom; readonly display: string } | undefined {
  const value = (name: string): string | undefined => {
    const raw = env[name];
    return raw === undefined || raw.length === 0 ? undefined : raw;
  };
  const service =
    provider === "twilio"
      ? value("TWILIO_MESSAGING_SERVICE_SID")
      : provider === "plivo"
        ? value("PLIVO_POWERPACK_UUID")
        : undefined;
  const direct = value(`${provider.toUpperCase()}_FROM`);
  if (direct !== undefined) {
    return { from: parseSenderValue(direct), display: direct };
  }
  if (service !== undefined) {
    return { from: { messagingService: service }, display: service };
  }
  return undefined;
}

/**
 * Builds an adapter from environment variables. Throws `ConfigurationError`
 * (from the adapter) when values are malformed.
 */
export function adapterFromEnv(provider: DoctorProvider, env: Env, fetcher: FetchLike | undefined): SmsAdapter {
  const get = (name: string): string => env[name] ?? "";
  const sender = configuredSender(provider, env);
  const common = {
    ...(sender === undefined ? {} : { from: sender.from }),
    ...(fetcher === undefined ? {} : { fetch: fetcher }),
  };

  switch (provider) {
    case "twilio":
      return get("TWILIO_AUTH_TOKEN").length > 0
        ? twilio({ accountSid: get("TWILIO_ACCOUNT_SID"), authToken: get("TWILIO_AUTH_TOKEN"), ...common })
        : twilio({
            accountSid: get("TWILIO_ACCOUNT_SID"),
            apiKeySid: get("TWILIO_API_KEY_SID"),
            apiKeySecret: get("TWILIO_API_KEY_SECRET"),
            ...common,
          });
    case "telnyx":
      return telnyx({
        apiKey: get("TELNYX_API_KEY"),
        ...(get("TELNYX_MESSAGING_PROFILE_ID").length > 0 ? { messagingProfileId: get("TELNYX_MESSAGING_PROFILE_ID") } : {}),
        ...common,
      });
    case "plivo":
      return plivo({ authId: get("PLIVO_AUTH_ID"), authToken: get("PLIVO_AUTH_TOKEN"), ...common });
    case "vonage":
      return get("VONAGE_API_KEY").length > 0
        ? vonage({ apiKey: get("VONAGE_API_KEY"), apiSecret: get("VONAGE_API_SECRET"), ...common })
        : vonage({ applicationId: get("VONAGE_APPLICATION_ID"), privateKey: get("VONAGE_PRIVATE_KEY"), ...common });
    default: {
      const _exhaustive: never = provider;
      return _exhaustive;
    }
  }
}
