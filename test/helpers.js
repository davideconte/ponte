import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const CLI = join(ROOT, "dist", "cli.js");

export function tempDir(prefix = "ponte-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * An isolated environment for one person: its own HOME, PONTE_HOME and Claude
 * config, notifications off, and fake clipboard tools first on PATH so tests
 * never touch the real clipboard, LaunchAgents or ~/.claude.
 */
export function person(root, name) {
  const base = join(root, name);
  const bin = join(base, "bin");
  mkdirSync(bin, { recursive: true });
  for (const tool of ["pbcopy", "wl-copy", "xclip"]) {
    const p = join(bin, tool);
    writeFileSync(p, `#!/bin/sh\ncat > "${join(base, "clipboard.txt")}"\n`);
    chmodSync(p, 0o755);
  }
  return {
    name,
    base,
    home: join(base, "ponte"),
    env: {
      ...process.env,
      HOME: base,
      PONTE_HOME: join(base, "ponte"),
      CLAUDE_CONFIG_DIR: join(base, "claude"),
      PONTE_NO_NOTIFY: "1",
      PATH: `${bin}:${process.env.PATH}`,
    },
  };
}

export function runCli(who, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: who.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ponte ${args.join(" ")} timed out\n${stdout}\n${stderr}`));
    }, 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input ?? "");
  });
}

/** Run an env-scoped function in-process: PONTE_HOME for the store, etc. */
export async function asPerson(who, fn) {
  const saved = { PONTE_HOME: process.env.PONTE_HOME, HOME: process.env.HOME };
  process.env.PONTE_HOME = who.env.PONTE_HOME;
  process.env.HOME = who.env.HOME;
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export async function waitFor(check, { timeout = 15_000, every = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, every));
  }
}
