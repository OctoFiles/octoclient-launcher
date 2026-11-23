"""Der Testfreund: ein zweiter "Spieler" für den Freundes-Server.

Damit lässt sich das Freundes-System allein testen — ohne zweiten Minecraft-Account
und ohne zweiten PC. Das Skript registriert einen Namen, schickt eine Anfrage,
nimmt Anfragen an und antwortet im Chat.

    py testfriend.py --name LunarFrost --friend DoctoCapybara
    py testfriend.py --name LunarFrost --friend DoctoCapybara --say "hi!"
    py testfriend.py --name LunarFrost --once          # Posteingang lesen
    py testfriend.py --name LunarFrost --watch          # live mitlesen + antworten

Die Identität (UUID + Secret) liegt in ``testfriend.json``; ein zweiter Bot braucht
einfach ``--identity bot2.json``.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid as uuidlib
from pathlib import Path

DEFAULT_SERVER = "https://octoclient.pythonanywhere.com"


def call(server: str, method: str, path: str, body: dict | None = None,
         auth: tuple[str, str] | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(server + path, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    if auth:
        request.add_header("X-Octo-Player", auth[0])
        request.add_header("X-Octo-Secret", auth[1])
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.loads(response.read().decode() or "{}")
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            return error.code, json.loads(raw or "{}")
        except ValueError:
            return error.code, {"error": raw[:120]}
    except Exception as error:  # noqa: BLE001
        return -1, {"error": f"Server nicht erreichbar: {error}"}


def load_identity(path: Path) -> dict | None:
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None


def save_identity(path: Path, identity: dict) -> None:
    path.write_text(json.dumps(identity, indent=2), encoding="utf-8")


def register(server: str, path: Path, name: str) -> dict:
    identity = load_identity(path)
    if identity and identity.get("server") != server:
        identity = None
    if identity is None:
        identity = {"uuid": str(uuidlib.uuid4()), "name": name, "server": server, "secret": ""}
    body = {"uuid": identity["uuid"], "name": name or identity["name"]}
    auth = (identity["uuid"], identity["secret"]) if identity.get("secret") else None
    status, payload = call(server, "POST", "/v1/friends/register", body, auth)
    if status != 200 or not payload.get("secret"):
        raise SystemExit(f"Registrierung fehlgeschlagen ({status}): {payload.get('error', payload)}")
    identity.update({"uuid": payload.get("uuid", identity["uuid"]), "name": payload["name"],
                     "secret": payload["secret"], "server": server})
    save_identity(path, identity)
    print(f"[bot] registriert als {identity['name']} ({identity['uuid']})")
    return identity


def auth_of(identity: dict) -> tuple[str, str]:
    return identity["uuid"], identity["secret"]


def overview(server: str, identity: dict) -> dict:
    status, payload = call(server, "GET", "/v1/friends", auth=auth_of(identity))
    if status != 200:
        raise SystemExit(f"Übersicht fehlgeschlagen ({status}): {payload.get('error', payload)}")
    return payload


def lookup(server: str, name: str) -> dict | None:
    status, payload = call(server, "GET", "/v1/friends/lookup?name=" + urllib.parse.quote(name))
    if status != 200:
        return None
    return payload.get("player")


def accept_incoming(server: str, identity: dict) -> int:
    accepted = 0
    for entry in overview(server, identity).get("incoming", []):
        status, _ = call(server, "POST", "/v1/friends/accept", {"uuid": entry["uuid"]}, auth_of(identity))
        if status == 200:
            accepted += 1
            print(f"[bot] Anfrage von {entry['name']} angenommen")
    return accepted


def friend_uuid(server: str, identity: dict, name: str) -> str | None:
    for entry in overview(server, identity).get("friends", []):
        if entry["name"].lower() == name.lower():
            return entry["uuid"]
    player = lookup(server, name)
    return player["uuid"] if player else None


def send(server: str, identity: dict, target: str, text: str) -> None:
    status, payload = call(server, "POST", "/v1/friends/messages", {"to": target, "body": text},
                           auth_of(identity))
    if status == 200:
        print(f"[bot] -> {text}")
    else:
        print(f"[bot] Nachricht nicht gesendet ({status}): {payload.get('error', payload)}")


def read_inbox(server: str, identity: dict, since: int) -> int:
    status, payload = call(server, "GET", f"/v1/friends/inbox?since={since}", auth=auth_of(identity))
    if status != 200:
        return since
    for message in payload.get("messages", []):
        print(f"[bot] <- {message.get('fromName', '?')}: {message['body']}")
        since = max(since, int(message["id"]))
    return since


def main() -> int:
    parser = argparse.ArgumentParser(description="Testfreund für den OctoClient-Freundes-Server")
    parser.add_argument("--name", default="LunarFrost", help="Name des Bots (2-16 Zeichen)")
    parser.add_argument("--friend", help="Anfrage an diesen Namen senden")
    parser.add_argument("--accept", action="store_true", help="Alle offenen Anfragen annehmen")
    parser.add_argument("--say", help="Nachricht an --friend senden")
    parser.add_argument("--once", action="store_true", help="Posteingang einmal lesen")
    parser.add_argument("--watch", action="store_true", help="Posteingang dauerhaft mitlesen")
    parser.add_argument("--reply", default="", help="Automatische Antwort im --watch-Modus")
    parser.add_argument("--state", default="online", choices=["online", "ingame", "offline"])
    parser.add_argument("--detail", default="", help="Detailtext im Spiel-Status")
    parser.add_argument("--server", default=DEFAULT_SERVER)
    parser.add_argument("--identity", default="testfriend.json")
    args = parser.parse_args()

    server = args.server.rstrip("/")
    identity = register(server, Path(args.identity), args.name)
    call(server, "POST", "/v1/friends/presence",
         {"state": args.state, "detail": args.detail or None}, auth_of(identity))

    if args.accept:
        accept_incoming(server, identity)

    target = None
    if args.friend:
        status, payload = call(server, "POST", "/v1/friends/request", {"name": args.friend},
                               auth_of(identity))
        if status == 200:
            print(f"[bot] Anfrage an {args.friend} gesendet")
        else:
            print(f"[bot] Anfrage: {payload.get('error', status)}")
        target = friend_uuid(server, identity, args.friend)

    if args.say and target:
        if not args.friend:
            print("[bot] --say braucht --friend")
        else:
            send(server, identity, target, args.say)

    since = 0
    if args.once:
        since = read_inbox(server, identity, 0)
        return 0

    if args.watch:
        print("[bot] lese mit (Strg+C beendet)")
        try:
            while True:
                status, payload = call(server, "GET", "/v1/friends/inbox?since=0", auth=auth_of(identity))
                if status == 200:
                    for message in payload.get("messages", []):
                        if int(message["id"]) > since:
                            print(f"[bot] <- {message.get('fromName', '?')}: {message['body']}")
                            since = int(message["id"])
                            if args.reply:
                                send(server, identity, message["from"], args.reply)
                accept_incoming(server, identity)
                time.sleep(3)
        except KeyboardInterrupt:
            print("\n[bot] beendet")
        return 0

    return 0


if __name__ == "__main__":
    sys.exit(main())
