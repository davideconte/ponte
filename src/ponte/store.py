"""Local state in ~/.ponte (or $PONTE_HOME): who I am, my rooms, inbox, cursors, logs.

Everything is private to the user (0700 directory, 0600 files): rooms.json holds
room secrets, and a secret is all it takes to read a room.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import secrets
import time
from pathlib import Path

from .safety import NAME_RE

ALIAS_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")


def home() -> Path:
    h = Path(os.environ.get("PONTE_HOME", Path.home() / ".ponte"))
    h.mkdir(mode=0o700, parents=True, exist_ok=True)
    (h / "logs").mkdir(mode=0o700, exist_ok=True)
    return h


def _read(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _write(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False))
    os.chmod(tmp, 0o600)
    tmp.replace(path)


@contextlib.contextmanager
def locked(name: str = "state"):
    """Serialize everything that touches cursors and the inbox across processes."""
    with open(home() / f".{name}.lock", "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


# ---- identity -------------------------------------------------------------

def config() -> dict:
    return _read(home() / "config.json", {})


def save_config(cfg: dict) -> None:
    _write(home() / "config.json", cfg)


def me(required: bool = True) -> dict:
    cfg = config()
    if required and not cfg.get("name"):
        raise SystemExit("Run `ponte init --name <your-name>` first.")
    return cfg


def init(name: str) -> dict:
    if not NAME_RE.match(name):
        raise SystemExit("name: up to 64 letters, digits, spaces, '_', '.' or '-'")
    cfg = config()
    cfg["name"] = name
    cfg.setdefault("identity_key", secrets.token_urlsafe(32))
    save_config(cfg)
    return cfg


# ---- rooms ----------------------------------------------------------------

def rooms() -> dict:
    return _read(home() / "rooms.json", {})


def save_rooms(r: dict) -> None:
    _write(home() / "rooms.json", r)


def room(alias: str) -> dict:
    r = rooms()
    if alias not in r:
        known = ", ".join(r) or "none"
        raise SystemExit(f"No room called {alias!r} (known: {known}).")
    return r[alias]


def check_alias(alias: str) -> str:
    if not ALIAS_RE.match(alias):
        raise SystemExit("room alias: lowercase letters, digits and '-' (e.g. acme-site)")
    return alias


# ---- cursors and inbox ----------------------------------------------------

def cursors() -> dict:
    return _read(home() / "cursors.json", {})


def save_cursors(c: dict) -> None:
    _write(home() / "cursors.json", c)


def inbox_append(messages: list[dict]) -> None:
    with open(home() / "inbox.jsonl", "a") as f:
        for m in messages:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")
    os.chmod(home() / "inbox.jsonl", 0o600)


def inbox_take(alias: str | None = None, peek: bool = False) -> list[dict]:
    path = home() / "inbox.jsonl"
    if not path.exists():
        return []
    rows = [json.loads(x) for x in path.read_text().splitlines() if x.strip()]
    taken = [m for m in rows if alias is None or m["room"] == alias]
    if not peek and taken:
        rest = [m for m in rows if m not in taken]
        path.write_text("".join(json.dumps(m, ensure_ascii=False) + "\n" for m in rest))
    return taken


def inbox_count() -> dict:
    counts: dict = {}
    for m in inbox_take(peek=True):
        counts[m["room"]] = counts.get(m["room"], 0) + 1
    return counts


def log(alias: str, sender: str, text: str, at: float | None = None) -> None:
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(at or time.time()))
    path = home() / "logs" / f"{alias}.md"
    with open(path, "a") as f:
        f.write(f"\n### {when} · {sender}\n\n{text.strip()}\n")
    os.chmod(path, 0o600)


def log_tail(alias: str, n: int = 20) -> str:
    path = home() / "logs" / f"{alias}.md"
    if not path.exists():
        return ""
    blocks = path.read_text().split("\n### ")
    return "\n### ".join(blocks[-n:]).strip()


# ---- daemon liveness ------------------------------------------------------

def daemon_alive() -> bool:
    try:
        pid = int((home() / "daemon.pid").read_text())
        os.kill(pid, 0)
        return True
    except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
        return False
