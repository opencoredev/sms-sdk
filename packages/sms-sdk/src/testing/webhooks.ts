import { hmac, sha256Hex, toBase64, toBase64Url, utf8 } from "../core/crypto.js";
import { computePlivoSignatureV2 } from "../webhooks/plivo.js";
import { computeTwilioSignature } from "../webhooks/twilio.js";

/**
 * Builds a Twilio webhook `Request` signed with `authToken`, as Twilio would
 * send it: form-encoded POST with `X-Twilio-Signature`.
 */
export async function signedTwilioRequest(input: {
  readonly authToken: string;
  readonly url: string;
  readonly params: Readonly<Record<string, string>>;
}): Promise<Request> {
  const entries = Object.entries(input.params);
  const signature = await computeTwilioSignature({ authToken: input.authToken, url: input.url, params: entries });
  return new Request(input.url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": signature },
    body: new URLSearchParams(entries).toString(),
  });
}

/**
 * Builds a Telnyx webhook `Request` signed with an Ed25519 private key over
 * `${timestamp}|${body}`.
 */
export async function signedTelnyxRequest(input: {
  readonly privateKey: CryptoKey;
  readonly url: string;
  readonly body: unknown;
  /** Unix seconds. Default now. */
  readonly timestamp?: number;
}): Promise<Request> {
  const rawBody = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = await crypto.subtle.sign("Ed25519", input.privateKey, utf8(`${timestamp}|${rawBody}`));
  return new Request(input.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "telnyx-signature-ed25519": toBase64(new Uint8Array(signature)),
      "telnyx-timestamp": timestamp,
    },
    body: rawBody,
  });
}

/** Generates an Ed25519 key pair and returns the base64 raw public key Telnyx would show. */
export async function generateTelnyxKeyPair(): Promise<{ readonly privateKey: CryptoKey; readonly publicKey: string }> {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  if (!("privateKey" in pair)) {
    throw new Error("Ed25519 key generation did not return a key pair.");
  }
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toBase64(raw) };
}

/** Builds a Plivo callback `Request` with V2 signature headers. */
export async function signedPlivoRequest(input: {
  readonly authToken: string;
  readonly url: string;
  readonly params: Readonly<Record<string, string>>;
  readonly nonce?: string;
}): Promise<Request> {
  const nonce = input.nonce ?? String(Math.floor(Math.random() * 1e18));
  const signature = await computePlivoSignatureV2({ authToken: input.authToken, url: input.url, nonce });
  return new Request(input.url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-plivo-signature-v2": signature,
      "x-plivo-signature-v2-nonce": nonce,
    },
    body: new URLSearchParams(Object.entries(input.params)).toString(),
  });
}

/**
 * Builds a Vonage Messages API webhook `Request` with an HS256 JWT signed by
 * `signatureSecret`, including `payload_hash` of the body.
 */
export async function signedVonageRequest(input: {
  readonly signatureSecret: string;
  readonly url: string;
  readonly body: unknown;
  /** Unix seconds. Default now. */
  readonly iat?: number;
  readonly apiKey?: string;
}): Promise<Request> {
  const rawBody = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
  const header = toBase64Url(utf8(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const claims = {
    iat: input.iat ?? Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(),
    iss: "Vonage",
    payload_hash: await sha256Hex(rawBody),
    api_key: input.apiKey ?? "test-key",
  };
  const payload = toBase64Url(utf8(JSON.stringify(claims)));
  const signature = toBase64Url(await hmac("SHA-256", input.signatureSecret, `${header}.${payload}`));
  return new Request(input.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${header}.${payload}.${signature}` },
    body: rawBody,
  });
}
