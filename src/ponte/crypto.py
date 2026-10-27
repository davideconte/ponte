"""Everything a room needs is derived from one 32-byte secret carried by the invite.

    room name   = "r-" + hex(HMAC(secret, "ponte/v1/room"))[:20]
    relay token = HMAC(secret, "ponte/v1/auth")   (proves membership to the relay)
    message key = HMAC(secret, "ponte/v1/enc")    (never leaves the clients)

The relay sees the room name and a hash of the token, never the message key, so it
stores and forwards ciphertext only. Bodies are sealed with XChaCha20-Poly1305 and
the sender's display name is bound in as associated data: a relay that relabels a
message as coming from someone else makes it fail to open.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

from nacl.bindings import (
    crypto_aead_xchacha20poly1305_ietf_decrypt,
    crypto_aead_xchacha20poly1305_ietf_encrypt,
    crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
)
from nacl.exceptions import CryptoError

PREFIX = "ponte1."
SECRET_BYTES = 32


class DecryptError(ValueError):
    pass


def new_secret() -> bytes:
    return secrets.token_bytes(SECRET_BYTES)


def b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _derive(secret: bytes, label: str) -> bytes:
    return hmac.new(secret, f"ponte/v1/{label}".encode(), hashlib.sha256).digest()


def room_name(secret: bytes) -> str:
    return "r-" + _derive(secret, "room").hex()[:20]


def relay_token(secret: bytes) -> str:
    return b64e(_derive(secret, "auth"))


def message_key(secret: bytes) -> bytes:
    return _derive(secret, "enc")


def _aad(room: str, sender: str) -> bytes:
    return f"{room}\n{sender}".encode()


def seal(key: bytes, room: str, sender: str, text: str) -> str:
    nonce = secrets.token_bytes(crypto_aead_xchacha20poly1305_ietf_NPUBBYTES)
    box = crypto_aead_xchacha20poly1305_ietf_encrypt(text.encode("utf-8", "surrogatepass"),
                                                     _aad(room, sender), nonce, key)
    return PREFIX + b64e(nonce + box)


def open_sealed(key: bytes, room: str, sender: str, body: str) -> str:
    if not body.startswith(PREFIX):
        raise DecryptError("message is not encrypted")
    try:
        raw = b64d(body[len(PREFIX):])
        n = crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
        plain = crypto_aead_xchacha20poly1305_ietf_decrypt(raw[n:], _aad(room, sender), raw[:n], key)
    except (CryptoError, ValueError) as exc:
        raise DecryptError("message failed authentication") from exc
    return plain.decode("utf-8", "replace")
