/**
 * Local state in $PONTE_HOME (default ~/.ponte).
 *
 *   config.json     your display name, identity key, hosting settings
 *   rooms.json      your rooms: relay URL, room secret, peer, role
 *   cursors.json    last message id seen per room
 *   inbox.jsonl     messages not read yet, one JSON object per line
 *   logs/<room>.md  readable history of each room
 *   daemon.pid      pid of the running daemon
 *
 * The directory is 0700 and every file 0600: a room secret is all it takes to
 * read a room.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "./lock.js";
import { NAME_RE } from "./safety.js";
import { PonteExit, dumpsSpaced } from "./util.js";

export const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export interface HostSettings {
  port?: number;
  bind?: string;
}

export interface Config {
  name?: string;
  identity_key?: string;
  host?: HostSettings;
  public_url?: string;
  [key: string]: unknown;
}

export interface RoomConfig {
  url: string;
  secret: string;
  peer?: string;
  role?: string;
  created?: string;
  [key: string]: unknown;
}

export interface InboxMessage {
  room: string;
  id: number;
  from: string;
  to: string | null;
  text: string;
  flags: string[];
  at: number;
}

export function home(): string {
  const h = process.env.PONTE_HOME || join(homedir(), ".ponte");
  mkdirSync(h, { recursive: true, mode: 0o700 });
  mkdirSync(join(h, "logs"), { recursive: true, mode: 0o700 });
  return h;
}

function readJson<T>(path: string, fallback: T): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Atomic write: <name>.tmp next to the file, then rename over it. */
function writeJson(path: string, data: unknown): void {
  const tmp = path.replace(/\.json$/, "") + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Serialize work on cursors or the inbox across processes. */
export function locked<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  return withFileLock(join(home(), `.${name}.lockfile`), fn);
}

// ---- identity -------------------------------------------------------------

export function config(): Config {
  return readJson<Config>(join(home(), "config.json"), {});
}

export function saveConfig(cfg: Config): void {
  writeJson(join(home(), "config.json"), cfg);
}

export function me(required = true): Config {
  const cfg = config();
  if (required && !cfg.name) throw new PonteExit("Run `ponte init --name <your-name>` first.");
  return cfg;
}

export function init(name: string): Config {
  if (!NAME_RE.test(name)) throw new PonteExit("name: up to 64 letters, digits, spaces, '_', '.' or '-'");
  const cfg = config();
  cfg.name = name;
  if (cfg.identity_key === undefined) cfg.identity_key = randomBytes(32).toString("base64url");
  saveConfig(cfg);
  return cfg;
}

// ---- rooms ----------------------------------------------------------------

export function rooms(): Record<string, RoomConfig> {
  return readJson<Record<string, RoomConfig>>(join(home(), "rooms.json"), {});
}

export function saveRooms(r: Record<string, RoomConfig>): void {
  writeJson(join(home(), "rooms.json"), r);
}

export function room(alias: string): RoomConfig {
  const r = rooms();
  if (!Object.prototype.hasOwnProperty.call(r, alias)) {
    const known = Object.keys(r).join(", ") || "none";
    throw new PonteExit(`No room called '${alias}' (known: ${known}).`);
  }
  return r[alias];
}

export function checkAlias(alias: string): string {
  if (!ALIAS_RE.test(alias)) throw new PonteExit("room alias: lowercase letters, digits and '-' (e.g. acme-site)");
  return alias;
}

// ---- cursors and inbox ----------------------------------------------------

export function cursors(): Record<string, number> {
  return readJson<Record<string, number>>(join(home(), "cursors.json"), {});
}

export function saveCursors(c: Record<string, number>): void {
  writeJson(join(home(), "cursors.json"), c);
}

function inboxPath(): string {
  return join(home(), "inbox.jsonl");
}

export function inboxAppend(messages: InboxMessage[]): void {
  const path = inboxPath();
  appendFileSync(path, messages.map((m) => dumpsSpaced(m) + "\n").join(""), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function inboxRows(): InboxMessage[] {
  const path = inboxPath();
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as InboxMessage);
}

/** Messages for one room (or all rooms). Unless ``peek``, they leave the inbox. */
export function inboxTake(alias: string | null = null, peek = false): InboxMessage[] {
  const rows = inboxRows();
  const mine = (m: InboxMessage) => alias === null || m.room === alias;
  const taken = rows.filter(mine);
  if (!peek && taken.length) {
    const rest = rows.filter((m) => !mine(m));
    writeFileSync(inboxPath(), rest.map((m) => dumpsSpaced(m) + "\n").join(""), { mode: 0o600 });
  }
  return taken;
}

export function inboxCount(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const m of inboxRows()) counts[m.room] = (counts[m.room] ?? 0) + 1;
  return counts;
}

// ---- logs -----------------------------------------------------------------

function stamp(at: number): string {
  const d = new Date(at * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function logPath(alias: string): string {
  return join(home(), "logs", `${alias}.md`);
}

export function log(alias: string, sender: string, text: string, at?: number): void {
  const path = logPath(alias);
  appendFileSync(path, `\n### ${stamp(at || Date.now() / 1000)} · ${sender}\n\n${text.trim()}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

/** The last ``n`` entries of a room's log. */
export function logTail(alias: string, n = 20): string {
  const path = logPath(alias);
  if (!existsSync(path)) return "";
  const blocks = readFileSync(path, "utf8").split("\n### ");
  return blocks.slice(-n).join("\n### ").trim();
}

// ---- daemon liveness ------------------------------------------------------

export function pidPath(): string {
  return join(home(), "daemon.pid");
}

export function daemonAlive(): boolean {
  let raw: string;
  try {
    raw = readFileSync(pidPath(), "utf8");
  } catch {
    return false;
  }
  if (!/^\s*\d+\s*$/.test(raw)) return false;
  try {
    process.kill(Number.parseInt(raw, 10), 0);
    return true;
  } catch {
    return false;
  }
}
