"""Write test/fixtures/vectors.json from the Python implementation of Ponte 0.1.

Run with the interpreter of a venv where that version is installed (see
scripts/cross-compat.sh):  python scripts/py/make_vectors.py > test/fixtures/vectors.json
"""

import json

from nacl.bindings import crypto_aead_xchacha20poly1305_ietf_encrypt

from ponte import crypto
from ponte.invite import Invite

SECRETS = [bytes(range(32)), b"\xff" * 32, bytes.fromhex("5f" * 16 + "a0" * 16)]
TEXTS = ["hello", "ciao ✓ café \U0001f30a", "", "line one\nline two\t<tag>"]


def fixed_seal(key, room, sender, text, nonce):
    box = crypto_aead_xchacha20poly1305_ietf_encrypt(text.encode(), f"{room}\n{sender}".encode(), nonce, key)
    return crypto.PREFIX + crypto.b64e(nonce + box)


rooms = []
for i, secret in enumerate(SECRETS):
    room = crypto.room_name(secret)
    key = crypto.message_key(secret)
    nonce = bytes([i + 1]) * 24
    rooms.append({
        "secret_b64": crypto.b64e(secret),
        "room": room,
        "token": crypto.relay_token(secret),
        "key_hex": key.hex(),
        "sealed_fixed_nonce": [
            {"sender": "alice", "text": t, "nonce_hex": nonce.hex(), "body": fixed_seal(key, room, "alice", t, nonce)}
            for t in TEXTS
        ],
        "sealed_random_nonce": [
            {"sender": "bob", "text": t, "body": crypto.seal(key, room, "bob", t)} for t in TEXTS
        ],
    })

invites = [
    {"url": "http://host.local:8787", "secret_b64": crypto.b64e(SECRETS[0]), "host": "davide",
     "invite": Invite("http://host.local:8787", SECRETS[0], "davide").encode()},
    {"url": "https://relay.example.com", "secret_b64": crypto.b64e(SECRETS[1]), "host": "",
     "invite": Invite("https://relay.example.com", SECRETS[1]).encode()},
    {"url": "https://exämple.org/p", "secret_b64": crypto.b64e(SECRETS[2]), "host": "Carlo B",
     "invite": Invite("https://exämple.org/p", SECRETS[2], "Carlo B").encode()},
]

print(json.dumps({"generated_by": "ponte 0.1.0 (Python)", "rooms": rooms, "invites": invites}, indent=1))
