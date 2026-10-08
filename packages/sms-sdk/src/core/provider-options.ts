import type { ProviderOptionField, ProviderOptionValue, ProviderWireField, SmsAdapter, ValidationIssue } from "./adapters.js";
import { isRecord } from "./http.js";

/** Outcome of parsing one adapter's `providerOptions` entry. */
export type ProviderOptionsParse =
  | { readonly kind: "ok"; readonly fields: readonly ProviderWireField[] }
  | { readonly kind: "issues"; readonly issues: readonly ValidationIssue[] };

const NO_FIELDS: ProviderOptionsParse = { kind: "ok", fields: [] };

/**
 * Checks the shape of `providerOptions` and every entry that names a
 * configured adapter. Entries for adapters the client does not have are
 * ignored. Issues name option keys only, never values, which may hold
 * personal data.
 */
export function validateProviderOptions(adapters: readonly SmsAdapter[], providerOptions: unknown): ValidationIssue[] {
  if (providerOptions === undefined) {
    return [];
  }
  if (!isRecord(providerOptions)) {
    return [invalid(undefined, "providerOptions must be an object keyed by adapter name.")];
  }
  return adapters.flatMap((adapter) => {
    const parsed = parseProviderOptions(adapter, providerOptions[adapter.name]);
    return parsed.kind === "issues" ? [...parsed.issues] : [];
  });
}

/** Names of `adapters` that have an entry in `providerOptions`. */
export function adaptersWithProviderOptions(adapters: readonly SmsAdapter[], providerOptions: unknown): string[] {
  if (!isRecord(providerOptions)) {
    return [];
  }
  return adapters.filter((adapter) => providerOptions[adapter.name] !== undefined).map((adapter) => adapter.name);
}

/**
 * Parses one adapter's entry into wire fields, in the order typed options are
 * declared followed by `extra` in insertion order.
 *
 * Rejects, as `unsupported_field`: an entry for an adapter without a
 * `providerOptions` spec, an unknown typed key, and an `extra` key that
 * matches (case-insensitively) a wire name the adapter sets itself or a typed
 * option's wire name. Rejects wrong value types as `invalid_field`.
 */
export function parseProviderOptions(adapter: SmsAdapter, entry: unknown): ProviderOptionsParse {
  if (entry === undefined) {
    return NO_FIELDS;
  }
  const provider = adapter.name;
  const spec = adapter.providerOptions;
  if (spec === undefined) {
    return issues(unsupported(provider, `The ${provider} adapter accepts no providerOptions.`));
  }
  if (!isRecord(entry)) {
    return issues(invalid(provider, `providerOptions.${provider} must be an object.`));
  }

  const found: ValidationIssue[] = [];
  const fields: ProviderWireField[] = [];
  const typedWires = new Map<string, string>();
  for (const [option, field] of Object.entries(spec.options)) {
    typedWires.set(field.wire.toLowerCase(), option);
  }
  const reserved = new Set(spec.reserved.map((wire) => wire.toLowerCase()));

  for (const key of Object.keys(entry)) {
    if (key !== "extra" && !Object.hasOwn(spec.options, key)) {
      found.push(unsupported(provider, `${provider} has no provider option "${key}".`));
    }
  }
  for (const [option, field] of Object.entries(spec.options)) {
    const value = entry[option];
    if (value === undefined) {
      continue;
    }
    const read = readValue(field, value);
    if (read.kind === "ok") {
      fields.push({ wire: field.wire, value: read.value });
    } else {
      found.push(invalid(provider, `providerOptions.${provider}.${option} ${read.problem}.`));
    }
  }

  const extra = entry["extra"];
  if (extra !== undefined) {
    if (!isRecord(extra)) {
      found.push(invalid(provider, `providerOptions.${provider}.extra must be an object.`));
    } else {
      for (const [wire, value] of Object.entries(extra)) {
        const lower = wire.toLowerCase();
        const typed = typedWires.get(lower);
        if (wire.length === 0) {
          found.push(invalid(provider, `providerOptions.${provider}.extra keys must be non-empty.`));
        } else if (reserved.has(lower)) {
          found.push(
            unsupported(provider, `providerOptions.${provider}.extra cannot set "${wire}": the SDK sets it from the portable send fields.`),
          );
        } else if (typed !== undefined) {
          found.push(unsupported(provider, `providerOptions.${provider}.extra cannot set "${wire}"; use the typed option ${typed}.`));
        } else if (!isOptionValue(value)) {
          found.push(invalid(provider, `providerOptions.${provider}.extra.${wire} must be a string, finite number, or boolean.`));
        } else {
          fields.push({ wire, value });
        }
      }
    }
  }

  return found.length > 0 ? { kind: "issues", issues: found } : { kind: "ok", fields };
}

/** True when a wire field with this exact name was parsed with value `true`. */
export function hasTrueField(fields: readonly ProviderWireField[] | undefined, wire: string): boolean {
  return fields?.some((field) => field.wire === wire && field.value === true) ?? false;
}

type ValueRead = { readonly kind: "ok"; readonly value: ProviderOptionValue } | { readonly kind: "invalid"; readonly problem: string };

function readValue(field: ProviderOptionField, value: unknown): ValueRead {
  const bad = (problem: string): ValueRead => ({ kind: "invalid", problem });
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? { kind: "ok", value } : bad("must be a boolean");
    case "string":
      if (typeof value !== "string" || value.length === 0) {
        return bad("must be a non-empty string");
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return bad(`must be at most ${field.maxLength} characters`);
      }
      if (field.pattern !== undefined && !field.pattern.test(value)) {
        return bad(`must match ${field.pattern.source}`);
      }
      return { kind: "ok", value };
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return bad("must be an integer");
      }
      if (value < field.min || (field.max !== undefined && value > field.max)) {
        return bad(field.max === undefined ? `must be at least ${field.min}` : `must be from ${field.min} to ${field.max}`);
      }
      return { kind: "ok", value };
    case "enum": {
      const allowed: readonly string[] = field.values;
      return typeof value === "string" && allowed.includes(value)
        ? { kind: "ok", value }
        : bad(`must be one of ${field.values.map((option) => `"${option}"`).join(", ")}`);
    }
    default: {
      const _exhaustive: never = field;
      return _exhaustive;
    }
  }
}

function isOptionValue(value: unknown): value is ProviderOptionValue {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

function issues(issue: ValidationIssue): ProviderOptionsParse {
  return { kind: "issues", issues: [issue] };
}

function unsupported(provider: string, message: string): ValidationIssue {
  return { code: "unsupported_field", field: "providerOptions", provider, message };
}

function invalid(provider: string | undefined, message: string): ValidationIssue {
  return { code: "invalid_field", field: "providerOptions", message, ...(provider === undefined ? {} : { provider }) };
}
