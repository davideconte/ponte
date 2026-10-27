/**
 * The Ponte relay: a mailbox that hands sealed messages between the members
 * of a room.
 *
 * It only ever holds ciphertext. It knows room names, display names, message
 * sizes and times, and nothing else. It never runs anything on anyone's
 * behalf, so the worst a compromised relay can do is drop or delay mail.
 *
 * HTTP API (JSON in and out):
 *
 *   GET  /healthz                         {ok, version}
 *   POST /v1/join      Bearer token       {room, display_name, identity_key}
 *                                         -> {session_id, room, display_name, cursor}
 *   POST /v1/heartbeat                    -> {ok, display_name}
 *   GET  /v1/peers                        -> {room, you, peers: [{display_name, joined_at, last_seen}]}
 *   POST /v1/send                         {text, to?} -> {ok, id, flags}
 *   GET  /v1/poll?since=&limit=           -> {messages: [{id, from, to, text, flags, at}], cursor, more}
 *
 * Every /v1 call except join also sends X-Ponte-Room and X-Ponte-Session.
 *
 * Access rules:
 *   - Rooms are closed: a room exists only if the host pinned it (ponte open
 *     writes it to the pins file, which the relay watches). With openRooms the
 *     first join of an unknown room creates it and fixes its token instead.
 *   - A display name belongs to the identity key that first used it in the
 *     room, for as long as that identity stays around (30 days without a
 *     visit). Nobody else can take the name, read its direct messages or post
 *     as it.
 *   - A session id only works in the room it joined.
 *
 * State lives in memory and is saved to a JSON file (atomic rename, batched).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, dirname, basename } from "node:path";
import { withFileLock } from "./lock.js";
import { MAX_MESSAGE_BYTES, MAX_NAME_LEN, NAME_RE, ROOM_RE, utf8Length } from "./safety.js";
import { VERSION } from "./version.js";

export const LIMITS = {
  maxBodyBytes: 64 * 1024,
  maxMessageBytes: MAX_MESSAGE_BYTES,
  sendsPerMinute: 60,
  joinsPerRoomPerMinute: 20,
  newRoomsPerMinute: 10,
  maxRooms: 100,
  maxNamesPerRoom: 16,
  maxMessagesPerRoom: 5000,
  maxPollLimit: 100,
  defaultPollLimit: 50,
  presenceSeconds: 90,
  backlogSeconds: 3600,
  backlogMessages: 20,
  messageRetentionSeconds: 7 * 24 * 3600,
  sessionSeconds: 24 * 3600,
  identitySeconds: 30 * 24 * 3600,
  emptyRoomSeconds: 24 * 3600,
  pruneEverySeconds: 3600,
} as const;

// ---- state ----------------------------------------------------------------

interface StoredMessage {
  id: number;
  from: string;
  to: string | null;
  body: string;
  at: number;
}

interface Member {
  key_hash: string;
  delivered_id: number;
  created_at: number;
  last_seen: number;
}

interface Session {
  name: string;
  joined_at: number;
  last_seen: number;
}

interface Room {
  token_hash: string;
  created_at: number;
  /** "pins": added by the host through the pins file; "join": created by a first join. */
  source: "pins" | "join";
  members: Record<string, Member>;
  sessions: Record<string, Session>;
  messages: StoredMessage[];
}

interface State {
  format: 1;
  next_id: number;
  rooms: Record<string, Room>;
}

function emptyState(): State {
  return { format: 1, next_id: 1, rooms: {} };
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Sliding one-minute counter per key. */
class Budget {
  private hits = new Map<string, number[]>();
  constructor(private readonly max: number, private readonly windowSeconds = 60) {}

  take(key: string, now: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowSeconds);
    if (recent.length >= this.max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  forgetIdle(now: number): void {
    for (const [key, times] of this.hits) {
      if (!times.length || times[times.length - 1] <= now - this.windowSeconds) this.hits.delete(key);
    }
  }
}

class HttpError extends Error {
  constructor(readonly status: number, readonly detail: unknown) {
    super(typeof detail === "string" ? detail : "invalid request");
  }
}

function invalid(field: string, msg: string, type: string): HttpError {
  return new HttpError(422, [{ loc: ["body", field], msg, type }]);
}

function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

function hasLoneSurrogate(s: string): boolean {
  return /\p{Cs}/u.test(s);
}

function stringField(body: Record<string, unknown>, field: string, min: number, max: number, optional = false): string | null {
  const v = body[field];
  if (v === undefined || v === null) {
    if (optional) return null;
    throw invalid(field, "Field required", "missing");
  }
  if (typeof v !== "string") throw invalid(field, "Input should be a valid string", "string_type");
  if (hasLoneSurrogate(v)) throw invalid(field, "Input should be a valid string", "string_unicode");
  const len = codePoints(v);
  if (len < min) throw invalid(field, `String should have at least ${min} characters`, "string_too_short");
  if (len > max) throw invalid(field, `String should have at most ${max} characters`, "string_too_long");
  return v;
}

function intParam(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const fail = (msg: string, type: string) => new HttpError(422, [{ loc: ["query", name], msg, type }]);
  if (!/^\s*[+-]?\d+\s*$/.test(raw)) throw fail("Input should be a valid integer", "int_parsing");
  const n = Number.parseInt(raw, 10);
  if (n < min) throw fail(`Input should be greater than or equal to ${min}`, "greater_than_equal");
  if (n > max) throw fail(`Input should be less than or equal to ${max}`, "less_than_equal");
  return n;
}

// ---- pins file ------------------------------------------------------------

/** The pins file: {"<room>": {"token_sha256": "<hex>", "at": <unix seconds>}}. */
type Pins = Record<string, { token_sha256: string; at: number }>;

function readPins(path: string): Pins | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data && typeof data === "object" && !Array.isArray(data) ? (data as Pins) : null;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? {} : null;
  }
}

function writePins(path: string, pins: Pins): void {
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(pins, null, 1), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Open a room on a relay, whether or not that relay is running right now. */
export async function pinRoom(pinsPath: string, room: string, token: string): Promise<void> {
  if (!ROOM_RE.test(room)) throw new Error(`invalid room name '${room}'`);
  await withFileLock(pinsPath + ".lockfile", () => {
    const pins = readPins(pinsPath) ?? {};
    pins[room] = { token_sha256: sha256Hex(token), at: Date.now() / 1000 };
    writePins(pinsPath, pins);
  });
}

/** Close a pinned room: the relay forgets it and everything said in it. */
export async function unpinRoom(pinsPath: string, room: string): Promise<void> {
  await withFileLock(pinsPath + ".lockfile", () => {
    const pins = readPins(pinsPath) ?? {};
    if (room in pins) {
      delete pins[room];
      writePins(pinsPath, pins);
    }
  });
}

// ---- the relay ------------------------------------------------------------

export interface RelayOptions {
  /** JSON file the state is saved to. Leave out to keep everything in memory. */
  storePath?: string | null;
  /** Pins file written by `ponte open` / `ponte close`. */
  pinsPath?: string | null;
  /** Let a first join create unknown rooms. Default: PONTE_OPEN_ROOMS, else false. */
  openRooms?: boolean;
  /** Clock in seconds, for tests. */
  now?: () => number;
}

interface Caller {
  roomName: string;
  room: Room;
  sessionId: string;
  name: string;
}

function envFlag(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw !== "" && !["0", "false", "no", "off"].includes(raw);
}

export class Relay {
  readonly server: Server;
  private state: State;
  private readonly storePath: string | null;
  private readonly pinsPath: string | null;
  private readonly openRooms: boolean;
  private readonly clock: () => number;
  private readonly sends = new Budget(LIMITS.sendsPerMinute);
  private readonly joins = new Budget(LIMITS.joinsPerRoomPerMinute);
  private readonly newRooms = new Budget(LIMITS.newRoomsPerMinute);
  private lastPrune = 0;
  private pinsSeen = "";
  private saveTimer: NodeJS.Timeout | null = null;
  private saveDue = Infinity;

  constructor(options: RelayOptions = {}) {
    this.storePath = options.storePath ?? null;
    this.pinsPath = options.pinsPath ?? null;
    this.openRooms = options.openRooms ?? envFlag("PONTE_OPEN_ROOMS");
    this.clock = options.now ?? (() => Date.now() / 1000);
    this.state = this.load();
    this.syncPins();
    this.prune(this.clock());
    this.server = createServer((req, res) => this.handle(req, res));
  }

  // -- persistence --

  private load(): State {
    if (!this.storePath) return emptyState();
    let raw: string;
    try {
      raw = readFileSync(this.storePath, "utf8");
    } catch {
      return emptyState();
    }
    try {
      const data = JSON.parse(raw) as State;
      if (data && data.format === 1 && typeof data.next_id === "number" && data.rooms && typeof data.rooms === "object") {
        return data;
      }
    } catch {
      // fall through
    }
    // Unreadable: keep it aside for inspection and start clean.
    try {
      renameSync(this.storePath, `${this.storePath}.unreadable-${Date.now()}`);
    } catch {
      // ignore
    }
    return emptyState();
  }

  /** Write the state now. */
  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.saveDue = Infinity;
    if (!this.storePath) return;
    const tmp = join(dirname(this.storePath), `.${basename(this.storePath)}.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.storePath);
  }

  /** Save soon: within 200 ms after real changes, within 15 s after presence updates. */
  private changed(important = true): void {
    if (!this.storePath) return;
    const delay = important ? 200 : 15_000;
    const due = Date.now() + delay;
    if (due >= this.saveDue) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveDue = due;
    this.saveTimer = setTimeout(() => {
      try {
        this.flush();
      } catch (err) {
        process.stderr.write(`ponte relay: could not save state: ${String(err)}\n`);
      }
    }, delay);
    this.saveTimer.unref();
  }

  // -- pins --

  /** Apply the pins file if it changed since we last looked. */
  syncPins(): void {
    if (!this.pinsPath) return;
    let seen = "missing";
    try {
      const st = statSync(this.pinsPath);
      seen = `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      // no pins file: no pinned rooms
    }
    if (seen === this.pinsSeen) return;
    const pins = seen === "missing" ? {} : readPins(this.pinsPath);
    if (pins === null) return; // half-written or damaged: keep what we have
    this.pinsSeen = seen;
    const now = this.clock();
    for (const [name, pin] of Object.entries(pins)) {
      if (!ROOM_RE.test(name) || !pin || typeof pin.token_sha256 !== "string") continue;
      const room = this.state.rooms[name];
      if (room) {
        room.token_hash = pin.token_sha256;
        room.source = "pins";
      } else {
        this.state.rooms[name] = {
          token_hash: pin.token_sha256, created_at: now, source: "pins", members: {}, sessions: {}, messages: [],
        };
      }
    }
    for (const [name, room] of Object.entries(this.state.rooms)) {
      if (room.source === "pins" && !(name in pins)) delete this.state.rooms[name];
    }
    this.changed();
  }

  // -- housekeeping --

  prune(now = this.clock()): void {
    const L = LIMITS;
    for (const [name, room] of Object.entries(this.state.rooms)) {
      room.messages = room.messages.filter((m) => m.at >= now - L.messageRetentionSeconds);
      for (const [id, s] of Object.entries(room.sessions)) {
        if (s.last_seen < now - L.sessionSeconds) delete room.sessions[id];
      }
      for (const [who, m] of Object.entries(room.members)) {
        if (m.last_seen < now - L.identitySeconds) delete room.members[who];
      }
      const abandoned = room.source !== "pins" && Object.keys(room.members).length === 0
        && room.created_at < now - L.emptyRoomSeconds;
      if (abandoned) delete this.state.rooms[name];
    }
    this.sends.forgetIdle(now);
    this.joins.forgetIdle(now);
    this.newRooms.forgetIdle(now);
    this.lastPrune = now;
    this.changed();
  }

  // -- lifecycle --

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      this.server.once("error", onError);
      this.server.listen(port, host, () => {
        this.server.off("error", onError);
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections?.();
      try {
        this.flush();
      } catch {
        // best effort
      }
    });
  }

  /** For tests and inspection: a read-only view of a room. */
  inspect(room: string): Room | undefined {
    return this.state.rooms[room];
  }

  roomCount(): number {
    return Object.keys(this.state.rooms).length;
  }

  // -- HTTP --

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const reply = (status: number, payload: unknown) => {
      const body = JSON.stringify(payload);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    };
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > LIMITS.maxBodyBytes) {
      res.setHeader("connection", "close");
      reply(413, { detail: "Request body too large" });
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let refused = false;
    req.on("data", (chunk: Buffer) => {
      if (refused) return;
      size += chunk.length;
      if (size > LIMITS.maxBodyBytes) {
        refused = true;
        res.setHeader("connection", "close");
        reply(413, { detail: "Request body too large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (refused) return;
      try {
        const out = this.route(req, Buffer.concat(chunks));
        reply(200, out);
      } catch (err) {
        if (err instanceof HttpError) reply(err.status, { detail: err.detail });
        else {
          process.stderr.write(`ponte relay: ${err instanceof Error ? err.stack : String(err)}\n`);
          reply(500, { detail: "Internal Server Error" });
        }
      }
    });
    req.on("error", () => res.destroy());
  }

  private route(req: IncomingMessage, raw: Buffer): unknown {
    const url = new URL(req.url ?? "/", "http://relay");
    const method = req.method ?? "GET";
    const routes: Record<string, Record<string, () => unknown>> = {
      "/healthz": { GET: () => ({ ok: true, version: VERSION }) },
      "/v1/join": { POST: () => this.join(req, raw) },
      "/v1/heartbeat": { POST: () => this.heartbeat(req) },
      "/v1/peers": { GET: () => this.peers(req) },
      "/v1/send": { POST: () => this.send(req, raw) },
      "/v1/poll": { GET: () => this.poll(req, url.searchParams) },
    };
    const route = routes[url.pathname];
    if (!route) throw new HttpError(404, "Not Found");
    const run = route[method];
    if (!run) throw new HttpError(405, "Method Not Allowed");
    if (url.pathname.startsWith("/v1/")) this.syncPins();
    const now = this.clock();
    if (now - this.lastPrune >= LIMITS.pruneEverySeconds) this.prune(now);
    return run();
  }

  private jsonBody(raw: Buffer): Record<string, unknown> {
    let data: unknown;
    try {
      data = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(422, [{ loc: ["body"], msg: "JSON decode error", type: "json_invalid" }]);
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new HttpError(422, [{ loc: ["body"], msg: "Input should be an object", type: "model_attributes_type" }]);
    }
    return data as Record<string, unknown>;
  }

  private bearer(req: IncomingMessage): string {
    const auth = req.headers.authorization;
    if (!auth || !auth.toLowerCase().startsWith("bearer ")) throw new HttpError(401, "Missing bearer token");
    return auth.slice(7).trim();
  }

  private header(req: IncomingMessage, name: string): string {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] ?? "" : v ?? "";
  }

  /** The room, if this token opens it. */
  private unlock(roomName: string, token: string): Room {
    const room = Object.prototype.hasOwnProperty.call(this.state.rooms, roomName) ? this.state.rooms[roomName] : undefined;
    if (!room) throw new HttpError(403, "Unknown room");
    if (!sameHash(room.token_hash, sha256Hex(token))) throw new HttpError(403, "Wrong token for this room");
    return room;
  }

  private caller(req: IncomingMessage): Caller {
    const token = this.bearer(req);
    const roomName = this.header(req, "x-ponte-room");
    const sessionId = this.header(req, "x-ponte-session");
    if (!roomName || !sessionId) throw new HttpError(401, "X-Ponte-Room and X-Ponte-Session are required");
    const room = this.unlock(roomName, token);
    const session = Object.prototype.hasOwnProperty.call(room.sessions, sessionId) ? room.sessions[sessionId] : undefined;
    if (!session) throw new HttpError(401, "Session not known in this room - join again");
    const now = this.clock();
    session.last_seen = now;
    const member = room.members[session.name];
    if (member) member.last_seen = now;
    this.changed(false);
    return { roomName, room, sessionId, name: session.name };
  }

  private join(req: IncomingMessage, raw: Buffer): unknown {
    const body = this.jsonBody(raw);
    const roomName = stringField(body, "room", 0, 64) as string;
    const name = stringField(body, "display_name", 1, MAX_NAME_LEN) as string;
    const identityKey = stringField(body, "identity_key", 16, 256) as string;
    const token = this.bearer(req);
    if (!ROOM_RE.test(roomName)) throw new HttpError(400, "Room names are 3-64 letters, digits, '.', '_' or '-'");
    if (!NAME_RE.test(name)) throw new HttpError(400, "Display names are 1-64 letters, digits, spaces, '.', '_' or '-'");

    const now = this.clock();
    let room = Object.prototype.hasOwnProperty.call(this.state.rooms, roomName) ? this.state.rooms[roomName] : undefined;
    let created = false;
    if (room) {
      if (!sameHash(room.token_hash, sha256Hex(token))) throw new HttpError(403, "Wrong token for this room");
    } else {
      if (!this.openRooms) throw new HttpError(403, "Unknown room");
      if (this.roomCount() >= LIMITS.maxRooms) throw new HttpError(503, "This relay is full");
      if (!this.newRooms.take("*", now)) throw new HttpError(429, "Too many new rooms, try again in a minute");
      room = { token_hash: sha256Hex(token), created_at: now, source: "join", members: {}, sessions: {}, messages: [] };
      created = true;
    }
    if (!this.joins.take(roomName, now)) throw new HttpError(429, "Too many joins, try again in a minute");

    const keyHash = sha256Hex(identityKey);
    const member = Object.prototype.hasOwnProperty.call(room.members, name) ? room.members[name] : undefined;
    let cursor: number;
    if (!member) {
      if (Object.keys(room.members).length >= LIMITS.maxNamesPerRoom) {
        throw new HttpError(403, "This room is full");
      }
      cursor = this.backlogCursor(room, now);
      room.members[name] = { key_hash: keyHash, delivered_id: cursor, created_at: now, last_seen: now };
    } else if (sameHash(member.key_hash, keyHash)) {
      cursor = member.delivered_id; // the same person again: resume where they stopped
      member.last_seen = now;
    } else {
      throw new HttpError(409, `The name '${name}' is already used by someone else in this room`);
    }

    if (created) this.state.rooms[roomName] = room;
    const sessionId = randomBytes(24).toString("base64url");
    room.sessions[sessionId] = { name, joined_at: now, last_seen: now };
    this.changed();
    return { session_id: sessionId, room: roomName, display_name: name, cursor };
  }

  /** Where a newcomer starts: just before the last hour's messages (at most 20 of them). */
  private backlogCursor(room: Room, now: number): number {
    const msgs = room.messages;
    let first = msgs.length;
    let count = 0;
    while (first > 0 && count < LIMITS.backlogMessages && msgs[first - 1].at > now - LIMITS.backlogSeconds) {
      first--;
      count++;
    }
    if (count > 0) return msgs[first].id - 1;
    return msgs.length ? msgs[msgs.length - 1].id : 0;
  }

  private heartbeat(req: IncomingMessage): unknown {
    const who = this.caller(req);
    return { ok: true, display_name: who.name };
  }

  private peers(req: IncomingMessage): unknown {
    const who = this.caller(req);
    const cutoff = this.clock() - LIMITS.presenceSeconds;
    const online = new Map<string, { display_name: string; joined_at: number; last_seen: number }>();
    for (const s of Object.values(who.room.sessions)) {
      if (s.name === who.name || s.last_seen <= cutoff) continue;
      const p = online.get(s.name);
      if (!p) online.set(s.name, { display_name: s.name, joined_at: s.joined_at, last_seen: s.last_seen });
      else {
        p.joined_at = Math.min(p.joined_at, s.joined_at);
        p.last_seen = Math.max(p.last_seen, s.last_seen);
      }
    }
    const peers = [...online.values()].sort((a, b) => (a.display_name < b.display_name ? -1 : a.display_name > b.display_name ? 1 : 0));
    return { room: who.roomName, you: who.name, peers };
  }

  private send(req: IncomingMessage, raw: Buffer): unknown {
    const who = this.caller(req);
    const body = this.jsonBody(raw);
    const text = stringField(body, "text", 1, Number.MAX_SAFE_INTEGER) as string;
    const to = stringField(body, "to", 0, MAX_NAME_LEN, true);
    if (utf8Length(text) > LIMITS.maxMessageBytes) throw new HttpError(413, "Message too large");
    if (to !== null && !NAME_RE.test(to)) throw new HttpError(400, "Invalid recipient name");
    if (to === who.name) throw new HttpError(400, "A message cannot be addressed to its sender");
    if (to !== null && !Object.prototype.hasOwnProperty.call(who.room.members, to)) {
      throw new HttpError(404, `Nobody called '${to}' is a member of this room`);
    }
    const now = this.clock();
    if (!this.sends.take(`${who.roomName}\u0000${who.name}`, now)) throw new HttpError(429, "Too many messages, slow down");

    const id = this.state.next_id++;
    who.room.messages.push({ id, from: who.name, to, body: text, at: now });
    const excess = who.room.messages.length - LIMITS.maxMessagesPerRoom;
    if (excess > 0) who.room.messages.splice(0, excess);
    this.changed();
    return { ok: true, id, flags: [] };
  }

  private poll(req: IncomingMessage, params: URLSearchParams): unknown {
    const who = this.caller(req);
    const since = intParam(params, "since", 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(params, "limit", LIMITS.defaultPollLimit, 1, LIMITS.maxPollLimit);
    const msgs = who.room.messages;
    let lo = 0;
    let hi = msgs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (msgs[mid].id <= since) lo = mid + 1;
      else hi = mid;
    }
    const picked: StoredMessage[] = [];
    let more = false;
    for (let i = lo; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.from === who.name || (m.to !== null && m.to !== who.name)) continue;
      if (picked.length === limit) {
        more = true;
        break;
      }
      picked.push(m);
    }
    if (picked.length) {
      const member = who.room.members[who.name];
      const last = picked[picked.length - 1].id;
      if (member && last > member.delivered_id) {
        member.delivered_id = last;
        this.changed();
      }
    }
    return {
      messages: picked.map((m) => ({ id: m.id, from: m.from, to: m.to, text: m.body, flags: [], at: m.at })),
      cursor: picked.length ? picked[picked.length - 1].id : since,
      more,
    };
  }
}

export function createRelay(options: RelayOptions = {}): Relay {
  return new Relay(options);
}
