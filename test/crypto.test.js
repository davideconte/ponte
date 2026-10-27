import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as crypto from "../dist/crypto.js";
import { decodeInvite, encodeInvite } from "../dist/invite.js";
import { ROOT } from "./helpers.js";

const vectors = JSON.parse(readFileSync(join(ROOT, "test", "fixtures", "vectors.json"), "utf8"));

test("key derivation matches the Python implementation", () => {
  for (const v of vectors.rooms) {
    const secret = crypto.b64d(v.secret_b64);
    assert.equal(crypto.roomName(secret), v.room);
    assert.equal(crypto.relayToken(secret), v.token);
    assert.equal(crypto.messageKey(secret).toString("hex"), v.key_hex);
    assert.equal(crypto.b64e(secret), v.secret_b64);
  }
});

test("sealing with a fixed nonce gives byte-identical envelopes", () => {
  for (const v of vectors.rooms) {
    const key = Buffer.from(v.key_hex, "hex");
    for (const s of v.sealed_fixed_nonce) {
      const body = crypto.seal(key, v.room, s.sender, s.text, Buffer.from(s.nonce_hex, "hex"));
      assert.equal(body, s.body);
      assert.equal(crypto.openSealed(key, v.room, s.sender, s.body), s.text);
    }
  }
});

test("envelopes sealed by Python open in TypeScript", () => {
  for (const v of vectors.rooms) {
    const key = Buffer.from(v.key_hex, "hex");
    for (const s of v.sealed_random_nonce) assert.equal(crypto.openSealed(key, v.room, s.sender, s.body), s.text);
  }
});

test("seal roundtrip, sender binding, wrong key", () => {
  const key = crypto.messageKey(crypto.newSecret());
  const body = crypto.seal(key, "r-x", "alice", "ciao ✓");
  assert.ok(body.startsWith("ponte1."));
  assert.equal(crypto.openSealed(key, "r-x", "alice", body), "ciao ✓");
  assert.throws(() => crypto.openSealed(key, "r-x", "mallory", body), crypto.DecryptError); // relabelled sender
  assert.throws(() => crypto.openSealed(key, "r-y", "alice", body), crypto.DecryptError); // other room
  assert.throws(() => crypto.openSealed(crypto.messageKey(crypto.newSecret()), "r-x", "alice", body), crypto.DecryptError);
  assert.throws(() => crypto.openSealed(key, "r-x", "alice", "plain text"), crypto.DecryptError);
  assert.throws(() => crypto.openSealed(key, "r-x", "alice", "ponte1.AAAA"), crypto.DecryptError);
  const tampered = body.slice(0, -2) + (body.endsWith("A") ? "B" : "A") + body.slice(-1);
  assert.throws(() => crypto.openSealed(key, "r-x", "alice", tampered), crypto.DecryptError);
  assert.notEqual(crypto.seal(key, "r-x", "alice", "same"), crypto.seal(key, "r-x", "alice", "same")); // fresh nonce
});

test("invites are byte-identical to the Python encoder and decode back", () => {
  for (const v of vectors.invites) {
    const secret = crypto.b64d(v.secret_b64);
    assert.equal(encodeInvite(v.url, secret, v.host), v.invite);
    const back = decodeInvite(v.invite);
    assert.equal(back.url, v.url);
    assert.equal(back.hostName, v.host);
    assert.deepEqual([...back.secret], [...secret]);
  }
});

test("invite roundtrip and rejection of damaged invites", () => {
  const secret = crypto.newSecret();
  const back = decodeInvite("  " + encodeInvite("http://host.local:8787/", secret, "davide") + "\n");
  assert.equal(back.url, "http://host.local:8787");
  assert.equal(back.hostName, "davide");
  assert.ok(back.secret.equals(secret));

  const blob = (obj) => "ponte1_" + Buffer.from(JSON.stringify(obj)).toString("base64url");
  const cases = [
    ["hello", /start with 'ponte1_'/],
    ["ponte1_!!!", /damaged/],
    ["ponte1_" + Buffer.from("[1,2]").toString("base64url"), /damaged/],
    [blob({ u: "http://x" }), /damaged/],
    [encodeInvite("ftp://x", crypto.newSecret()), /invalid relay URL/],
    [blob({ u: 42, s: crypto.b64e(secret) }), /invalid relay URL/],
    [blob({ u: "http://x", s: crypto.b64e(secret.subarray(0, 16)) }), /invalid secret/],
  ];
  for (const [text, why] of cases) assert.throws(() => decodeInvite(text), why, text);
  // A host name that is not a string is ignored rather than fatal.
  assert.equal(decodeInvite(blob({ u: "http://x", s: crypto.b64e(secret), h: 7 })).hostName, "");
});
