/** Talking to a relay: join, send (sealed), fetch (opened and cleaned), presence. */

import * as crypto from "./crypto.js";
import { MAX_MESSAGE_BYTES, sanitize, utf8Length } from "./safety.js";
import * as store from "./store.js";
import type { Config, InboxMessage, RoomConfig } from "./store.js";

// The relay caps the sealed body at MAX_MESSAGE_BYTES. A sealed body is the
// prefix plus base64 of nonce (24) + ciphertext + tag (16), so the plaintext
// budget is smaller; 8 more bytes of headroom for base64 rounding.
export const MAX_TEXT_BYTES = Math.floor(((MAX_MESSAGE_BYTES - crypto.PREFIX.length) * 3) / 4) - 24 - 16 - 8;

const TIMEOUT_MS = 15_000;

export class RelayError extends Error {}

async function detail(r: Response): Promise<string> {
  const raw = await r.text();
  try {
    const d = JSON.parse(raw).detail;
    return (typeof d === "string" ? d : JSON.stringify(d)).slice(0, 200);
  } catch {
    return raw.slice(0, 200);
  }
}

export class RoomClient {
  readonly alias: string;
  readonly cfg: RoomConfig;
  readonly ident: Config;
  readonly url: string;
  readonly room: string;
  readonly token: string;
  readonly key: Buffer;
  session: string | null = null;

  constructor(alias: string, cfg?: RoomConfig, ident?: Config) {
    this.alias = alias;
    this.cfg = cfg ?? store.room(alias);
    this.ident = ident ?? store.me();
    const secret = crypto.b64d(this.cfg.secret);
    this.url = this.cfg.url.replace(/\/+$/, "");
    this.room = crypto.roomName(secret);
    this.token = crypto.relayToken(secret);
    this.key = crypto.messageKey(secret);
  }

  private get name(): string {
    return String(this.ident.name);
  }

  // -- transport --

  private async join(): Promise<number> {
    const r = await fetch(`${this.url}/v1/join`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ room: this.room, display_name: this.name, identity_key: this.ident.identity_key }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status !== 200) throw new RelayError(`join failed (${r.status}): ${await detail(r)}`);
    const d = (await r.json()) as { session_id: unknown; cursor?: unknown };
    this.session = String(d.session_id);
    return Number(d.cursor) || 0;
  }

  private async call(method: string, path: string, opts: { json?: unknown; params?: Record<string, string | number> } = {}): Promise<any> {
    if (!this.session) await this.join();
    let target = this.url + path;
    if (opts.params) {
      target += "?" + new URLSearchParams(Object.entries(opts.params).map(([k, v]): [string, string] => [k, String(v)])).toString();
    }
    for (const attempt of [0, 1]) {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.token}`,
        "X-Ponte-Room": this.room,
        "X-Ponte-Session": this.session ?? "",
      };
      if (opts.json !== undefined) headers["Content-Type"] = "application/json";
      const r = await fetch(target, {
        method,
        headers,
        body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (r.status === 401 && attempt === 0) {
        await r.body?.cancel();
        await this.join(); // session expired, or the relay restarted
        continue;
      }
      if (r.status !== 200) throw new RelayError(`${path} failed (${r.status}): ${await detail(r)}`);
      return r.json();
    }
    throw new RelayError(`${path} failed`);
  }

  // -- API --

  async send(text: string, to: string | null = null): Promise<number> {
    if (utf8Length(text) > MAX_TEXT_BYTES) {
      throw new Error(`message too long (max ${MAX_TEXT_BYTES} bytes): split it, or share a file path`);
    }
    const body = crypto.seal(this.key, this.room, this.name, text);
    const d = await this.call("POST", "/v1/send", { json: { text: body, to } });
    store.log(this.alias, this.name + (to ? ` → ${to}` : ""), text);
    return Number(d.id) || 0;
  }

  async peers(): Promise<string[]> {
    const d = await this.call("GET", "/v1/peers");
    return (d.peers ?? []).map((p: { display_name: string }) => p.display_name);
  }

  /** New messages from others, opened and cleaned. Advances the stored cursor. */
  async fetch(): Promise<InboxMessage[]> {
    return store.locked("state", async () => {
      const cursors = store.cursors();
      let since = Number(cursors[this.alias] ?? 0) || 0;
      if (!this.session) since = Math.max(since, await this.join());
      const out: InboxMessage[] = [];
      for (;;) {
        const d = await this.call("GET", "/v1/poll", { params: { since, limit: 100 } });
        for (const m of d.messages ?? []) {
          since = Math.max(since, Number(m.id));
          if (m.from === this.name) continue;
          out.push(this.open(m));
        }
        if (!d.more) break;
      }
      const latest = store.cursors(); // keep other rooms' cursors as they are now
      latest[this.alias] = since;
      store.saveCursors(latest);
      return out;
    });
  }

  private open(m: { id: number; from: string; to?: string | null; text: string; flags?: string[]; at?: number }): InboxMessage {
    const flags = new Set((m.flags ?? []).filter(Boolean));
    let text: string;
    try {
      const plain = crypto.openSealed(this.key, this.room, m.from, m.text);
      const [clean, extra] = sanitize(plain);
      text = clean;
      for (const f of extra) flags.add(f);
    } catch (err) {
      if (!(err instanceof crypto.DecryptError)) throw err;
      text = "[ponte: this message could not be decrypted or verified; it was not shown]";
      flags.add("decryption-failed");
    }
    return {
      room: this.alias, id: m.id, from: m.from, to: m.to ?? null, text,
      flags: [...flags].sort(), at: m.at || Date.now() / 1000,
    };
  }
}

const clients = new Map<string, RoomClient>();

/** Long-lived clients, so a polling loop does not join the room again every round. */
export function clientFor(alias: string): RoomClient {
  const cfg = store.room(alias);
  const c = clients.get(alias);
  if (c && JSON.stringify(c.cfg) === JSON.stringify(cfg)) return c;
  const fresh = new RoomClient(alias, cfg);
  clients.set(alias, fresh);
  return fresh;
}

export function resetClients(): void {
  clients.clear();
}

/** Fetch every room into the inbox and the logs. */
export async function fetchAll(notify?: (m: InboxMessage) => void): Promise<InboxMessage[]> {
  const got: InboxMessage[] = [];
  for (const alias of Object.keys(store.rooms())) {
    let msgs: InboxMessage[];
    try {
      msgs = await clientFor(alias).fetch();
    } catch {
      clients.delete(alias); // one unreachable relay must not hold up the others
      continue;
    }
    for (const m of msgs) store.log(alias, m.from, m.text, m.at);
    if (msgs.length) {
      await store.locked("inbox", () => store.inboxAppend(msgs));
      if (notify) for (const m of msgs) notify(m);
    }
    got.push(...msgs);
  }
  return got;
}
