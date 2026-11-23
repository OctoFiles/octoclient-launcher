#!/usr/bin/env python3
"""OctoClient cosmetics API.

A tiny, dependency-free service that lets OctoClient users see each other's
cosmetics on any Minecraft server (no server mod required).

    player A --POST /v1/loadouts--> this service <--GET /v1/loadouts-- player B

Endpoints
    GET  /health                          -> {"ok": true, "entries": N}
    POST /v1/loadouts                     -> store a loadout
         body: {"uuid": "...", "name": "...", "loadout": "a|b|1|0|..."}
    GET  /v1/loadouts?uuid=<u>&uuid=<u>   -> {"loadouts": {"<uuid>": "<loadout>"}}
    DELETE /v1/loadouts/<uuid>            -> remove one entry

Run:
    python octoclient_api.py                      # 0.0.0.0:8765, no token
    python octoclient_api.py --port 9000 --token secret
    python octoclient_api.py --local              # only 127.0.0.1

Then point the client at it in config/octoclient_api.json.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import threading
import time
import uuid as uuidlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import octoclient_friends as friends


MAX_LOADOUT = 1024
MAX_NAME = 32
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                     r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
# Keep accepting optional fields added by newer clients, including nametag
# settings, while preserving the original nine-field minimum.
LOADOUT_RE = re.compile(r"^[^|\r\n]{0,120}(\|[^|\r\n]{0,120}){8,31}$")

DB_LOCK = threading.Lock()
ARGS = argparse.Namespace()
START = time.time()


class RateLimiter:
    """Cheap per-IP limit: a handful of requests per second is plenty."""

    def __init__(self, per_second: float = 20.0, burst: int = 60) -> None:
        self.per_second = per_second
        self.burst = burst
        self.state: dict[str, tuple[float, float]] = {}
        self.lock = threading.Lock()

    def allow(self, key: str) -> bool:
        now = time.monotonic()
        with self.lock:
            tokens, last = self.state.get(key, (self.burst, now))
            tokens = min(self.burst, tokens + (now - last) * self.per_second)
            if tokens < 1.0:
                self.state[key] = (tokens, now)
                return False
            self.state[key] = (tokens - 1.0, now)
            return True


LIMITER = RateLimiter()


# --------------------------------------------------------------------- store

def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(ARGS.db, timeout=10.0)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA synchronous=NORMAL")
    return connection


def init_db() -> None:
    with DB_LOCK, connect() as connection:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS loadouts (
                   uuid     TEXT PRIMARY KEY,
                   name     TEXT NOT NULL,
                   loadout  TEXT NOT NULL,
                   updated  REAL NOT NULL
               )"""
        )


def store(entry_uuid: str, name: str, loadout: str) -> None:
    with DB_LOCK, connect() as connection:
        connection.execute(
            "INSERT INTO loadouts (uuid, name, loadout, updated) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(uuid) DO UPDATE SET name=excluded.name, "
            "loadout=excluded.loadout, updated=excluded.updated",
            (entry_uuid, name, loadout, time.time()),
        )


def lookup(uuids: list[str]) -> dict[str, str]:
    if not uuids:
        return {}
    placeholders = ",".join("?" for _ in uuids)
    with DB_LOCK, connect() as connection:
        rows = connection.execute(
            f"SELECT uuid, loadout FROM loadouts WHERE uuid IN ({placeholders})",
            uuids,
        ).fetchall()
    return {row[0]: row[1] for row in rows}


def forget(entry_uuid: str) -> bool:
    with DB_LOCK, connect() as connection:
        cursor = connection.execute("DELETE FROM loadouts WHERE uuid = ?", (entry_uuid,))
        return cursor.rowcount > 0


def count() -> int:
    with DB_LOCK, connect() as connection:
        return connection.execute("SELECT COUNT(*) FROM loadouts").fetchone()[0]


def prune(days: int) -> None:
    cutoff = time.time() - days * 86400
    with DB_LOCK, connect() as connection:
        connection.execute("DELETE FROM loadouts WHERE updated < ?", (cutoff,))


# -------------------------------------------------------------------- server

class Handler(BaseHTTPRequestHandler):
    server_version = "OctoClientAPI/1.0"
    protocol_version = "HTTP/1.1"

    # -- helpers
    def send_json(self, status: int, payload: dict) -> None:
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def authorized(self) -> bool:
        if not ARGS.token:
            return True
        header = self.headers.get("Authorization", "")
        return header == f"Bearer {ARGS.token}"

    def header(self, name: str) -> str:
        return self.headers.get(name, "") or ""

    def gate(self) -> bool:
        """Rate limit + shared token check for the JSON routes."""
        if self.limited():
            return False
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return False
        return True

    def friend_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            return b""
        if length <= 0 or length > friends.MAX_BODY:
            return b""
        return self.rfile.read(length)

    def client_key(self) -> str:
        forwarded = self.headers.get("X-Forwarded-For")
        if forwarded:
            return forwarded.split(",")[0].strip()
        return self.client_address[0]

    def limited(self) -> bool:
        if LIMITER.allow(self.client_key()):
            return False
        self.send_json(429, {"error": "rate limited"})
        return True

    def log_message(self, fmt: str, *args) -> None:
        print(f"[{time.strftime('%H:%M:%S')}] {self.client_address[0]} {fmt % args}", flush=True)

    # -- routes
    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"ok": True, "entries": count(),
                                 "friends": friends.stats(),
                                 "uptime": round(time.time() - START, 1)})
            return
        if parsed.path.startswith("/v1/friends"):
            if not self.gate():
                return
            status, payload = friends.handle("GET", parsed.path, parse_qs(parsed.query),
                                             b"", self.header)
            self.send_json(status, payload)
            return
        if parsed.path != "/v1/loadouts":
            self.send_json(404, {"error": "not found"})
            return
        if self.limited():
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return

        wanted = [value.strip().lower() for value in parse_qs(parsed.query).get("uuid", [])]
        wanted = [value for value in wanted if UUID_RE.match(value)][:100]
        self.send_json(200, {"loadouts": lookup(wanted)})

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path.startswith("/v1/friends"):
            if not self.gate():
                return
            status, payload = friends.handle("POST", parsed.path, parse_qs(parsed.query),
                                             self.friend_body(), self.header)
            self.send_json(status, payload)
            return
        if parsed.path != "/v1/loadouts":
            self.send_json(404, {"error": "not found"})
            return
        if self.limited():
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > 4096:
            self.send_json(400, {"error": "bad body"})
            return

        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "invalid json"})
            return

        entry_uuid = str(body.get("uuid", "")).strip().lower()
        name = str(body.get("name", ""))[:MAX_NAME]
        loadout = str(body.get("loadout", ""))

        if not UUID_RE.match(entry_uuid):
            self.send_json(400, {"error": "invalid uuid"})
            return
        if len(loadout) > MAX_LOADOUT or not LOADOUT_RE.match(loadout):
            self.send_json(400, {"error": "invalid loadout"})
            return

        store(entry_uuid, name, loadout)
        self.send_json(200, {"ok": True})

    def do_DELETE(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        prefix = "/v1/loadouts/"
        if not parsed.path.startswith(prefix):
            self.send_json(404, {"error": "not found"})
            return
        if self.limited():
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        entry_uuid = parsed.path[len(prefix):].strip().lower()
        if not UUID_RE.match(entry_uuid):
            self.send_json(400, {"error": "invalid uuid"})
            return
        self.send_json(200, {"ok": forget(entry_uuid)})


class ApiServer(ThreadingHTTPServer):
    """Threaded server that stays quiet when a client drops the connection."""

    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address) -> None:
        error = sys.exc_info()[1]
        if isinstance(error, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def main() -> None:
    parser = argparse.ArgumentParser(description="OctoClient cosmetics API")
    parser.add_argument("--host", default="0.0.0.0", help="bind address (default 0.0.0.0)")
    parser.add_argument("--local", action="store_true", help="bind 127.0.0.1 only")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--db", default=os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                                     "loadouts.db"))
    parser.add_argument("--token", default=os.environ.get("OCTOCLIENT_API_TOKEN", ""),
                        help="optional shared secret; clients send it as a Bearer token")
    parser.add_argument("--prune-days", type=int, default=30,
                        help="drop loadouts untouched for this long (0 = never)")
    parser.add_argument("--chat-days", type=int, default=90,
                        help="drop chat messages older than this many days (0 = never)")
    args = parser.parse_args()

    global ARGS
    ARGS = args
    if args.local:
        args.host = "127.0.0.1"

    init_db()
    friends.configure(args.db)
    if args.prune_days > 0:
        prune(args.prune_days)
    if args.chat_days > 0:
        friends.prune(args.chat_days)

    server = ApiServer((args.host, args.port), Handler)
    print(f"OctoClient cosmetics API on http://{args.host}:{args.port}"
          f"  (db: {args.db}, token: {'yes' if args.token else 'no'})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped", flush=True)
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
