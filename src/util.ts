import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** A user-facing error: the CLI prints the message and exits with status 1. */
export class PonteExit extends Error {}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Find an executable on PATH, like `command -v`. */
export function which(cmd: string): string | null {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * JSON with ", " and ": " separators, the layout the files in ~/.ponte have
 * always used. With ``ascii`` every non-ASCII character is written as \uXXXX.
 */
export function dumpsSpaced(value: unknown, ascii = false): string {
  const s = serialize(value, ", ", ": ");
  return ascii ? asciiOnly(s) : s;
}

/** Compact JSON (",", ":"). */
export function dumpsCompact(value: unknown, ascii = false): string {
  const s = JSON.stringify(value);
  return ascii ? asciiOnly(s) : s;
}

function asciiOnly(s: string): string {
  return s.replace(/[\u0080-\uffff]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

function serialize(v: unknown, item: string, kv: string): string {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return "[" + v.map((x) => serialize(x, item, kv)).join(item) + "]";
  if (typeof v === "object") {
    const parts = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .map(([k, x]) => JSON.stringify(k) + kv + serialize(x, item, kv));
    return "{" + parts.join(item) + "}";
  }
  return JSON.stringify(v);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function errorName(err: unknown): string {
  if (err instanceof Error) return err.constructor?.name || err.name || "Error";
  return "Error";
}
