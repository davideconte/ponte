"""Installing Ponte into the places where it runs: Claude Code hooks and a login service."""

from __future__ import annotations

import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

from . import store
from .wrap import wrap_many

HOOK_MARK = "ponte hook prompt"
LABEL = "dev.ponte.daemon"


def ponte_command() -> str:
    exe = shutil.which("ponte")
    return exe or f"{sys.executable} -m ponte"


# ---- Claude Code hook -----------------------------------------------------

def hook_prompt() -> None:
    """UserPromptSubmit hook: put messages that arrived since the last prompt in front of the agent."""
    try:
        if not store.daemon_alive():
            from . import client
            client.fetch_all()
        with store.locked("inbox"):
            msgs = store.inbox_take()
    except Exception:
        return
    if msgs:
        print("New messages arrived through Ponte while you were working:\n\n" + wrap_many(msgs)
              + "\n\nReply with the ponte_send tool or `ponte send <room> \"...\"` if your user wants to.")


def _settings_path() -> Path:
    return Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")) / "settings.json"


def hook_install() -> str:
    path = _settings_path()
    data = json.loads(path.read_text()) if path.exists() else {}
    entries = data.setdefault("hooks", {}).setdefault("UserPromptSubmit", [])
    if any(HOOK_MARK in h.get("command", "") for e in entries for h in e.get("hooks", [])):
        return f"Hook already installed in {path}"
    if path.exists():
        shutil.copy2(path, path.with_suffix(".json.ponte-backup"))
    entries.append({"hooks": [{"type": "command", "command": f"{ponte_command()} hook prompt 2>/dev/null || true",
                               "timeout": 8}]})
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return f"Hook installed in {path} (backup next to it)."


def hook_uninstall() -> str:
    path = _settings_path()
    if not path.exists():
        return "Nothing to remove."
    data = json.loads(path.read_text())
    entries = data.get("hooks", {}).get("UserPromptSubmit", [])
    keep = [e for e in entries if not any(HOOK_MARK in h.get("command", "") for h in e.get("hooks", []))]
    if len(keep) == len(entries):
        return "Hook not found."
    data["hooks"]["UserPromptSubmit"] = keep
    if not keep:
        del data["hooks"]["UserPromptSubmit"]
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return "Hook removed."


# ---- login service --------------------------------------------------------

def _plist() -> Path:
    return Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"


def _unit() -> Path:
    return Path.home() / ".config/systemd/user/ponte.service"


def service_install() -> str:
    cmd = ponte_command().split() + ["daemon"]
    logs = store.home() / "logs"
    env = os.environ.get("PONTE_HOME", "")
    if platform.system() == "Darwin":
        args = "".join(f"<string>{c}</string>" for c in cmd)
        envxml = f"<key>EnvironmentVariables</key><dict><key>PONTE_HOME</key><string>{env}</string></dict>" if env else ""
        _plist().write_text(f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Label</key><string>{LABEL}</string>
 <key>ProgramArguments</key><array>{args}</array>{envxml}
 <key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
 <key>StandardOutPath</key><string>{logs}/daemon.log</string>
 <key>StandardErrorPath</key><string>{logs}/daemon.log</string>
</dict></plist>
""")
        uid = os.getuid()
        subprocess.run(["launchctl", "bootout", f"gui/{uid}/{LABEL}"], capture_output=True)
        r = subprocess.run(["launchctl", "bootstrap", f"gui/{uid}", str(_plist())], capture_output=True, text=True)
        return "Service installed (launchd)." if r.returncode == 0 else f"launchctl failed: {r.stderr.strip()}"
    if shutil.which("systemctl"):
        _unit().parent.mkdir(parents=True, exist_ok=True)
        envline = f"Environment=PONTE_HOME={env}\n" if env else ""
        _unit().write_text(f"[Unit]\nDescription=Ponte daemon\n\n[Service]\nExecStart={' '.join(cmd)}\n{envline}"
                           "Restart=always\nRestartSec=10\n\n[Install]\nWantedBy=default.target\n")
        subprocess.run(["systemctl", "--user", "daemon-reload"])
        r = subprocess.run(["systemctl", "--user", "enable", "--now", "ponte"], capture_output=True, text=True)
        return "Service installed (systemd --user)." if r.returncode == 0 else f"systemctl failed: {r.stderr.strip()}"
    return "No launchd or systemd here: run `ponte daemon` yourself (e.g. in tmux)."


def service_restart() -> None:
    if platform.system() == "Darwin" and _plist().exists():
        subprocess.run(["launchctl", "kickstart", "-k", f"gui/{os.getuid()}/{LABEL}"], capture_output=True)
    elif _unit().exists():
        subprocess.run(["systemctl", "--user", "restart", "ponte"], capture_output=True)


def service_uninstall() -> str:
    if platform.system() == "Darwin" and _plist().exists():
        subprocess.run(["launchctl", "bootout", f"gui/{os.getuid()}/{LABEL}"], capture_output=True)
        _plist().unlink()
        return "Service removed."
    if _unit().exists():
        subprocess.run(["systemctl", "--user", "disable", "--now", "ponte"], capture_output=True)
        _unit().unlink()
        return "Service removed."
    return "No service installed."
