import type { SmsAdapter, SmsFrom } from "../core/adapters.js";
import { createSmsClient } from "../core/client.js";
import { isE164, maskPhoneNumber } from "../core/e164.js";
import { estimateSegments } from "../core/encoding.js";
import { isSmsError } from "../core/errors.js";
import type { FetchLike } from "../core/http.js";
import {
  adapterFromEnv,
  configuredSender,
  DOCTOR_PROVIDERS,
  isDoctorProvider,
  parseSenderValue,
  PROVIDER_ENV,
  type DoctorProvider,
} from "./config.js";

/** Where the doctor writes output. */
export type DoctorIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

/** Inputs for {@link runDoctor}. */
export type DoctorOptions = {
  /** Arguments after the executable, such as `["doctor", "--adapter", "twilio"]`. */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly io: DoctorIo;
  /** `fetch` used only by `--live`. Default: the global `fetch`. */
  readonly fetch?: FetchLike;
};

type DoctorArgs = {
  readonly adapter: DoctorProvider;
  readonly body: string;
  readonly to: string | undefined;
  readonly from: string | undefined;
  readonly live: boolean;
  readonly confirmTo: string | undefined;
  readonly confirmFrom: string | undefined;
};

type ParsedArgs = { readonly kind: "ok"; readonly args: DoctorArgs } | { readonly kind: "help" } | { readonly kind: "error"; readonly message: string };

/** Exit codes: 0 all checks passed, 1 a check or live send failed, 2 usage error. */
export type DoctorExitCode = 0 | 1 | 2;

const DEFAULT_BODY = "Test message from SMS SDK doctor.";

/** Usage text for `sms-sdk doctor`. */
export const DOCTOR_USAGE = `Usage: sms-sdk doctor --adapter <${DOCTOR_PROVIDERS.join("|")}> [options]

Checks local configuration without sending anything (dry run).

Options:
  --adapter <name>        Provider to check (required)
  --body <text>           Message body to preview (encoding and segments)
  --to <+E164>            Recipient to validate
  --from <sender>         Sender to validate (default: configured sender from env)
  --live                  Send one real, billable message. Requires --to,
                          --confirm-to <same number>, and --confirm-from <sender>
  --confirm-to <+E164>    Must equal --to when --live is set
  --confirm-from <sender> Must equal the sender when --live is set
  --help                  Show this help

The dry run makes no network calls. Credentials, sender registration, and
webhook reachability are reported as "not verified".`;

/**
 * Runs `sms-sdk doctor`. Dry-run by default: checks environment variables,
 * adapter configuration, sender and recipient format, capabilities, and the
 * segment estimate, without any network request. `--live` sends exactly one
 * message after the recipient and sender are confirmed.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorExitCode> {
  const { io } = options;
  const parsed = parseArgs(options.argv);
  if (parsed.kind === "help") {
    io.stdout(DOCTOR_USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    io.stderr(`error: ${parsed.message}`);
    io.stderr(DOCTOR_USAGE);
    return 2;
  }

  const args = parsed.args;
  let failed = false;
  const ok = (line: string): void => io.stdout(`[ok]           ${line}`);
  const fail = (line: string): void => {
    failed = true;
    io.stdout(`[fail]         ${line}`);
  };
  const info = (line: string): void => io.stdout(`[info]         ${line}`);
  const unverified = (line: string): void => io.stdout(`[not verified] ${line}`);

  io.stdout(`SMS SDK doctor: ${args.adapter} (${args.live ? "LIVE: will send one billable message" : "dry run, no network calls"})`);

  const envSpec = PROVIDER_ENV[args.adapter];
  for (const alternatives of envSpec.required) {
    const present = alternatives.filter((name) => (options.env[name] ?? "").length > 0);
    if (present.length > 0) {
      ok(`${present.join(", ")} set${present.some((name) => envSpec.secret.includes(name)) ? " (value hidden)" : ""}`);
    } else {
      fail(`${alternatives.join(" or ")} missing`);
    }
  }
  for (const name of envSpec.optional) {
    if ((options.env[name] ?? "").length > 0) {
      info(`${name} set${envSpec.secret.includes(name) ? " (value hidden)" : ""}`);
    }
  }

  let adapter: SmsAdapter | undefined;
  try {
    adapter = adapterFromEnv(args.adapter, options.env, options.fetch);
    ok(`adapter configuration is well-formed (support: ${adapter.support.status})`);
    for (const note of adapter.support.notes) {
      info(note);
    }
  } catch (error) {
    fail(`adapter configuration: ${error instanceof Error ? error.message : String(error)}`);
  }

  const configured = configuredSender(args.adapter, options.env);
  const senderText = args.from ?? configured?.display;
  const from: SmsFrom | undefined = args.from === undefined ? configured?.from : parseSenderValue(args.from);
  if (senderText === undefined) {
    fail(`no sender: pass --from or set ${args.adapter.toUpperCase()}_FROM`);
  } else {
    info(`sender: ${displaySender(senderText)}`);
  }

  const preview = estimateSegments(args.body);
  info(
    `body: ${preview.encoding.toUpperCase()}, ${preview.units} ${preview.encoding === "gsm7" ? "septets" : "UTF-16 units"}, ` +
      `${preview.segments} segment${preview.segments === 1 ? "" : "s"} (estimate, not a price quote)`,
  );
  if (preview.nonGsmCharacters.length > 0) {
    info(`characters forcing UCS-2: ${preview.nonGsmCharacters.map((character) => JSON.stringify(character)).join(" ")}`);
  }

  if (args.to !== undefined) {
    if (isE164(args.to)) {
      ok(`recipient ${maskPhoneNumber(args.to)} is valid E.164 (format only)`);
    } else {
      fail("recipient is not E.164 (expected +<country code><number>)");
    }
  }

  // Without --to, a placeholder recipient lets the sender and capability checks run.
  const validationTarget = args.to === undefined ? "+10000000000" : isE164(args.to) ? args.to : undefined;
  if (adapter !== undefined && from !== undefined && validationTarget !== undefined) {
    const sms = createSmsClient({ adapters: [adapter] });
    const validation = sms.validate({ to: validationTarget, from, body: args.body });
    if (validation.issues.length === 0) {
      ok("message passes local validation for this adapter");
    }
    for (const issue of validation.issues) {
      fail(`${issue.field}: ${issue.message}`);
    }
  }

  unverified("credentials (the dry run does not call the provider)");
  unverified("sender provisioning, 10DLC/toll-free registration, and campaign status");
  unverified("webhook URL reachability and signing configuration");

  if (!args.live) {
    io.stdout(failed ? "Result: problems found." : "Result: local checks passed. Nothing was sent.");
    return failed ? 1 : 0;
  }

  if (failed || adapter === undefined || from === undefined || senderText === undefined) {
    io.stderr("Live send skipped: fix the failed checks first.");
    return 1;
  }
  if (args.to === undefined || !isE164(args.to)) {
    io.stderr("Live send needs --to with an E.164 recipient.");
    return 2;
  }
  if (args.confirmTo !== args.to) {
    io.stderr("Live send needs --confirm-to with exactly the same number as --to.");
    return 2;
  }
  if (args.confirmFrom !== senderText) {
    io.stderr(`Live send needs --confirm-from ${senderText} (the sender that will be used).`);
    return 2;
  }

  io.stdout(`Sending one message to ${maskPhoneNumber(args.to)} from ${displaySender(senderText)} via ${args.adapter}...`);
  try {
    const result = await createSmsClient({ adapters: [adapter] }).send({ to: args.to, from, body: args.body });
    ok(`accepted by ${result.provider}: providerId ${result.providerId}, delivery ${result.delivery} (not handset delivery)`);
    return 0;
  } catch (error) {
    if (isSmsError(error)) {
      fail(`${error.code}: ${error.message} (retrySafe: ${String(error.retrySafe)})`);
    } else {
      fail(error instanceof Error ? error.message : String(error));
    }
    return 1;
  }
}

/** Parses doctor arguments. Exported for tests. */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || command === undefined) {
    return { kind: "help" };
  }
  if (command !== "doctor") {
    return { kind: "error", message: `unknown command "${command}"` };
  }

  const values = new Map<string, string>();
  let live = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--help" || flag === "-h") {
      return { kind: "help" };
    }
    if (flag === "--live") {
      live = true;
      continue;
    }
    if (flag === undefined || !["--adapter", "--body", "--to", "--from", "--confirm-to", "--confirm-from"].includes(flag)) {
      return { kind: "error", message: `unknown option "${String(flag)}"` };
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { kind: "error", message: `${flag} needs a value` };
    }
    values.set(flag, value);
    index += 1;
  }

  const adapter = values.get("--adapter");
  if (!isDoctorProvider(adapter)) {
    return { kind: "error", message: `--adapter must be one of ${DOCTOR_PROVIDERS.join(", ")}` };
  }
  return {
    kind: "ok",
    args: {
      adapter,
      body: values.get("--body") ?? DEFAULT_BODY,
      to: values.get("--to"),
      from: values.get("--from"),
      live,
      confirmTo: values.get("--confirm-to"),
      confirmFrom: values.get("--confirm-from"),
    },
  };
}

function displaySender(value: string): string {
  return value.startsWith("+") ? maskPhoneNumber(value) : value;
}
