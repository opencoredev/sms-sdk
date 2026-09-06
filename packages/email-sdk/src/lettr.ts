import { EmailAdapterError, EmailValidationError } from "./errors.js";
import { emailParts, sendAtIso } from "./payloads.js";
import type { EmailAttachment, EmailMessage, EmailAdapter } from "./types.js";
import {
  arrayify,
  assertMaxItems,
  attachmentToBase64,
  builtInAdapterDefinition,
  emailAddressOf,
  headersToArray,
  headersToObject,
  httpErrorMessage,
  isRetryableStatus,
  readErrorBody,
} from "./utils.js";

export type LettrAdapterOptions = {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
};

type LettrSendResponse = {
  message?: string;
  data?: {
    request_id?: string;
    accepted?: number;
    rejected?: number;
  };
  request_id?: string;
};

const DEFAULT_BASE_URL = "https://app.lettr.com/api";

const BLOCKED_HEADER_NAMES = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "reply-to",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "dkim-signature",
  "return-path",
  "received",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "x-msys-api",
]);

export function lettr(options: LettrAdapterOptions): EmailAdapter<"lettr", { baseUrl: string }> {
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetcher = options.fetch ?? fetch;
  const definition = builtInAdapterDefinition("lettr");

  return {
    name: "lettr",
    ...definition,
    raw: { baseUrl },
    validate(message, context) {
      definition.validate?.(message, context);
      assertLettrMessage(message);
    },
    async send(message, context) {
      definition.validate?.(message, context);
      assertLettrMessage(message);
      const scheduledAt = sendAtIso(message);
      const response = await fetcher(
        `${baseUrl}${scheduledAt ? "/emails/scheduled" : "/emails"}`,
        {
          method: "POST",
          signal: context.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
            ...options.headers,
          },
          body: JSON.stringify(await toLettrPayload(message, scheduledAt)),
        },
      );

      if (!response.ok) {
        const body = await readErrorBody(response);
        throw new EmailAdapterError(httpErrorMessage("Lettr", response.status, body), {
          adapter: "lettr",
          status: response.status,
          retryable: isRetryableStatus(response.status),
          delivery: response.status < 500 ? "not_sent" : "unknown",
        });
      }

      const body = (await response.json().catch(() => ({}))) as LettrSendResponse;
      const accepted = body.data?.accepted;
      const rejected = body.data?.rejected;
      if (accepted === 0) {
        throw new EmailAdapterError(
          rejected
            ? `Lettr accepted 0 recipients and rejected ${rejected}.`
            : "Lettr accepted 0 recipients.",
          {
            adapter: "lettr",
            retryable: false,
            delivery: "not_sent",
          },
        );
      }

      return {
        adapter: "lettr",
        id: body.data?.request_id ?? body.request_id,
        raw: body,
      };
    },
  };
}

export function assertLettrMessage(message: EmailMessage) {
  assertMaxItems(
    "lettr",
    "recipient",
    [...arrayify(message.to), ...arrayify(message.cc), ...arrayify(message.bcc)],
    50,
  );
  assertMaxItems("lettr", "replyTo", arrayify(message.replyTo), 1);
  assertMaxItems("lettr", "tag", message.tags ?? [], 1);
  assertMaxItems("lettr", "header", headersToArray(message.headers) ?? [], 10);

  for (const header of headersToArray(message.headers) ?? []) {
    if (BLOCKED_HEADER_NAMES.has(header.name.toLowerCase())) {
      throw new EmailValidationError(
        `lettr does not allow setting the ${header.name} header. Lettr manages that header itself.`,
      );
    }
  }

  for (const recipient of [...arrayify(message.to), ...arrayify(message.cc), ...arrayify(message.bcc)]) {
    if (typeof recipient === "string" ? recipient.includes("<") : Boolean(recipient.name)) {
      throw new EmailValidationError(
        "lettr recipient fields only support plain email addresses.",
      );
    }
  }

  for (const attachment of message.attachments ?? []) {
    if (attachment.contentId || attachment.disposition === "inline") {
      throw new EmailValidationError(
        "lettr does not support inline attachments. Host the image at a public URL instead.",
      );
    }
  }
}

async function toLettrPayload(message: EmailMessage, scheduledAt?: string) {
  const from = emailParts(message.from);
  const replyTo = emailParts(arrayify(message.replyTo)[0] ?? "");
  const attachments = message.attachments?.length
    ? await Promise.all(message.attachments.map(toLettrAttachment))
    : undefined;

  return {
    from: from.email,
    from_name: from.name,
    to: arrayify(message.to).map(emailAddressOf),
    cc: optionalBareAddresses(message.cc),
    bcc: optionalBareAddresses(message.bcc),
    reply_to: replyTo.email || undefined,
    reply_to_name: replyTo.name,
    subject: message.subject,
    html: message.html,
    text: message.text,
    tag: message.tags?.[0]?.value,
    headers: headersToObject(message.headers),
    metadata: lettrMetadata(message.metadata),
    attachments,
    scheduled_at: scheduledAt,
  };
}

async function toLettrAttachment(attachment: EmailAttachment) {
  return {
    name: attachment.filename,
    type: attachment.contentType ?? "application/octet-stream",
    data: await attachmentToBase64(attachment),
  };
}

function optionalBareAddresses(addresses: EmailMessage["cc"]) {
  const values = arrayify(addresses).map(emailAddressOf);
  return values.length > 0 ? values : undefined;
}

function lettrMetadata(metadata: EmailMessage["metadata"]) {
  if (!metadata || Object.keys(metadata).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [key, value === null ? "" : String(value)]),
  );
}
