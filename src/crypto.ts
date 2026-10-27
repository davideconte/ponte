/**
 * Room keys and message sealing.
 *
 * A room is nothing more than a 32-byte secret. Every value a room needs is an
 * HMAC-SHA256 of a fixed label under that secret:
 *
 *   room name    "r-" + first 20 hex digits of HMAC(secret, "ponte/v1/room")
 *   relay token  base64url(HMAC(secret, "ponte/v1/auth"))   shown to the relay
 *   message key  HMAC(secret, "ponte/v1/enc")                stays on the clients
 *
 * Messages are sealed with XChaCha20-Poly1305 (IETF variant, 24-byte random
 * nonce). The associated data is "<room>\n<sender>", so the relay can neither
 * read a body nor attribute it to a different sender.
 */

import { createHmac, randomBytes } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha";

export const PREFIX = "ponte1.";
export const SECRET_BYTES = 32;
const NONCE_BYTES = 24;

export class DecryptError extends Error {}

export function newSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** base64url without padding. */
export function b64e(data: Uint8Array): string {
  return Buffer.from(data).toString("base64url");
}

/**
 * Decode base64url (padding optional). Characters outside the alphabet are
 * ignored; a length that cannot be valid base64 is an error.
 */
export function b64d(text: string): Buffer {
  if (typeof text !== "string") throw new TypeError("expected a string");
  const clean = text.replace(/[^A-Za-z0-9\-_+/]/g, "");
  if (clean.length % 4 === 1) throw new Error("invalid base64 length");
  return Buffer.from(clean.replace(/\+/g, "-").replace(/\//g, "_"), "base64url");
}

function derive(secret: Uint8Array, label: string): Buffer {
  return createHmac("sha256", secret).update(`ponte/v1/${label}`, "utf8").digest();
}

export function roomName(secret: Uint8Array): string {
  return "r-" + derive(secret, "room").toString("hex").slice(0, 20);
}

export function relayToken(secret: Uint8Array): string {
  return b64e(derive(secret, "auth"));
}

export function messageKey(secret: Uint8Array): Buffer {
  return derive(secret, "enc");
}

function aad(room: string, sender: string): Uint8Array {
  return new TextEncoder().encode(`${room}\n${sender}`);
}

/** Seal ``text``. ``nonce`` is only for test vectors; leave it out otherwise. */
export function seal(key: Uint8Array, room: string, sender: string, text: string, nonce?: Uint8Array): string {
  const n = nonce ?? randomBytes(NONCE_BYTES);
  if (n.length !== NONCE_BYTES) throw new Error("nonce must be 24 bytes");
  const box = xchacha20poly1305(key, n, aad(room, sender)).encrypt(new TextEncoder().encode(text));
  return PREFIX + b64e(Buffer.concat([Buffer.from(n), Buffer.from(box)]));
}

export function openSealed(key: Uint8Array, room: string, sender: string, body: string): string {
  if (typeof body !== "string" || !body.startsWith(PREFIX)) {
    throw new DecryptError("message is not encrypted");
  }
  let plain: Uint8Array;
  try {
    const raw = b64d(body.slice(PREFIX.length));
    if (raw.length < NONCE_BYTES + 16) throw new Error("too short");
    plain = xchacha20poly1305(key, raw.subarray(0, NONCE_BYTES), aad(room, sender)).decrypt(raw.subarray(NONCE_BYTES));
  } catch {
    throw new DecryptError("message failed authentication");
  }
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(plain);
}
