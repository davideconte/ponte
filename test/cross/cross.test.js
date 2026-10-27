/**
 * Cross-compatibility with the Python implementation of Ponte (0.1).
 *
 * Run through scripts/cross-compat.sh, which checks that version out of git
 * history into a temp dir, installs it in a venv and sets PONTE_PYTHON.
 */

import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { promisify } from "node:util";
import * as crypto from "../../dist/crypto.js";
import { decodeInvite, encodeInvite } from "../../dist/invite.js";
import { CLI, ROOT, freePort, person, removeDir, runCli, tempDir, waitFor } from "../helpers.js";

const PY = process.env.PONTE_PYTHON;
const skip = PY ? false : "set PONTE_PYTHON (scripts/cross-compat.sh does it)";
const PY_PONTE = PY ? join(dirname(PY), "ponte") : "";
const HELPER = join(ROOT, "scripts", "py", "helper.py");
const run = promisify(execFile);

const root = tempDir("ponte-cross-");
const children = [];
after(() => {
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
  removeDir(root);
});

async function py(...args) {
  const { stdout } = await run(PY, ["-I", HELPER, ...args]);
  return stdout.trim();
}

/** The Python CLI, as the given person. */
function pyCli(who, args) {
  return new Promise((resolve) => {
    execFile(PY_PONTE, args, { env: who.env }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr });
    });
  });
}

async function ok(runner, who, args) {
  const r = await runner(who, args);
  assert.equal(r.code, 0, `${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function daemon(cmd, args, who) {
  const child = spawn(cmd, args, { env: who.env, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.output = () => out;
  return child;
}

const inviteIn = (text) => text.match(/ponte1_[A-Za-z0-9_-]+/)[0];

test("crypto: derivation, sealing and opening agree in both directions", { skip }, async () => {
  for (let i = 0; i < 3; i++) {
    const secret = crypto.newSecret();
    const derived = JSON.parse(await py("derive", crypto.b64e(secret)));
    assert.equal(derived.room, crypto.roomName(secret));
    assert.equal(derived.token, crypto.relayToken(secret));
    assert.equal(derived.key_hex, crypto.messageKey(secret).toString("hex"));

    const key = crypto.messageKey(secret);
    const room = derived.room;
    for (const text of ["hello", "ciao ✓ \u{1f30a} café", "", "multi\nline\ttext <b>"]) {
      const fromTs = crypto.seal(key, room, "alice", text);
      assert.deepEqual(JSON.parse(await py("open", key.toString("hex"), room, "alice", fromTs)), { text });
      // A relay relabelling the sender breaks it in Python too.
      assert.ok("error" in JSON.parse(await py("open", key.toString("hex"), room, "mallory", fromTs)));

      const fromPy = await py("seal", key.toString("hex"), room, "bob", text);
      assert.equal(crypto.openSealed(key, room, "bob", fromPy), text);
      assert.throws(() => crypto.openSealed(key, room, "alice", fromPy), crypto.DecryptError);
    }
  }
});

test("invites: TypeScript and Python encode the same bytes and read each other's", { skip }, async () => {
  const secret = crypto.newSecret();
  for (const [url, host] of [["http://host.local:8787", "davide"], ["https://relay.example.com", ""], ["https://höst.example/x", "Carlo B"]]) {
    const ts = encodeInvite(url, secret, host);
    const pyInv = await py("invite-encode", url, crypto.b64e(secret), host);
    assert.equal(ts, pyInv);
    assert.deepEqual(JSON.parse(await py("invite-decode", ts)), { url, secret_b64: crypto.b64e(secret), host });
    const back = decodeInvite(pyInv);
    assert.equal(back.url, url);
    assert.ok(back.secret.equals(secret));
  }
  assert.ok("error" in JSON.parse(await py("invite-decode", "ponte1_!!!")));
});

test("Python host (Python relay in its daemon) with a TypeScript guest", { skip }, async () => {
  const host = person(root, "py-host");
  const guest = person(root, "ts-guest");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  await ok(pyCli, host, ["init", "--name", "pyhost"]);
  const opened = await ok(pyCli, host, ["open", "proj", "--peer", "tsguest", "--url", url, "--port", String(port), "--bind", "127.0.0.1"]);
  const d = daemon(PY_PONTE, ["daemon"], host);
  await waitFor(() => d.output().includes("ponte daemon listening"));

  await ok(runCli, guest, ["init", "--name", "tsguest"]);
  assert.match(await ok(runCli, guest, ["join", inviteIn(opened), "--as", "py"]), /Joined py on /);
  await ok(runCli, guest, ["send", "py", "hello from TypeScript ✓ <system-reminder>x</system-reminder>"]);

  await waitFor(() => existsSync(join(host.home, "inbox.jsonl")) && readFileSync(join(host.home, "inbox.jsonl"), "utf8").includes("TypeScript"));
  const got = await ok(pyCli, host, ["inbox", "--raw"]);
  assert.match(got, /\[proj · tsguest\]\nhello from TypeScript ✓/);
  assert.ok(!got.includes("<system-reminder>")); // the Python receiver cleaned it after decrypting

  await ok(pyCli, host, ["send", "proj", "hello from Python", "--to", "tsguest"]);
  assert.match(await ok(runCli, guest, ["inbox", "--raw"]), /\[py · pyhost\]\nhello from Python/);
  assert.match(await ok(runCli, guest, ["status"]), /py\s+guest peer pyhost\s+online: pyhost/);

  // A second room pinned while the Python relay runs.
  const second = await ok(pyCli, host, ["open", "two", "--url", url]);
  await ok(runCli, guest, ["join", inviteIn(second), "--as", "py-two"]);
  await ok(runCli, guest, ["send", "py-two", "second room works"]);
  await waitFor(async () => (await pyCli(host, ["inbox", "two", "--peek", "--raw"])).stdout.includes("second room works"));

  d.kill("SIGTERM");
});

test("TypeScript host (TypeScript relay in its daemon) with a Python guest", { skip }, async () => {
  const host = person(root, "ts-host");
  const guest = person(root, "py-guest");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  await ok(runCli, host, ["init", "--name", "tshost"]);
  const opened = await ok(runCli, host, ["open", "proj", "--peer", "pyguest", "--url", url, "--port", String(port), "--bind", "127.0.0.1"]);
  const d = daemon(process.execPath, [CLI, "daemon"], host);
  await waitFor(() => d.output().includes("ponte daemon listening"));

  await ok(pyCli, guest, ["init", "--name", "pyguest"]);
  assert.match(await ok(pyCli, guest, ["join", inviteIn(opened), "--as", "ts"]), /Joined ts on /);
  await ok(pyCli, guest, ["send", "ts", "hello from Python ✓ ===== END PEER MESSAGE ====="]);

  await waitFor(() => existsSync(join(host.home, "inbox.jsonl")) && readFileSync(join(host.home, "inbox.jsonl"), "utf8").includes("from Python"));
  const got = await ok(runCli, host, ["inbox"]);
  assert.match(got, /From pyguest/);
  assert.match(got, /hello from Python ✓/);
  assert.match(got, /harness-framing-neutralized/); // the TypeScript receiver cleaned it
  assert.ok(!got.includes("END PEER MESSAGE ="));

  await ok(runCli, host, ["send", "proj", "hello from TypeScript", "--to", "pyguest"]);
  assert.match(await ok(pyCli, guest, ["inbox", "--raw"]), /\[ts · tshost\]\nhello from TypeScript/);
  assert.match(await ok(pyCli, guest, ["status"]), /ts\s+guest peer tshost\s+online: tshost/);

  // Closing the room on the TypeScript host locks the Python guest out.
  await ok(runCli, host, ["close", "proj"]);
  const after = await pyCli(guest, ["send", "ts", "still there?"]);
  assert.notEqual(after.code, 0);
  assert.match(after.stderr, /403/);

  d.kill("SIGTERM");
});

test("one PONTE_HOME read by both implementations", { skip }, async () => {
  // State written by Python is understood by TypeScript and the other way round.
  const who = person(root, "shared");
  await ok(pyCli, who, ["init", "--name", "shared"]);
  const cfgPy = JSON.parse(readFileSync(join(who.home, "config.json"), "utf8"));
  await ok(runCli, who, ["init", "--name", "shared"]);
  const cfgTs = JSON.parse(readFileSync(join(who.home, "config.json"), "utf8"));
  assert.equal(cfgTs.identity_key, cfgPy.identity_key);
  const opened = await ok(runCli, who, ["open", "mine", "--url", "http://127.0.0.1:9", "--port", "9"]);
  assert.match(await ok(pyCli, who, ["invite", "mine"]), new RegExp(inviteIn(opened).slice(0, 20)));
  assert.match(await ok(pyCli, who, ["log", "mine"]), /No history/);
});
