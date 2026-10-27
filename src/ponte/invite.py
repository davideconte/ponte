"""Invites: one copy-pasteable string holding the relay URL and the room secret.

Anyone holding an invite can read and write the room, so it travels privately
(a DM, a password manager), never in a shared file or a repository.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from .crypto import SECRET_BYTES, b64d, b64e

PREFIX = "ponte1_"


@dataclass(frozen=True)
class Invite:
    url: str
    secret: bytes
    host_name: str = ""

    def encode(self) -> str:
        blob = {"u": self.url, "s": b64e(self.secret)}
        if self.host_name:
            blob["h"] = self.host_name
        return PREFIX + b64e(json.dumps(blob, separators=(",", ":")).encode())


def decode(text: str) -> Invite:
    text = text.strip()
    if not text.startswith(PREFIX):
        raise ValueError("not a Ponte invite (it should start with 'ponte1_')")
    try:
        data = json.loads(b64d(text[len(PREFIX):]))
        url, secret = data["u"], b64d(data["s"])
    except (ValueError, KeyError, TypeError):
        raise ValueError("this invite is damaged - copy the whole line again") from None
    if not isinstance(url, str) or not url.startswith(("http://", "https://")):
        raise ValueError("invite has an invalid relay URL")
    if len(secret) != SECRET_BYTES:
        raise ValueError("invite has an invalid secret")
    host = data.get("h", "")
    return Invite(url.rstrip("/"), secret, host if isinstance(host, str) else "")
