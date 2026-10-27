"""Small entry points into the Python implementation of Ponte 0.1, for the cross-compatibility tests.

    helper.py seal KEY_HEX ROOM SENDER TEXT      -> sealed body
    helper.py open KEY_HEX ROOM SENDER BODY      -> {"text": ...} or {"error": ...}
    helper.py derive SECRET_B64                  -> {"room", "token", "key_hex"}
    helper.py invite-encode URL SECRET_B64 HOST  -> invite
    helper.py invite-decode INVITE               -> {"url", "secret_b64", "host"} or {"error": ...}
"""

import json
import sys

from ponte import crypto
from ponte.invite import Invite, decode


def main(argv):
    cmd, args = argv[0], argv[1:]
    if cmd == "seal":
        key, room, sender, text = args
        print(crypto.seal(bytes.fromhex(key), room, sender, text))
    elif cmd == "open":
        key, room, sender, body = args
        try:
            print(json.dumps({"text": crypto.open_sealed(bytes.fromhex(key), room, sender, body)}))
        except crypto.DecryptError as exc:
            print(json.dumps({"error": str(exc)}))
    elif cmd == "derive":
        secret = crypto.b64d(args[0])
        print(json.dumps({"room": crypto.room_name(secret), "token": crypto.relay_token(secret),
                          "key_hex": crypto.message_key(secret).hex()}))
    elif cmd == "invite-encode":
        url, secret, host = args
        print(Invite(url, crypto.b64d(secret), host).encode())
    elif cmd == "invite-decode":
        try:
            inv = decode(args[0])
            print(json.dumps({"url": inv.url, "secret_b64": crypto.b64e(inv.secret), "host": inv.host_name}))
        except ValueError as exc:
            print(json.dumps({"error": str(exc)}))
    else:
        raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    main(sys.argv[1:])
