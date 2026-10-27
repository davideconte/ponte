"""The background service: hosts the relay (if you host rooms) and listens to every room.

It is the only process that polls, so messages land in the inbox, the logs and a
desktop notification within a few seconds, whether or not an agent is running.
"""

from __future__ import annotations

import os
import platform
import shutil
import subprocess
import sys
import threading
import time

from . import client, store

POLL_SECONDS = 5


def notify(m: dict) -> None:
    if os.environ.get("PONTE_NO_NOTIFY"):
        return
    title = f"Ponte · {m['room']} · {m['from']}"
    text = " ".join(m["text"].split())[:180]
    try:
        if platform.system() == "Darwin":
            q = lambda s: s.replace("\\", " ").replace('"', "'")
            subprocess.run(["osascript", "-e", f'display notification "{q(text)}" with title "{q(title)}"'],
                           capture_output=True, timeout=5)
        elif shutil.which("notify-send"):
            subprocess.run(["notify-send", title, text], capture_output=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        pass


def relay_db() -> str:
    return str(store.home() / "relay.db")


def start_relay(port: int, bind: str) -> threading.Thread:
    import uvicorn

    from .relay import create_app

    app = create_app(relay_db(), open_rooms=False)
    server = uvicorn.Server(uvicorn.Config(app, host=bind, port=port, log_level="warning"))
    t = threading.Thread(target=server.run, daemon=True, name="ponte-relay")
    t.start()
    for _ in range(100):
        if server.started:
            return t
        if not t.is_alive():
            break
        time.sleep(0.05)
    raise SystemExit(f"ponte: the relay could not start on {bind}:{port} (port in use?)")


def run() -> None:
    cfg = store.me()
    host = cfg.get("host")
    if host:
        start_relay(int(host.get("port", 8787)), host.get("bind", "0.0.0.0"))
        print(f"relay listening on {host.get('bind', '0.0.0.0')}:{host.get('port', 8787)}", flush=True)
    (store.home() / "daemon.pid").write_text(str(os.getpid()))
    print(f"ponte daemon listening to {len(store.rooms())} room(s)", flush=True)
    while True:
        try:
            client.fetch_all(notify=notify)
        except Exception as exc:  # keep the service up whatever happens in one round
            print(f"{time.strftime('%H:%M:%S')} {exc}", file=sys.stderr, flush=True)
        time.sleep(POLL_SECONDS)
