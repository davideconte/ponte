/**
 * Invites: a single line carrying the relay URL and the room secret.
 *
 *   "ponte1_" + base64url(JSON {"u": url, "s": base64url(secret), "h": host name})
 *
 * Whoever holds an invite can read and write the room, so it should travel
 * privately (a direct message, a password manager), never in a shared file.
 */

import { SECRET_BYTES, b64d, b64e } from "./crypto.js";
import { dumpsCompact } from "./util.js";

export const INVITE_PREFIX = "ponte1_";

export interface Invite {
  url: string;
  secret: Buffer;
  hostName: string;
}

export function encodeInvite(url: string, secret: Uint8Array, hostName = ""): string {
  const blob: Record<string, string> = { u: url, s: b64e(secret) };
  if (hostName) blob.h = hostName;
  return INVITE_PREFIX + b64e(Buffer.from(dumpsCompact(blob, true), "utf8"));
}

export function decodeInvite(input: string): Invite {
  const text = input.trim();
  if (!text.startsWith(INVITE_PREFIX)) {
    throw new Error("not a Ponte invite (it should start with 'ponte1_')");
  }
  let url: unknown;
  let secret: Buffer;
  let host: unknown;
  try {
    const data = JSON.parse(b64d(text.slice(INVITE_PREFIX.length)).toString("utf8"));
    if (data === null || typeof data !== "object" || Array.isArray(data) || !("u" in data) || !("s" in data)) {
      throw new Error("shape");
    }
    url = data.u;
    secret = b64d(data.s);
    host = data.h;
  } catch {
    throw new Error("this invite is damaged - copy the whole line again");
  }
  if (typeof url !== "string" || !(url.startsWith("http://") || url.startsWith("https://"))) {
    throw new Error("invite has an invalid relay URL");
  }
  if (secret.length !== SECRET_BYTES) throw new Error("invite has an invalid secret");
  return { url: url.replace(/\/+$/, ""), secret, hostName: typeof host === "string" ? host : "" };
}
