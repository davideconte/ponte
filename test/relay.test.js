import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, beforeEach, test } from "node:test";
import { LIMITS, Relay, pinRoom, unpinRoom } from "../dist/relay.js";
import { removeDir, tempDir } from "./helpers.js";

let relay;
let base;
let clock;
const dirs = [];

async function start(options = {}) {
  clock = { t: 1_800_000_000 };
  relay = new Relay({ openRooms: true, now: () => clock.t, ...options });
  const port = await relay.listen(0);
  base = `http://127.0.0.1:${port}`;
}

beforeEach(() => start());
afterEach(() => relay.close());
after(() => dirs.forEach(removeDir));

const keyFor = (name) => `identity-key-of-${name}`.padEnd(24, "x");

async function call(method, path, { headers = {}, json, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (json !== undefined) {
    init.body = JSON.stringify(json);
    init.headers["content-type"] = "application/json";
  } else if (raw !== undefined) {
    init.body = raw;
    init.headers["content-type"] = "application/json";
  }
  const r = await fetch(base + path, init);
  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body, text };
}

function join_(room, name, token, key) {
  return call("POST", "/v1/join", {
    json: { room, display_name: name, identity_key: key ?? keyFor(name) },
    headers: { authorization: `Bearer ${token}` },
  });
}

async function member(room, name, token = "t", key) {
  const r = await join_(room, name, token, key);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { ...r.body, token };
}

const auth = (who, room = who.room, token = who.token) => ({
  authorization: `Bearer ${token}`, "x-ponte-room": room, "x-ponte-session": who.session_id,
});

function send(who, text, to) {
  return call("POST", "/v1/send", { json: to ? { text, to } : { text }, headers: auth(who) });
}

async function poll(who, since = who.cursor, limit) {
  const q = `?since=${since}` + (limit ? `&limit=${limit}` : "");
  const r = await call("GET", "/v1/poll" + q, { headers: auth(who) });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

const texts = (p) => p.messages.map((m) => m.text);

test("health", async () => {
  const r = await call("GET", "/healthz");
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(typeof r.body.version, "string");
});

test("no API explorer and proper 404 / 405", async () => {
  assert.equal((await call("GET", "/docs")).status, 404);
  assert.equal((await call("GET", "/openapi.json")).status, 404);
  assert.deepEqual((await call("GET", "/nope")).body, { detail: "Not Found" });
  assert.equal((await call("GET", "/v1/join")).status, 405);
});

test("join is trust on first use for the room token", async () => {
  assert.equal((await join_("duo", "sara", "s3cret")).status, 200);
  assert.equal((await join_("duo", "friend", "s3cret")).status, 200);
  assert.equal((await join_("duo", "intruder", "wrong")).status, 403);
});

test("join validates its input", async () => {
  const h = { authorization: "Bearer t" };
  assert.equal((await call("POST", "/v1/join", { json: { room: "duo", display_name: "sara" }, headers: h })).status, 422);
  assert.equal((await call("POST", "/v1/join", { json: { room: "duo", display_name: "x", identity_key: "short" }, headers: h })).status, 422);
  assert.equal((await call("POST", "/v1/join", { json: { room: "duo", display_name: 5, identity_key: keyFor("a") }, headers: h })).status, 422);
  assert.equal((await call("POST", "/v1/join", { raw: "{not json", headers: h })).status, 422);
  assert.equal((await call("POST", "/v1/join", { raw: "[1]", headers: h })).status, 422);
  assert.equal((await call("POST", "/v1/join", { json: { room: "duo", display_name: "a", identity_key: keyFor("a") } })).status, 401);
  assert.equal((await join_("!!", "sara", "t")).status, 400);
  assert.equal((await join_("duo", "<system>", "t")).status, 400);
  assert.equal((await join_("duo", "bob\n", "t")).status, 400);
});

test("a display name belongs to its identity key", async () => {
  await member("duo", "sara");
  assert.equal((await join_("duo", "sara", "t", keyFor("someone-else"))).status, 409);
});

test("a name cannot be taken after its owner goes idle", async () => {
  const owner = await member("duo", "bob");
  const alice = await member("duo", "alice");
  await send(alice, "for bob only", "bob");
  clock.t += 3600;
  assert.equal((await join_("duo", "bob", "t", keyFor("mallory"))).status, 409);
  assert.deepEqual(texts(await poll(owner)), ["for bob only"]);
});

test("the same identity can rejoin while still online", async () => {
  await member("duo", "sara");
  await member("duo", "sara");
});

test("rejoining resumes where the last session stopped", async () => {
  const a = await member("duo", "sara");
  const b = await member("duo", "friend");
  await send(a, "one");
  assert.deepEqual(texts(await poll(b)), ["one"]);
  await send(a, "two, sent while you were restarting");
  const b2 = await member("duo", "friend");
  assert.deepEqual(texts(await poll(b2)), ["two, sent while you were restarting"]);
});

test("first join gets recent messages, not old history", async () => {
  const a = await member("duo", "sara");
  await send(a, "ancient");
  clock.t += LIMITS.backlogSeconds + 60;
  await send(a, "hi friend, are you there yet?");
  const b = await member("duo", "friend");
  assert.deepEqual(texts(await poll(b)), ["hi friend, are you there yet?"]);
});

test("first join backlog is capped", async () => {
  const a = await member("duo", "sara");
  for (let i = 0; i < LIMITS.backlogMessages + 5; i++) await send(a, `m${i}`);
  const b = await member("duo", "friend");
  const got = texts(await poll(b));
  assert.equal(got.length, LIMITS.backlogMessages);
  assert.equal(got.at(-1), `m${LIMITS.backlogMessages + 4}`);
});

test("a message reaches the peer but never echoes to its sender", async () => {
  const a = await member("duo", "sara");
  const b = await member("duo", "friend");
  const sent = await send(a, "starting on the loader");
  assert.equal(sent.status, 200);
  assert.equal(sent.body.ok, true);
  assert.deepEqual(sent.body.flags, []);
  const got = await poll(b);
  assert.deepEqual(texts(got), ["starting on the loader"]);
  assert.equal(got.messages[0].from, "sara");
  assert.equal(got.messages[0].to, null);
  assert.deepEqual(got.messages[0].flags, []);
  assert.equal(got.messages[0].at, clock.t);
  const a2 = await member("duo", "sara");
  assert.deepEqual((await poll(a)).messages, []);
  assert.deepEqual((await poll(a2, 0)).messages, []);
});

test("a direct message is invisible to a third person", async () => {
  const a = await member("trio", "sara");
  const b = await member("trio", "friend");
  const c = await member("trio", "other");
  await send(a, "just for you", "friend");
  const got = await poll(b);
  assert.deepEqual(texts(got), ["just for you"]);
  assert.equal(got.messages[0].to, "friend");
  assert.deepEqual((await poll(c)).messages, []);
  assert.deepEqual((await poll(c, 0)).messages, []);
});

test("a direct message to an unknown name is refused", async () => {
  const a = await member("duo", "sara");
  const r = await send(a, "hello?", "frend");
  assert.equal(r.status, 404);
  assert.match(r.body.detail, /frend/);
  assert.equal((await send(a, "x", "bad\nname")).status, 400);
});

test("you cannot message yourself", async () => {
  const a = await member("duo", "sara");
  assert.equal((await send(a, "hi me", "sara")).status, 400);
});

test("the cursor advances so messages are not repeated", async () => {
  const a = await member("duo", "sara");
  const b = await member("duo", "friend");
  await send(a, "one");
  const first = await poll(b);
  assert.equal(first.messages.length, 1);
  assert.deepEqual((await poll(b, first.cursor)).messages, []);
  assert.equal((await poll(b, first.cursor)).cursor, first.cursor);
});

test("poll says when more messages are waiting", async () => {
  const a = await member("duo", "sara");
  const b = await member("duo", "friend");
  for (let i = 0; i < 3; i++) await send(a, `m${i}`);
  const page = await poll(b, b.cursor, 2);
  assert.equal(page.messages.length, 2);
  assert.equal(page.more, true);
  const rest = await poll(b, page.cursor);
  assert.equal(rest.messages.length, 1);
  assert.equal(rest.more, false);
});

test("poll validates since and limit", async () => {
  const a = await member("duo", "sara");
  for (const q of ["?since=-1", "?since=abc", "?limit=0", "?limit=101"]) {
    assert.equal((await call("GET", "/v1/poll" + q, { headers: auth(a) })).status, 422, q);
  }
});

test("a session from one room cannot act in another", async () => {
  const a = await member("room-a", "sara", "token-a");
  await member("room-b", "friend", "token-b");
  const r = await call("POST", "/v1/send", { json: { text: "leak" }, headers: auth(a, "room-b", "token-b") });
  assert.equal(r.status, 401);
});

test("only a join can create a room", async () => {
  const r = await call("POST", "/v1/heartbeat", {
    headers: { authorization: "Bearer anything", "x-ponte-room": "!!not a room!!", "x-ponte-session": "made-up" },
  });
  assert.equal(r.status, 403);
  assert.equal(relay.roomCount(), 0);
});

test("missing credentials", async () => {
  const a = await member("duo", "sara");
  assert.equal((await call("GET", "/v1/peers")).status, 401);
  assert.equal((await call("GET", "/v1/peers", { headers: { authorization: "Bearer t" } })).status, 401);
  assert.equal((await call("GET", "/v1/peers", { headers: { ...auth(a), "x-ponte-session": "" } })).status, 401);
  assert.equal((await call("GET", "/v1/peers", { headers: { ...auth(a), authorization: "Basic abc" } })).status, 401);
});

test("a closed relay refuses unknown rooms", async () => {
  await relay.close();
  await start({ openRooms: false });
  assert.equal((await join_("squatter-room", "mallory", "x")).status, 403);
  assert.equal(relay.roomCount(), 0);
});

test("a wrong token is refused on every call", async () => {
  const a = await member("duo", "sara");
  assert.equal((await call("GET", "/v1/peers", { headers: auth(a, "duo", "wrong-token") })).status, 403);
});

test("oversize message is refused", async () => {
  const a = await member("duo", "sara");
  assert.equal((await send(a, "x".repeat(LIMITS.maxMessageBytes + 1))).status, 413);
  assert.equal((await send(a, "x".repeat(LIMITS.maxMessageBytes))).status, 200);
});

test("oversize request body is refused before parsing", async () => {
  const r = await call("POST", "/v1/join", { raw: "{" + " ".repeat(LIMITS.maxBodyBytes) + "}", headers: { authorization: "Bearer t" } });
  assert.equal(r.status, 413);
});

test("a lone surrogate is a 422, not a crash", async () => {
  const a = await member("duo", "sara");
  const r = await call("POST", "/v1/send", { raw: '{"text": "hi \\ud800 there"}', headers: auth(a) });
  assert.equal(r.status, 422);
  assert.ok(!r.text.includes("ud800"));
});

test("empty text and wrong types are 422", async () => {
  const a = await member("duo", "sara");
  assert.equal((await call("POST", "/v1/send", { json: { text: "" }, headers: auth(a) })).status, 422);
  assert.equal((await call("POST", "/v1/send", { json: { text: 3 }, headers: auth(a) })).status, 422);
  assert.equal((await call("POST", "/v1/send", { json: { text: "x", to: 3 }, headers: auth(a) })).status, 422);
  assert.equal((await call("POST", "/v1/send", { json: { text: "x", to: null }, headers: auth(a) })).status, 200);
});

test("rate limit, per person, survives rejoining, resets after a minute", async () => {
  const a = await member("duo", "sara");
  for (let i = 0; i < LIMITS.sendsPerMinute; i++) assert.equal((await send(a, "spam")).status, 200);
  assert.equal((await send(a, "spam")).status, 429);
  const fresh = await member("duo", "sara");
  assert.equal((await send(fresh, "more spam")).status, 429);
  clock.t += 61;
  assert.equal((await send(fresh, "later")).status, 200);
});

test("join rate limit per room", async () => {
  for (let i = 0; i < LIMITS.joinsPerRoomPerMinute; i++) await member("duo", "sara");
  assert.equal((await join_("duo", "sara", "t")).status, 429);
});

test("a room holds at most 16 names", async () => {
  for (let i = 0; i < LIMITS.maxNamesPerRoom; i++) {
    await member("big", `p${i}`);
    if (i % 15 === 14) clock.t += 61; // stay under the join rate limit
  }
  clock.t += 61;
  assert.equal((await join_("big", "one-too-many", "t")).status, 403);
});

test("old messages are pruned", async () => {
  const a = await member("duo", "sara");
  await send(a, "old news");
  relay.prune(clock.t + LIMITS.messageRetentionSeconds + 60);
  assert.equal(relay.inspect("duo").messages.length, 0);
});

test("a room keeps only its newest messages", async () => {
  const a = await member("duo", "sara");
  const room = relay.inspect("duo");
  for (let i = 0; i < LIMITS.maxMessagesPerRoom; i++) room.messages.push({ id: 1_000_000 + i, from: "x", to: null, body: "b", at: clock.t });
  await send(a, "newest");
  assert.equal(room.messages.length, LIMITS.maxMessagesPerRoom);
  assert.equal(room.messages.at(-1).body, "newest");
});

test("abandoned rooms and stale identities are pruned", async () => {
  await member("duo", "sara");
  relay.prune(clock.t + LIMITS.identitySeconds + 60);
  assert.equal(relay.inspect("duo"), undefined);
});

test("the relay stores bodies as they come: cleaning happens on the receiving client", async () => {
  const a = await member("duo", "sara");
  const b = await member("duo", "friend");
  await send(a, "ponte1.abc <system-reminder>");
  const got = await poll(b);
  assert.equal(got.messages[0].text, "ponte1.abc <system-reminder>");
});

test("peers lists the other people only, once each, and only while present", async () => {
  const a = await member("duo", "sara");
  await member("duo", "friend");
  await member("duo", "friend"); // second window: still one person
  const r = await call("GET", "/v1/peers", { headers: auth(a) });
  assert.deepEqual(r.body.peers.map((p) => p.display_name), ["friend"]);
  assert.equal(r.body.you, "sara");
  assert.equal(r.body.room, "duo");
  clock.t += LIMITS.presenceSeconds + 1;
  assert.deepEqual((await call("GET", "/v1/peers", { headers: auth(a) })).body.peers, []);
});

test("heartbeat", async () => {
  const a = await member("duo", "sara");
  assert.deepEqual((await call("POST", "/v1/heartbeat", { headers: auth(a) })).body, { ok: true, display_name: "sara" });
});

test("unknown session is refused", async () => {
  await member("duo", "sara");
  const r = await call("GET", "/v1/peers", { headers: { authorization: "Bearer t", "x-ponte-room": "duo", "x-ponte-session": "made-up" } });
  assert.equal(r.status, 401);
});

test("pinned rooms: added and removed while the relay runs, state persisted", async () => {
  await relay.close();
  const dir = tempDir();
  dirs.push(dir);
  const storePath = join(dir, "relay.json");
  const pinsPath = join(dir, "relay-rooms.json");
  await start({ openRooms: false, storePath, pinsPath });

  assert.equal((await join_("r-pinned1", "alice", "tok")).status, 403);
  await pinRoom(pinsPath, "r-pinned1", "tok");
  const a = await member("r-pinned1", "alice", "tok");
  const b = await member("r-pinned1", "bob", "tok");
  assert.equal((await join_("r-pinned1", "eve", "wrong")).status, 403);
  await send(a, "kept across restarts");
  relay.flush();
  assert.equal(statSync(storePath).mode & 0o777, 0o600);
  assert.equal(statSync(pinsPath).mode & 0o777, 0o600);
  assert.ok(!readFileSync(pinsPath, "utf8").includes('"tok"')); // only a hash of the token

  // Restart: messages, names and sessions survive.
  await relay.close();
  relay = new Relay({ openRooms: false, storePath, pinsPath, now: () => clock.t });
  base = `http://127.0.0.1:${await relay.listen(0)}`;
  assert.deepEqual(texts(await poll(b)), ["kept across restarts"]);
  assert.equal((await join_("r-pinned1", "alice", "tok", keyFor("mallory"))).status, 409);

  // Closing the room removes it and everything in it.
  await unpinRoom(pinsPath, "r-pinned1");
  assert.equal((await call("GET", "/v1/peers", { headers: auth(a) })).status, 403);
  assert.equal(relay.inspect("r-pinned1"), undefined);
  relay.flush();
  assert.ok(!readFileSync(storePath, "utf8").includes("kept across restarts"));
  assert.ok(existsSync(storePath));
});

test("an unreadable state file is set aside, not fatal", async () => {
  await relay.close();
  const dir = tempDir();
  dirs.push(dir);
  const storePath = join(dir, "relay.json");
  const { writeFileSync, readdirSync } = await import("node:fs");
  writeFileSync(storePath, "{broken");
  await start({ storePath });
  assert.equal((await call("GET", "/healthz")).status, 200);
  assert.ok(readdirSync(dir).some((f) => f.startsWith("relay.json.unreadable-")));
});
