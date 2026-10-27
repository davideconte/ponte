/**
 * A cross-process lock made of a file created with O_EXCL.
 *
 * The file holds the owner's pid. A lock whose owner is gone, or that has been
 * held for longer than STALE_MS, is taken over, so a crashed process cannot
 * wedge everyone else.
 */

import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { sleep } from "./util.js";

const STALE_MS = 120_000;
const held = new Set<string>();

process.on("exit", () => {
  for (const path of held) {
    try {
      unlinkSync(path);
    } catch {
      // already gone
    }
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function tryAcquire(path: string): boolean {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, `${process.pid} ${Date.now()}\n`);
    } finally {
      closeSync(fd);
    }
    held.add(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  // Someone holds it. Take it over only if they are clearly gone.
  try {
    const content = readFileSync(path, "utf8");
    const pid = Number.parseInt(content, 10);
    const age = Date.now() - statSync(path).mtimeMs;
    const ownerGone = Number.isInteger(pid) && pid > 0 && pid !== process.pid && !alive(pid);
    if (ownerGone || age > STALE_MS) {
      if (readFileSync(path, "utf8") === content) unlinkSync(path);
    }
  } catch {
    // released between our checks; just retry
  }
  return false;
}

export async function withFileLock<T>(path: string, fn: () => Promise<T> | T): Promise<T> {
  let wait = 10;
  while (!tryAcquire(path)) {
    await sleep(wait);
    wait = Math.min(wait * 2, 100);
  }
  try {
    return await fn();
  } finally {
    held.delete(path);
    try {
      unlinkSync(path);
    } catch {
      // taken over as stale; nothing to release
    }
  }
}
