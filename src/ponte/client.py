"""Talking to a relay: join, send (encrypted), fetch (decrypted), presence."""

from __future__ import annotations

import time

import httpx

from . import crypto, store
from .safety import MAX_MESSAGE_BYTES, sanitize

# Ciphertext is base64 of nonce + body + tag, so the plaintext budget is smaller
# than the relay's per-message cap.
MAX_TEXT_BYTES = (MAX_MESSAGE_BYTES - len(crypto.PREFIX)) * 3 // 4 - 24 - 16 - 8


class RelayError(RuntimeError):
    pass


class RoomClient:
    def __init__(self, alias: str, cfg: dict | None = None, ident: dict | None = None):
        self.alias = alias
        self.cfg = cfg or store.room(alias)
        self.ident = ident or store.me()
        secret = crypto.b64d(self.cfg["secret"])
        self.url = self.cfg["url"].rstrip("/")
        self.room = crypto.room_name(secret)
        self.token = crypto.relay_token(secret)
        self.key = crypto.message_key(secret)
        self.session: str | None = None
        self.http = httpx.Client(timeout=15)

    # -- transport --
    def _join(self) -> int:
        r = self.http.post(f"{self.url}/v1/join", headers={"Authorization": f"Bearer {self.token}"},
                           json={"room": self.room, "display_name": self.ident["name"],
                                 "identity_key": self.ident["identity_key"]})
        if r.status_code != 200:
            raise RelayError(f"join failed ({r.status_code}): {_detail(r)}")
        d = r.json()
        self.session = str(d["session_id"])
        return int(d.get("cursor") or 0)

    def _call(self, method: str, path: str, **kw) -> dict:
        if not self.session:
            self._join()
        for attempt in (0, 1):
            r = self.http.request(method, self.url + path, headers={
                "Authorization": f"Bearer {self.token}", "X-Ponte-Room": self.room,
                "X-Ponte-Session": self.session or ""}, **kw)
            if r.status_code == 401 and attempt == 0:
                self._join()  # session expired or relay restarted
                continue
            if r.status_code != 200:
                raise RelayError(f"{path} failed ({r.status_code}): {_detail(r)}")
            return r.json()
        raise RelayError(f"{path} failed")

    # -- API --
    def send(self, text: str, to: str | None = None) -> int:
        if len(text.encode("utf-8", "surrogatepass")) > MAX_TEXT_BYTES:
            raise ValueError(f"message too long (max {MAX_TEXT_BYTES} bytes): split it, or share a file path")
        body = crypto.seal(self.key, self.room, self.ident["name"], text)
        d = self._call("POST", "/v1/send", json={"text": body, "to": to})
        store.log(self.alias, self.ident["name"] + (f" → {to}" if to else ""), text)
        return int(d.get("id", 0))

    def peers(self) -> list[str]:
        d = self._call("GET", "/v1/peers")
        return [p["display_name"] for p in d.get("peers", [])]

    def fetch(self) -> list[dict]:
        """New messages from others, decrypted and sanitized. Advances the stored cursor."""
        with store.locked():
            cursors = store.cursors()
            since = int(cursors.get(self.alias, 0))
            if not self.session:
                since = max(since, self._join())
            out: list[dict] = []
            while True:
                d = self._call("GET", "/v1/poll", params={"since": since, "limit": 100})
                for m in d.get("messages", []):
                    since = max(since, int(m["id"]))
                    if m["from"] == self.ident["name"]:
                        continue
                    out.append(self._open(m))
                if not d.get("more"):
                    break
            cursors[self.alias] = since
            store.save_cursors(cursors)
        return out

    def _open(self, m: dict) -> dict:
        flags = [f for f in m.get("flags", []) if f]
        try:
            text = crypto.open_sealed(self.key, self.room, m["from"], m["text"])
            text, extra = sanitize(text)
            flags += extra
        except crypto.DecryptError:
            text = "[ponte: this message could not be decrypted or verified; it was not shown]"
            flags.append("decryption-failed")
        return {"room": self.alias, "id": m["id"], "from": m["from"], "to": m.get("to"),
                "text": text, "flags": sorted(set(flags)), "at": m.get("at") or time.time()}


def _detail(r: httpx.Response) -> str:
    try:
        d = r.json().get("detail")
        return str(d)[:200]
    except ValueError:
        return r.text[:200]


_clients: dict[str, RoomClient] = {}


def client_for(alias: str) -> RoomClient:
    """Long-lived clients, so a polling loop does not re-join the room every time."""
    cfg = store.room(alias)
    c = _clients.get(alias)
    if c is None or c.cfg != cfg:
        c = _clients[alias] = RoomClient(alias, cfg)
    return c


def fetch_all(notify=None) -> list[dict]:
    """Fetch every room into the inbox and logs. Used by the daemon and as a fallback."""
    got: list[dict] = []
    for alias in store.rooms():
        try:
            msgs = client_for(alias).fetch()
        except Exception:  # one unreachable relay must not block the others
            _clients.pop(alias, None)
            continue
        for m in msgs:
            store.log(alias, m["from"], m["text"], m["at"])
        if msgs:
            with store.locked("inbox"):
                store.inbox_append(msgs)
            if notify:
                for m in msgs:
                    notify(m)
        got += msgs
    return got
