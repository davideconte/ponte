/** Hooking Ponte into Claude Code and into the login session (launchd / systemd). */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchAll } from "./client.js";
import * as store from "./store.js";
import { which } from "./util.js";
import { wrapMany } from "./wrap.js";

export const LABEL = "dev.ponte.daemon";
const HOOK_MARKS = ["ponte hook prompt", "ponte-mcp hook prompt"];

export function cliPath(): string {
  const p = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** How a shell (the Claude Code hook) should start Ponte. */
export function ponteCommand(): string {
  const installed = which("ponte");
  if (installed) return installed;
  const cli = cliPath();
  if (cli.includes("/_npx/")) return "npx -y ponte-mcp";
  return `${process.execPath} ${cli}`;
}

/**
 * How a login service should start the daemon: absolute paths only, because
 * launchd and systemd start services with a minimal PATH that rarely contains
 * node.
 */
export function daemonArgv(): string[] {
  return [process.execPath, cliPath(), "daemon"];
}

// ---- Claude Code hook -----------------------------------------------------

/** UserPromptSubmit hook: show the agent what arrived since the last prompt. */
export async function hookPrompt(): Promise<void> {
  let msgs;
  try {
    if (!store.daemonAlive()) await fetchAll();
    msgs = await store.locked("inbox", () => store.inboxTake());
  } catch {
    return;
  }
  if (msgs.length) {
    process.stdout.write(
      "New messages arrived through Ponte while you were working:\n\n" + wrapMany(msgs)
        + "\n\nReply with the ponte_send tool or `ponte send <room> \"...\"` if your user wants to.\n",
    );
  }
}

function settingsPath(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");
}

type HookEntry = { hooks?: { type?: string; command?: string; timeout?: number }[] };

function isPonteHook(e: HookEntry): boolean {
  return (e.hooks ?? []).some((h) => HOOK_MARKS.some((mark) => String(h.command ?? "").includes(mark)));
}

export function hookInstall(): string {
  const path = settingsPath();
  const data = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  data.hooks ??= {};
  data.hooks.UserPromptSubmit ??= [];
  const entries: HookEntry[] = data.hooks.UserPromptSubmit;
  if (entries.some(isPonteHook)) return `Hook already installed in ${path}`;
  if (existsSync(path)) copyFileSync(path, path.replace(/\.json$/, "") + ".json.ponte-backup");
  entries.push({
    hooks: [{ type: "command", command: `${ponteCommand()} hook prompt 2>/dev/null || true`, timeout: 8 }],
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return `Hook installed in ${path} (backup next to it).`;
}

export function hookUninstall(): string {
  const path = settingsPath();
  if (!existsSync(path)) return "Nothing to remove.";
  const data = JSON.parse(readFileSync(path, "utf8"));
  const entries: HookEntry[] = data.hooks?.UserPromptSubmit ?? [];
  const keep = entries.filter((e) => !isPonteHook(e));
  if (keep.length === entries.length) return "Hook not found.";
  if (keep.length) data.hooks.UserPromptSubmit = keep;
  else delete data.hooks.UserPromptSubmit;
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return "Hook removed.";
}

// ---- login service --------------------------------------------------------

function plistPath(): string {
  return join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`);
}

function unitPath(): string {
  return join(homedir(), ".config/systemd/user/ponte.service");
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function plistContent(argv: string[], logDir: string, ponteHome: string): string {
  const args = argv.map((a) => `<string>${xml(a)}</string>`).join("");
  const env = ponteHome
    ? `<key>EnvironmentVariables</key><dict><key>PONTE_HOME</key><string>${xml(ponteHome)}</string></dict>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Label</key><string>${LABEL}</string>
 <key>ProgramArguments</key><array>${args}</array>${env}
 <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
 <key>StandardOutPath</key><string>${xml(logDir)}/daemon.log</string>
 <key>StandardErrorPath</key><string>${xml(logDir)}/daemon.log</string>
</dict></plist>
`;
}

export function unitContent(argv: string[], ponteHome: string): string {
  const envLine = ponteHome ? `Environment=PONTE_HOME=${ponteHome}\n` : "";
  return `[Unit]\nDescription=Ponte daemon\n\n[Service]\nExecStart=${argv.join(" ")}\n${envLine}`
    + "Restart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n";
}

function run(cmd: string, args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status, stderr: (r.stderr ?? "").trim() };
}

export function serviceInstall(): string {
  const argv = daemonArgv();
  const logs = join(store.home(), "logs");
  const ponteHome = process.env.PONTE_HOME ?? "";
  if (platform() === "darwin") {
    mkdirSync(dirname(plistPath()), { recursive: true });
    writeFileSync(plistPath(), plistContent(argv, logs, ponteHome));
    const uid = process.getuid?.() ?? 0;
    run("launchctl", ["bootout", `gui/${uid}/${LABEL}`]);
    const r = run("launchctl", ["bootstrap", `gui/${uid}`, plistPath()]);
    return r.status === 0 ? "Service installed (launchd)." : `launchctl failed: ${r.stderr}`;
  }
  if (which("systemctl")) {
    mkdirSync(dirname(unitPath()), { recursive: true });
    writeFileSync(unitPath(), unitContent(argv, ponteHome));
    run("systemctl", ["--user", "daemon-reload"]);
    const r = run("systemctl", ["--user", "enable", "--now", "ponte"]);
    return r.status === 0 ? "Service installed (systemd --user)." : `systemctl failed: ${r.stderr}`;
  }
  return "No launchd or systemd here: run `ponte daemon` yourself (e.g. in tmux).";
}

export function serviceRestart(): void {
  if (platform() === "darwin" && existsSync(plistPath())) {
    run("launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 0}/${LABEL}`]);
  } else if (existsSync(unitPath())) {
    run("systemctl", ["--user", "restart", "ponte"]);
  }
}

export function serviceUninstall(): string {
  if (platform() === "darwin" && existsSync(plistPath())) {
    run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${LABEL}`]);
    unlinkSync(plistPath());
    return "Service removed.";
  }
  if (existsSync(unitPath())) {
    run("systemctl", ["--user", "disable", "--now", "ponte"]);
    unlinkSync(unitPath());
    return "Service removed.";
  }
  return "No service installed.";
}
