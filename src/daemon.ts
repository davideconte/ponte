/**
 * The background service. If you host rooms it runs the relay; in every case
 * it polls all your rooms, so messages reach the inbox, the logs and a desktop
 * notification within seconds, whether or not an agent is open.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";
import { fetchAll } from "./client.js";
import * as crypto from "./crypto.js";
import { Relay, pinRoom } from "./relay.js";
import * as store from "./store.js";
import type { InboxMessage } from "./store.js";
import { PonteExit, errorMessage, sleep, which } from "./util.js";

export const POLL_SECONDS = 5;

export function relayStorePath(): string {
  return join(store.home(), "relay.json");
}

/** Rooms the host has opened; the relay picks up changes while it runs. */
export function relayPinsPath(): string {
  return join(store.home(), "relay-rooms.json");
}

export function notify(m: InboxMessage): void {
  if (process.env.PONTE_NO_NOTIFY) return;
  const title = `Ponte · ${m.room} · ${m.from}`;
  const text = m.text.split(/\s+/).filter(Boolean).join(" ").slice(0, 180);
  try {
    if (platform() === "darwin") {
      const q = (s: string) => s.replace(/\\/g, " ").replace(/"/g, "'");
      spawnSync("osascript", ["-e", `display notification "${q(text)}" with title "${q(title)}"`], { timeout: 5000, stdio: "ignore" });
    } else if (which("notify-send")) {
      spawnSync("notify-send", [title, text], { timeout: 5000, stdio: "ignore" });
    }
  } catch {
    // a missing notifier is not worth failing over
  }
}

/**
 * Make sure every room you host is pinned on your relay. Normally `ponte open`
 * already did it; this also covers rooms opened with the Python version of
 * Ponte, whose relay kept its rooms in relay.db.
 */
export async function pinHostedRooms(): Promise<number> {
  let pins: Record<string, unknown> = {};
  try {
    pins = JSON.parse(readFileSync(relayPinsPath(), "utf8"));
  } catch {
    // no pins yet
  }
  let added = 0;
  for (const cfg of Object.values(store.rooms())) {
    if (cfg.role !== "host" || typeof cfg.secret !== "string") continue;
    const secret = crypto.b64d(cfg.secret);
    const room = crypto.roomName(secret);
    if (room in pins) continue;
    await pinRoom(relayPinsPath(), room, crypto.relayToken(secret));
    added++;
  }
  return added;
}

export async function startRelay(port: number, bind: string): Promise<Relay> {
  await pinHostedRooms();
  const relay = new Relay({ storePath: relayStorePath(), pinsPath: relayPinsPath(), openRooms: false });
  try {
    await relay.listen(port, bind);
  } catch {
    throw new PonteExit(`ponte: the relay could not start on ${bind}:${port} (port in use?)`);
  }
  return relay;
}

export async function run(): Promise<void> {
  const cfg = store.me();
  const host = cfg.host;
  let relay: Relay | null = null;
  if (host) {
    const port = Number(host.port ?? 8787);
    const bind = host.bind ?? "0.0.0.0";
    relay = await startRelay(port, bind);
    console.log(`relay listening on ${bind}:${port}`);
  }
  const stop = () => {
    try {
      relay?.flush();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  writeFileSync(store.pidPath(), String(process.pid), { mode: 0o600 });
  console.log(`ponte daemon listening to ${Object.keys(store.rooms()).length} room(s)`);
  for (;;) {
    try {
      await fetchAll(notify);
    } catch (err) {
      const t = new Date().toTimeString().slice(0, 8);
      console.error(`${t} ${errorMessage(err)}`);
    }
    await sleep(POLL_SECONDS * 1000);
  }
}
