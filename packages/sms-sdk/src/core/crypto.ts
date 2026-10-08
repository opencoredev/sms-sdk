/**
 * Small Web Crypto helpers shared by adapters and webhook verifiers. They work
 * in Node 20+, Bun, and other runtimes with `globalThis.crypto.subtle`.
 */

const encoder = new TextEncoder();

/** UTF-8 bytes of `text`. */
export function utf8(text: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(text);
}

/** Standard base64 encoding of bytes. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Base64url (no padding) encoding of bytes. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes standard or URL-safe base64. Returns `undefined` for invalid input. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | undefined {
  const normalized = text.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    return undefined;
  }
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/** Lowercase hex encoding of bytes. */
export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** HMAC of `message` with `key`. */
export async function hmac(algorithm: "SHA-1" | "SHA-256", key: string, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", utf8(key), { name: "HMAC", hash: algorithm }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, utf8(message)));
}

/** SHA-256 digest of `data`, hex-encoded. */
export async function sha256Hex(data: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(data))));
}

/**
 * Compares two strings in time that depends only on their lengths, so a
 * signature cannot be guessed byte by byte.
 */
export function timingSafeEqual(left: string, right: string): boolean {
  const a = utf8(left);
  const b = utf8(right);
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

/**
 * Decodes a PEM block into DER bytes. Literal `\n` sequences (common when a
 * key is stored in an environment variable) are treated as line breaks.
 * Returns `undefined` when no PEM body is found.
 */
export function pemToDer(pem: string): Uint8Array<ArrayBuffer> | undefined {
  const body = pem
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  return body.length === 0 ? undefined : fromBase64(body);
}
