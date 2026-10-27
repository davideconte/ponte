import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import * as store from "../dist/store.js";
import { ROOT, asPerson, person, removeDir, tempDir } from "./helpers.js";

const root = tempDir();
after(() => removeDir(root));
const mode = (p) => statSync(p).mode & 0o777;

test("state files: names, shapes and permissions", async () => {
  const who = person(root, "alice");
  await asPerson(who, () => {
    assert.throws(() => store.me(), /ponte init/);
    assert.throws(() => store.init("bad\nname"), /name:/);
    const cfg = store.init("alice");
    assert.equal(cfg.name, "alice");
    assert.match(cfg.identity_key, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(store.init("alice").identity_key, cfg.identity_key); // kept on re-init

    const h = store.home();
    assert.equal(h, who.home);
    assert.equal(mode(h), 0o700);
    assert.equal(mode(join(h, "logs")), 0o700);
    assert.equal(mode(join(h, "config.json")), 0o600);
    assert.equal(readFileSync(join(h, "config.json"), "utf8"), JSON.stringify(cfg, null, 1));

    store.saveRooms({ proj: { url: "http://x", secret: "s", peer: "bob", role: "host", created: "2026-10-27" } });
    assert.equal(store.room("proj").peer, "bob");
    assert.throws(() => store.room("nope"), /No room called 'nope' \(known: proj\)/);
    assert.equal(mode(join(h, "rooms.json")), 0o600);
    store.saveCursors({ proj: 7 });
    assert.deepEqual(store.cursors(), { proj: 7 });
    assert.ok(!readdirSync(h).some((f) => f.endsWith(".tmp")));

    assert.equal(store.checkAlias("acme-site"), "acme-site");
    for (const bad of ["Acme", "-x", "a b", "x".repeat(41)]) assert.throws(() => store.checkAlias(bad));

    writeFileSync(join(h, "cursors.json"), "{damaged");
    assert.deepEqual(store.cursors(), {}); // unreadable JSON falls back to empty
  });
});

test("inbox: append, peek, take per room, counts, Python-compatible lines", async () => {
  const who = person(root, "bob");
  await asPerson(who, () => {
    const m = (room, id) => ({ room, id, from: "carlo", to: null, text: `t${id} \u00e9`, flags: [], at: 1_800_000_000.5 });
    store.inboxAppend([m("a", 1), m("b", 2), m("a", 3)]);
    const path = join(store.home(), "inbox.jsonl");
    assert.equal(mode(path), 0o600);
    assert.equal(
      readFileSync(path, "utf8").split("\n")[0],
      '{"room": "a", "id": 1, "from": "carlo", "to": null, "text": "t1 \u00e9", "flags": [], "at": 1800000000.5}',
    );
    assert.deepEqual(store.inboxCount(), { a: 2, b: 1 });
    assert.equal(store.inboxTake("a", true).length, 2);
    assert.deepEqual(store.inboxTake("a").map((x) => x.id), [1, 3]);
    assert.deepEqual(store.inboxCount(), { b: 1 });
    assert.deepEqual(store.inboxTake().map((x) => x.id), [2]);
    assert.deepEqual(store.inboxTake(), []);
  });
});

test("logs and their tail", async () => {
  const who = person(root, "carlo");
  await asPerson(who, () => {
    assert.equal(store.logTail("proj"), "");
    store.log("proj", "carlo", "  first  ", 1_800_000_000);
    store.log("proj", "dana", "second");
    store.log("proj", "carlo → dana", "third");
    const raw = readFileSync(store.logPath("proj"), "utf8");
    assert.match(raw, /^\n### \d{4}-\d\d-\d\d \d\d:\d\d · carlo\n\nfirst\n/);
    assert.equal(mode(store.logPath("proj")), 0o600);
    const tail = store.logTail("proj", 2);
    assert.ok(!tail.includes("first") && tail.includes("second") && tail.includes("third"));
    assert.ok(store.logTail("proj", 0).includes("first")); // 0 means everything
  });
});

test("daemon liveness from daemon.pid", async () => {
  const who = person(root, "dana");
  await asPerson(who, () => {
    assert.equal(store.daemonAlive(), false);
    writeFileSync(store.pidPath(), String(process.pid));
    assert.equal(store.daemonAlive(), true);
    writeFileSync(store.pidPath(), "999999999");
    assert.equal(store.daemonAlive(), false);
    writeFileSync(store.pidPath(), "garbage");
    assert.equal(store.daemonAlive(), false);
  });
});

function worker(home, rounds) {
  const script = `
    import * as store from ${JSON.stringify(join(ROOT, "dist", "store.js"))};
    for (let i = 0; i < ${rounds}; i++) {
      await store.locked("state", async () => {
        const c = store.cursors();
        const v = (c.n ?? 0);
        await new Promise((r) => setTimeout(r, 1));
        c.n = v + 1;
        store.saveCursors(c);
      });
    }`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, PONTE_HOME: home } });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err))));
  });
}

test("the state lock serializes processes", async () => {
  const who = person(root, "lock");
  await Promise.all([worker(who.home, 40), worker(who.home, 40), worker(who.home, 40)]);
  await asPerson(who, () => {
    assert.equal(store.cursors().n, 120);
    assert.ok(!existsSync(join(who.home, ".state.lockfile")));
  });
});

test("a lock left by a dead process is taken over", async () => {
  const who = person(root, "stale");
  await asPerson(who, async () => {
    writeFileSync(join(store.home(), ".inbox.lockfile"), "999999999 0\n");
    const got = await store.locked("inbox", () => "acquired");
    assert.equal(got, "acquired");
  });
});

test("the daemon pins hosted rooms that are missing from the pins file", async () => {
  const { pinHostedRooms, relayPinsPath } = await import("../dist/daemon.js");
  const crypto = await import("../dist/crypto.js");
  const who = person(root, "migrated");
  await asPerson(who, async () => {
    store.init("migrated");
    const hosted = crypto.newSecret();
    store.saveRooms({
      mine: { url: "http://x", secret: crypto.b64e(hosted), role: "host" },
      theirs: { url: "http://y", secret: crypto.b64e(crypto.newSecret()), role: "guest" },
    });
    assert.equal(await pinHostedRooms(), 1);
    const pins = JSON.parse(readFileSync(relayPinsPath(), "utf8"));
    assert.deepEqual(Object.keys(pins), [crypto.roomName(hosted)]);
    assert.equal(await pinHostedRooms(), 0);
  });
});
