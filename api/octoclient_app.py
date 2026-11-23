#!/usr/bin/env python3
"""OctoClient cosmetics API as a dependency-free WSGI app.

Works on PythonAnywhere (and any WSGI host) without Flask or any other
package. Upload this file to /home/USERNAME/octoclient/pa_wsgi.py and point the
WSGI configuration file at it:

    import sys
    sys.path.insert(0, "/home/USERNAME/octoclient")
    from pa_wsgi import application

Endpoints (identical to octoclient_api.py):
    GET    /health
    GET    /v1/loadouts?uuid=<u>&uuid=<u>
    POST   /v1/loadouts          {"uuid": "...", "name": "...", "loadout": "..."}
    DELETE /v1/loadouts/<uuid>
Client config (config/octoclient_api.json):
    { "enabled": true, "url": "https://USERNAME.pythonanywhere.com",
      "token": "", "pollSeconds": 5 }

Optional shared secret: environment variable OCTOCLIENT_API_TOKEN.
Optional database path: environment variable OCTOCLIENT_API_DB.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
import threading
import time
from urllib.parse import parse_qs

import octoclient_friends as friends


MAX_LOADOUT = 512
MAX_NAME = 32
UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
                     r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
# Keep accepting optional fields added by newer clients, including nametag
# settings, while preserving the original nine-field minimum.
LOADOUT_RE = re.compile(r"^[^|\r\n]{0,120}(\|[^|\r\n]{0,120}){8,31}$")

TOKEN = os.environ.get("OCTOCLIENT_API_TOKEN", "").strip()
DB_PATH = os.environ.get(
    "OCTOCLIENT_API_DB",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "loadouts.db"),
)
START = time.time()
DB_LOCK = threading.Lock()
LIMIT_LOCK = threading.Lock()
LIMIT_STATE: dict[str, tuple[float, float]] = {}
LIMIT_PER_SECOND = 20.0
LIMIT_BURST = 60.0


# --------------------------------------------------------------------- store

def connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=10.0)
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


# ------------------------------------------------------------------- helpers

def rate_limited(key: str) -> bool:
    now = time.monotonic()
    with LIMIT_LOCK:
        tokens, last = LIMIT_STATE.get(key, (LIMIT_BURST, now))
        tokens = min(LIMIT_BURST, tokens + (now - last) * LIMIT_PER_SECOND)
        if tokens < 1.0:
            LIMIT_STATE[key] = (tokens, now)
            return True
        LIMIT_STATE[key] = (tokens - 1.0, now)
        return False


def read_body(environ) -> bytes:
    try:
        length = int(environ.get("CONTENT_LENGTH") or 0)
    except ValueError:
        length = 0
    # Chat attachments (GIFs as data URLs) need more than the old 4 KiB cap;
    # friends.MAX_BODY is the single place that decides the limit.
    if length <= 0 or length > friends.MAX_BODY:
        return b""
    stream = environ.get("wsgi.input")
    return stream.read(length) if stream is not None else b""


def respond(start_response, status: int, payload: dict):
    raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    start_response(
        f"{status} {'OK' if status == 200 else 'ERROR'}",
        [("Content-Type", "application/json"),
         ("Content-Length", str(len(raw))),
         ("Cache-Control", "no-store")],
    )
    return [raw]


def application(environ, start_response):
    method = (environ.get("REQUEST_METHOD") or "GET").upper()
    path = environ.get("PATH_INFO") or "/"
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")

    # health is always public
    if path == "/health" and method == "GET":
        try:
            entries = count()
        except Exception:  # never let the health check crash
            entries = -1
        try:
            chat = friends.stats()
        except Exception:
            chat = {}
        return respond(start_response, 200,
                       {"ok": True, "entries": entries, "friends": chat,
                        "uptime": round(time.time() - START, 1)})

    forwarded = environ.get("HTTP_X_FORWARDED_FOR", "")
    client = forwarded.split(",")[0].strip() if forwarded else environ.get("REMOTE_ADDR", "?")
    if rate_limited(client):
        return respond(start_response, 429, {"error": "rate limited"})

    if TOKEN:
        if environ.get("HTTP_AUTHORIZATION", "") != f"Bearer {TOKEN}":
            return respond(start_response, 401, {"error": "unauthorized"})

    if path.startswith("/v1/friends"):
        raw = read_body(environ) if method == "POST" else b""
        status, payload = friends.handle(
            method, path, parse_qs(environ.get("QUERY_STRING", "")), raw,
            lambda name: environ.get("HTTP_" + name.upper().replace("-", "_"), ""))
        return respond(start_response, status, payload)

    if path == "/v1/loadouts" and method == "GET":
        wanted = [value.strip().lower()
                  for value in parse_qs(environ.get("QUERY_STRING", "")).get("uuid", [])]
        wanted = [value for value in wanted if UUID_RE.match(value)][:100]
        return respond(start_response, 200, {"loadouts": lookup(wanted)})

    if path == "/v1/loadouts" and method == "POST":
        raw = read_body(environ)
        if not raw:
            return respond(start_response, 400, {"error": "bad body"})
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return respond(start_response, 400, {"error": "invalid json"})
        if not isinstance(body, dict):
            return respond(start_response, 400, {"error": "invalid json"})

        entry_uuid = str(body.get("uuid", "")).strip().lower()
        name = str(body.get("name", ""))[:MAX_NAME]
        loadout = str(body.get("loadout", ""))
        if not UUID_RE.match(entry_uuid):
            return respond(start_response, 400, {"error": "invalid uuid"})
        if len(loadout) > MAX_LOADOUT or not LOADOUT_RE.match(loadout):
            return respond(start_response, 400, {"error": "invalid loadout"})
        store(entry_uuid, name, loadout)
        return respond(start_response, 200, {"ok": True})

    prefix = "/v1/loadouts/"
    if path.startswith(prefix) and method == "DELETE":
        entry_uuid = path[len(prefix):].strip().lower()
        if not UUID_RE.match(entry_uuid):
            return respond(start_response, 400, {"error": "invalid uuid"})
        return respond(start_response, 200, {"ok": forget(entry_uuid)})

    return respond(start_response, 404, {"error": "not found"})


# WSGI servers import this module instead of running it as __main__. Initialize
# the SQLite schema during import so the hosted API is ready immediately.
init_db()
friends.configure(DB_PATH)


# ---------------------------------------------------------------------- self

if __name__ == "__main__":
    import argparse
    from wsgiref.simple_server import make_server

    parser = argparse.ArgumentParser(description="OctoClient cosmetics API (WSGI)")
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    init_db()
    with make_server("127.0.0.1", args.port, application) as server:
        print(f"WSGI test server on http://127.0.0.1:{args.port}  (db: {DB_PATH})", flush=True)
        server.serve_forever()
