"""OctoClient friends + chat backend.

Runs next to ``octoclient_api.py`` / ``octoclient_app.py`` on the same SQLite
file (tables ``players``, ``friends``, ``messages``, ``typing`` and the group
chat tables next to ``loadouts``).

Endpoints, all JSON, all under /v1/friends

    POST /v1/friends/register   {"uuid", "name"}         claim / rename a name
    GET  /v1/friends/lookup?name=<name>                  who is that?
    GET  /v1/friends                                     friends + requests + status + groups
    POST /v1/friends/presence   {"state", "detail"}      heartbeat / online / away / offline
    POST /v1/friends/request    {"name" | "uuid"}        ask somebody
    POST /v1/friends/accept     {"uuid"}                 accept a request
    POST /v1/friends/remove     {"uuid"}                 unfriend / cancel
    POST /v1/friends/messages   {"to", "body"}           send a message (text, image or GIF)
    GET  /v1/friends/messages?with=<uuid>&since=<id>     one conversation
    POST /v1/friends/messages/edit   {"id", "body"}      edit an own message
    POST /v1/friends/messages/delete {"id"}              delete an own message
    POST /v1/friends/typing     {"to"}                   "is writing" marker
    GET  /v1/friends/inbox?since=<id>                    new messages, anybody

Groups
    GET  /v1/friends/groups                              my groups + unread + last message
    POST /v1/friends/groups          {"name", "members"} create a group
    POST /v1/friends/groups/rename   {"group", "name"}   rename (owner only)
    POST /v1/friends/groups/add      {"group", "uuid"}   add a friend
    POST /v1/friends/groups/leave    {"group"}           leave / delete when empty
    POST /v1/friends/groups/messages {"group", "body"}   send into a group
    GET  /v1/friends/groups/messages?group=<id>&since=   group conversation
    POST /v1/friends/groups/messages/edit   {"id", "body"}
    POST /v1/friends/groups/messages/delete {"id"}
    POST /v1/friends/groups/typing   {"group"}           "is writing" marker

Messages are plain text (<= 500 characters) or a base64 data URL
(``data:image/gif;base64,…``, ``data:image/png;base64,…``, …). Media bodies are
stored as-is, so animated GIFs stay animated on the other side; ``kind`` tells
the client what it is.

Everything except /register and /lookup acts as a player and sends

    X-Octo-Player: <minecraft uuid>
    X-Octo-Secret: <secret returned by /register>

The optional shared server token (--token / OCTOCLIENT_API_TOKEN) still applies.
"""

from __future__ import annotations

import json
import re
import secrets
import sqlite3
import threading
import time
from urllib.parse import parse_qs

# Request bodies may carry a base64 GIF (~4 MB file -> ~5.5 MB text), so this is
# far above the old 64 KiB text limit. Everything else stays cheap.
MAX_BODY = 8 * 1024 * 1024
MAX_MESSAGE = 500
MAX_MEDIA = 6_000_000
MAX_NAME = 16
MAX_GROUP_NAME = 32
MAX_GROUP_MEMBERS = 32
ONLINE_WINDOW = 120
TYPING_WINDOW = 8
DEFAULT_LIMIT = 50
MAX_LIMIT = 100

UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)
UUID_COMPACT_RE = re.compile(r"^[0-9a-fA-F]{32}$")
NAME_RE = re.compile(r"^[A-Za-z0-9_]{2,16}$")
MEDIA_RE = re.compile(r"^data:image/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$")
GROUP_NAME_RE = re.compile(r"^[^\x00-\x1f]{1,32}$")

DB_LOCK = threading.Lock()
DB_PATH = "loadouts.db"


def configure(path: str) -> None:
    """Point the friends tables at the same database file the server uses."""
    global DB_PATH
    DB_PATH = path
    init_db()


def _connect() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    with DB_LOCK, _connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS players (
                uuid     TEXT PRIMARY KEY,
                name     TEXT NOT NULL,
                lname    TEXT NOT NULL UNIQUE,
                secret   TEXT NOT NULL,
                created  INTEGER NOT NULL,
                seen     INTEGER NOT NULL DEFAULT 0,
                presence TEXT NOT NULL DEFAULT 'online',
                detail   TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS friends (
                owner    TEXT NOT NULL,
                other    TEXT NOT NULL,
                state    TEXT NOT NULL,
                since    INTEGER NOT NULL,
                PRIMARY KEY (owner, other)
            );
            CREATE INDEX IF NOT EXISTS friends_other ON friends (other, state);
            CREATE TABLE IF NOT EXISTS messages (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                sender    TEXT NOT NULL,
                recipient TEXT NOT NULL,
                body      TEXT NOT NULL,
                sent      INTEGER NOT NULL,
                read      INTEGER NOT NULL DEFAULT 0,
                edited    INTEGER NOT NULL DEFAULT 0,
                kind      TEXT NOT NULL DEFAULT 'text'
            );
            CREATE INDEX IF NOT EXISTS messages_pair ON messages (recipient, id);
            CREATE TABLE IF NOT EXISTS typing (
                owner TEXT NOT NULL,
                other TEXT NOT NULL,
                at    INTEGER NOT NULL,
                PRIMARY KEY (owner, other)
            );
            CREATE TABLE IF NOT EXISTS groups (
                id      INTEGER PRIMARY KEY AUTOINCREMENT,
                name    TEXT NOT NULL,
                owner   TEXT NOT NULL,
                created INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS group_members (
                group_id INTEGER NOT NULL,
                uuid     TEXT NOT NULL,
                joined   INTEGER NOT NULL,
                PRIMARY KEY (group_id, uuid)
            );
            CREATE INDEX IF NOT EXISTS group_members_uuid ON group_members (uuid);
            CREATE TABLE IF NOT EXISTS group_messages (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                group_id INTEGER NOT NULL,
                sender   TEXT NOT NULL,
                body     TEXT NOT NULL,
                sent     INTEGER NOT NULL,
                edited   INTEGER NOT NULL DEFAULT 0,
                kind     TEXT NOT NULL DEFAULT 'text'
            );
            CREATE INDEX IF NOT EXISTS group_messages_group ON group_messages (group_id, id);
            CREATE TABLE IF NOT EXISTS group_read (
                group_id INTEGER NOT NULL,
                uuid     TEXT NOT NULL,
                last_id  INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (group_id, uuid)
            );
            CREATE TABLE IF NOT EXISTS group_typing (
                group_id INTEGER NOT NULL,
                uuid     TEXT NOT NULL,
                at       INTEGER NOT NULL,
                PRIMARY KEY (group_id, uuid)
            );
            """
        )
        # Databases created before message editing / media lack these columns.
        for table in ("messages", "group_messages"):
            try:
                db.execute(
                    f"ALTER TABLE {table} ADD COLUMN edited INTEGER NOT NULL DEFAULT 0"
                )
            except sqlite3.OperationalError:
                pass
        for table in ("messages", "group_messages"):
            try:
                db.execute(
                    f"ALTER TABLE {table} ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'"
                )
            except sqlite3.OperationalError:
                pass


def stats() -> dict:
    try:
        with DB_LOCK, _connect() as db:
            players = db.execute("SELECT COUNT(*) FROM players").fetchone()[0]
            messages = db.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            group_messages = db.execute("SELECT COUNT(*) FROM group_messages").fetchone()[0]
            groups = db.execute("SELECT COUNT(*) FROM groups").fetchone()[0]
        return {
            "players": players,
            "messages": messages,
            "groups": groups,
            "groupMessages": group_messages,
        }
    except sqlite3.Error:
        return {"players": 0, "messages": 0, "groups": 0, "groupMessages": 0}


def prune(days: int) -> int:
    """Drop chats older than `days` (0 disables pruning)."""
    if days <= 0:
        return 0
    cutoff = int(time.time()) - days * 86400
    with DB_LOCK, _connect() as db:
        cursor = db.execute("DELETE FROM messages WHERE sent < ?", (cutoff,))
        db.execute("DELETE FROM group_messages WHERE sent < ?", (cutoff,))
        db.execute(
            "DELETE FROM groups WHERE id NOT IN (SELECT DISTINCT group_id FROM group_messages)"
        )
        db.execute(
            "DELETE FROM group_members WHERE group_id NOT IN (SELECT id FROM groups)"
        )
        db.execute(
            "DELETE FROM group_read WHERE group_id NOT IN (SELECT id FROM groups)"
        )
        db.execute(
            "DELETE FROM group_typing WHERE group_id NOT IN (SELECT id FROM groups)"
        )
    return cursor.rowcount


def _uuid(value: str) -> str | None:
    """Canonical dashed, lower-case UUID from either spelling."""
    text = str(value or "").strip()
    if UUID_COMPACT_RE.match(text):
        text = f"{text[0:8]}-{text[8:12]}-{text[12:16]}-{text[16:20]}-{text[20:32]}"
    return text.lower() if UUID_RE.match(text) else None


def _now() -> int:
    return int(time.time())


def _iso(stamp: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(stamp or 0)))


def _int(value) -> int | None:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def _status(row: sqlite3.Row, now: int | None = None) -> str:
    now = now or _now()
    if now - int(row["seen"] or 0) > ONLINE_WINDOW:
        return "offline"
    if row["presence"] == "offline":
        return "offline"
    if row["presence"] == "away":
        return "away"
    return "ingame" if row["presence"] == "ingame" else "online"


def _friend(row: sqlite3.Row, now: int, typing: bool = False) -> dict:
    return {
        "id": row["uuid"],
        "uuid": row["uuid"],
        "name": row["name"],
        "status": _status(row, now),
        "typing": typing,
        "detail": (row["detail"] or None),
        "addedAt": _iso(row["since"]),
        "lastSeen": _iso(row["seen"]) if row["seen"] else None,
        "source": "remote",
    }


def _player(uuid: str) -> sqlite3.Row | None:
    with DB_LOCK, _connect() as db:
        return db.execute(
            "SELECT uuid, name, secret, seen, presence, detail FROM players WHERE uuid = ?",
            (uuid,),
        ).fetchone()


def _auth(header) -> sqlite3.Row | None:
    """Player behind X-Octo-Player / X-Octo-Secret, or None."""
    uuid = _uuid(header("X-Octo-Player"))
    secret = header("X-Octo-Secret")
    if not uuid or not secret:
        return None
    player = _player(uuid)
    if not player or not secrets.compare_digest(str(player["secret"]), str(secret)):
        return None
    return player


def _touch(uuid: str) -> None:
    with DB_LOCK, _connect() as db:
        db.execute("UPDATE players SET seen = ? WHERE uuid = ?", (_now(), uuid))


def _message_payload(raw) -> tuple[tuple[str, str] | None, str | None]:
    """Validates a chat body. Returns ((kind, text), None) or (None, error)."""
    text = str(raw if raw is not None else "").strip()
    if not text:
        return None, "empty message"
    match = MEDIA_RE.match(text)
    if match:
        if len(text) > MAX_MEDIA:
            return None, "media too large"
        kind = "gif" if match.group(1).lower() == "gif" else "image"
        return (kind, text), None
    if text.startswith("data:"):
        return None, "unsupported media"
    if len(text) > MAX_MESSAGE:
        return None, "message too long"
    if any(ord(character) < 32 and character not in "\n\t" for character in text):
        return None, "message contains control characters"
    return ("text", text), None


def _preview(body: str, kind: str) -> str:
    if kind == "gif":
        return "[GIF]"
    if kind == "image":
        return "[Bild]"
    text = " ".join(str(body or "").split())
    return text[:120] + ("…" if len(text) > 120 else "")


def _register(body: dict, header) -> tuple[int, dict]:
    uuid = _uuid(body.get("uuid"))
    if not uuid:
        return 400, {"error": "invalid uuid"}
    name = str(body.get("name", "")).strip()
    if not NAME_RE.match(name) or len(name) > MAX_NAME:
        return 400, {"error": "names use 2-16 letters, numbers or _"}

    existing = _player(uuid)
    if existing:
        secret = header("X-Octo-Secret")
        if secret and secrets.compare_digest(str(existing["secret"]), str(secret)):
            with DB_LOCK, _connect() as db:
                taken = db.execute(
                    "SELECT 1 FROM players WHERE lname = ? AND uuid <> ?",
                    (name.lower(), uuid),
                ).fetchone()
                if taken:
                    return 409, {"error": "name taken"}
                db.execute(
                    "UPDATE players SET name = ?, lname = ?, seen = ? WHERE uuid = ?",
                    (name, name.lower(), _now(), uuid),
                )
            return 200, {"ok": True, "uuid": uuid, "name": name, "secret": existing["secret"]}
        if not body.get("reclaim"):
            return 401, {
                "error": "name already registered",
                "hint": 'send X-Octo-Secret, or {"reclaim": true} to start over',
            }
        # Der lokale Schlüssel ist weg (Neuinstallation, gelöschte friends.json).
        # Der alte Eintrag ist damit unbrauchbar und wird samt Chats verworfen.
        with DB_LOCK, _connect() as db:
            db.execute("DELETE FROM friends WHERE owner = ? OR other = ?", (uuid, uuid))
            db.execute("DELETE FROM messages WHERE sender = ? OR recipient = ?", (uuid, uuid))
            db.execute("DELETE FROM typing WHERE owner = ? OR other = ?", (uuid, uuid))
            db.execute("DELETE FROM group_members WHERE uuid = ?", (uuid,))
            db.execute("DELETE FROM players WHERE uuid = ?", (uuid,))

    with DB_LOCK, _connect() as db:
        taken = db.execute("SELECT 1 FROM players WHERE lname = ?", (name.lower(),)).fetchone()
        if taken:
            return 409, {"error": "name taken"}
        secret = secrets.token_hex(24)
        now = _now()
        db.execute(
            "INSERT INTO players (uuid, name, lname, secret, created, seen) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (uuid, name, name.lower(), secret, now, now),
        )
    return 200, {"ok": True, "uuid": uuid, "name": name, "secret": secret}


def _group_member(db: sqlite3.Connection, group_id: int, uuid: str) -> bool:
    return bool(
        db.execute(
            "SELECT 1 FROM group_members WHERE group_id = ? AND uuid = ?",
            (group_id, uuid),
        ).fetchone()
    )


def _group_summary(db: sqlite3.Connection, row: sqlite3.Row, me: str, now: int) -> dict:
    members = db.execute(
        "SELECT p.uuid, p.name, p.presence, p.seen FROM group_members g "
        "JOIN players p ON p.uuid = g.uuid WHERE g.group_id = ? "
        "ORDER BY p.name COLLATE NOCASE",
        (row["id"],),
    ).fetchall()
    read_row = db.execute(
        "SELECT last_id FROM group_read WHERE group_id = ? AND uuid = ?",
        (row["id"], me),
    ).fetchone()
    last_read = int(read_row["last_id"]) if read_row else 0
    unread = db.execute(
        "SELECT COUNT(*) FROM group_messages "
        "WHERE group_id = ? AND id > ? AND sender <> ?",
        (row["id"], last_read, me),
    ).fetchone()[0]
    last = db.execute(
        "SELECT m.id, m.sender, p.name, m.body, m.kind, m.sent, m.edited "
        "FROM group_messages m LEFT JOIN players p ON p.uuid = m.sender "
        "WHERE m.group_id = ? ORDER BY m.id DESC LIMIT 1",
        (row["id"],),
    ).fetchone()
    preview = None
    if last:
        preview = {
            "id": last["id"],
            "from": last["sender"],
            "fromName": last["name"],
            "body": _preview(last["body"], last["kind"]),
            "kind": last["kind"],
            "sentAt": _iso(last["sent"]),
            "edited": bool(last["edited"]),
        }
    return {
        "id": row["id"],
        "name": row["name"],
        "owner": row["owner"],
        "createdAt": _iso(row["created"]),
        "members": [
            {"uuid": member["uuid"], "name": member["name"], "status": _status(member, now)}
            for member in members
        ],
        "memberCount": len(members),
        "unread": unread,
        "last": preview,
    }


def _overview(player: sqlite3.Row) -> dict:
    now = _now()
    with DB_LOCK, _connect() as db:
        friend_rows = db.execute(
            "SELECT p.uuid, p.name, p.presence, p.detail, p.seen, f.since "
            "FROM friends f JOIN players p ON p.uuid = f.other "
            "WHERE f.owner = ? AND f.state = 'accepted' ORDER BY p.name COLLATE NOCASE",
            (player["uuid"],),
        ).fetchall()
        incoming_rows = db.execute(
            "SELECT p.uuid, p.name, p.presence, p.detail, p.seen, f.since "
            "FROM friends f JOIN players p ON p.uuid = f.owner "
            "WHERE f.other = ? AND f.state = 'pending' ORDER BY f.since DESC",
            (player["uuid"],),
        ).fetchall()
        outgoing_rows = db.execute(
            "SELECT p.uuid, p.name, p.presence, p.detail, p.seen, f.since "
            "FROM friends f JOIN players p ON p.uuid = f.other "
            "WHERE f.owner = ? AND f.state = 'pending' ORDER BY f.since DESC",
            (player["uuid"],),
        ).fetchall()
        unread_rows = db.execute(
            "SELECT sender, COUNT(*) FROM messages WHERE recipient = ? AND read = 0 "
            "GROUP BY sender",
            (player["uuid"],),
        ).fetchall()
        typing_rows = db.execute(
            "SELECT owner FROM typing WHERE other = ? AND at > ?",
            (player["uuid"], now - TYPING_WINDOW),
        ).fetchall()
        group_rows = db.execute(
            "SELECT g.id, g.name, g.owner, g.created FROM groups g "
            "JOIN group_members m ON m.group_id = g.id WHERE m.uuid = ? "
            "ORDER BY g.id DESC",
            (player["uuid"],),
        ).fetchall()
        groups = [_group_summary(db, row, player["uuid"], now) for row in group_rows]
    typing = {row[0] for row in typing_rows}
    return {
        "ok": True,
        "player": {"uuid": player["uuid"], "name": player["name"]},
        "me": {
            "uuid": player["uuid"],
            "name": player["name"],
            "presence": player["presence"],
            "status": _status(player, now),
        },
        "friends": [_friend(row, now, row["uuid"] in typing) for row in friend_rows],
        "incoming": [_friend(row, now) for row in incoming_rows],
        "outgoing": [_friend(row, now) for row in outgoing_rows],
        "unread": {row[0]: row[1] for row in unread_rows},
        "groups": groups,
    }


def _lookup(query: dict) -> tuple[int, dict]:
    name = str((query.get("name") or [""])[0]).strip()
    if not name:
        return 400, {"error": "name required"}
    with DB_LOCK, _connect() as db:
        row = db.execute(
            "SELECT uuid, name FROM players WHERE lname = ?", (name.lower(),)
        ).fetchone()
    if not row:
        return 404, {"error": "unknown player"}
    return 200, {"player": {"uuid": row["uuid"], "name": row["name"]}}


def _presence(player, body: dict) -> tuple[int, dict]:
    state = str(body.get("state", "online")).strip().lower()
    if state not in {"online", "ingame", "offline", "away"}:
        state = "online"
    detail = str(body.get("detail", "") or "")[:120]
    with DB_LOCK, _connect() as db:
        db.execute(
            "UPDATE players SET presence = ?, detail = ?, seen = ? WHERE uuid = ?",
            (state, detail, _now(), player["uuid"]),
        )
    return 200, {"ok": True, "presence": state}


def _request(player, body: dict) -> tuple[int, dict]:
    other = _uuid(body.get("uuid")) if body.get("uuid") else None
    if not other and body.get("name"):
        with DB_LOCK, _connect() as db:
            row = db.execute(
                "SELECT uuid FROM players WHERE lname = ?",
                (str(body["name"]).strip().lower(),),
            ).fetchone()
        other = row["uuid"] if row else None
    if not other:
        return 404, {"error": "unknown player"}
    if other == player["uuid"]:
        return 400, {"error": "cannot add yourself"}
    with DB_LOCK, _connect() as db:
        target = db.execute("SELECT 1 FROM players WHERE uuid = ?", (other,)).fetchone()
        if not target:
            return 404, {"error": "unknown player"}
        accepted = db.execute(
            "SELECT 1 FROM friends WHERE state = 'accepted' AND "
            "((owner = ? AND other = ?) OR (owner = ? AND other = ?))",
            (player["uuid"], other, other, player["uuid"]),
        ).fetchone()
        if accepted:
            return 409, {"error": "already friends"}
        pending = db.execute(
            "SELECT 1 FROM friends WHERE owner = ? AND other = ? AND state = 'pending'",
            (player["uuid"], other),
        ).fetchone()
        if pending:
            return 409, {"error": "request already sent"}
        reverse = db.execute(
            "SELECT 1 FROM friends WHERE owner = ? AND other = ? AND state = 'pending'",
            (other, player["uuid"]),
        ).fetchone()
        if reverse:
            db.execute(
                "UPDATE friends SET state = 'accepted' WHERE owner = ? AND other = ?",
                (other, player["uuid"]),
            )
            db.execute(
                "INSERT OR REPLACE INTO friends (owner, other, state, since) "
                "VALUES (?, ?, 'accepted', ?)",
                (player["uuid"], other, _now()),
            )
            return 200, {"ok": True, "accepted": True}
        db.execute(
            "INSERT OR REPLACE INTO friends (owner, other, state, since) "
            "VALUES (?, ?, 'pending', ?)",
            (player["uuid"], other, _now()),
        )
    return 200, {"ok": True, "requested": True}


def _accept(player, body: dict) -> tuple[int, dict]:
    other = _uuid(body.get("uuid"))
    if not other:
        return 400, {"error": "invalid uuid"}
    with DB_LOCK, _connect() as db:
        row = db.execute(
            "SELECT 1 FROM friends WHERE owner = ? AND other = ? AND state = 'pending'",
            (other, player["uuid"]),
        ).fetchone()
        if not row:
            return 404, {"error": "no open request from that player"}
        now = _now()
        db.execute(
            "UPDATE friends SET state = 'accepted' WHERE owner = ? AND other = ?",
            (other, player["uuid"]),
        )
        db.execute(
            "INSERT OR REPLACE INTO friends (owner, other, state, since) "
            "VALUES (?, ?, 'accepted', ?)",
            (player["uuid"], other, now),
        )
    return 200, {"ok": True}


def _remove(player, body: dict) -> tuple[int, dict]:
    other = _uuid(body.get("uuid"))
    if not other:
        return 400, {"error": "invalid uuid"}
    with DB_LOCK, _connect() as db:
        db.execute(
            "DELETE FROM friends WHERE (owner = ? AND other = ?) OR (owner = ? AND other = ?)",
            (player["uuid"], other, other, player["uuid"]),
        )
    return 200, {"ok": True}


def _messages(player, body: dict) -> tuple[int, dict]:
    to = _uuid(body.get("to"))
    if not to:
        return 400, {"error": "invalid recipient",
                     "hint": "use the uuid from /v1/friends/lookup"}
    parsed, error = _message_payload(body.get("body"))
    if error:
        return 400, {"error": error}
    kind, text = parsed
    if to == player["uuid"]:
        return 400, {"error": "cannot message yourself"}
    with DB_LOCK, _connect() as db:
        friends = db.execute(
            "SELECT 1 FROM friends WHERE state = 'accepted' AND "
            "((owner = ? AND other = ?) OR (owner = ? AND other = ?))",
            (player["uuid"], to, to, player["uuid"]),
        ).fetchone()
        if not friends:
            return 403, {"error": "not friends"}
        now = _now()
        cursor = db.execute(
            "INSERT INTO messages (sender, recipient, body, sent, kind) "
            "VALUES (?, ?, ?, ?, ?)",
            (player["uuid"], to, text, now, kind),
        )
        message = {
            "id": cursor.lastrowid,
            "from": player["uuid"],
            "fromName": player["name"],
            "body": text,
            "kind": kind,
            "edited": False,
            "sentAt": _iso(now),
        }
    return 200, {"ok": True, "message": message}


def _thread(player, query: dict) -> tuple[int, dict]:
    other = _uuid((query.get("with") or [""])[0])
    if not other:
        return 400, {"error": "invalid uuid"}
    if other == player["uuid"]:
        return 400, {"error": "cannot open your own chat"}
    since = int((query.get("since") or ["0"])[0] or 0)
    limit = min(MAX_LIMIT, max(1, int((query.get("limit") or [DEFAULT_LIMIT])[0] or DEFAULT_LIMIT)))
    with DB_LOCK, _connect() as db:
        rows = db.execute(
            "SELECT id, sender, body, sent, edited, kind FROM messages WHERE id > ? AND "
            "((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)) "
            "ORDER BY id LIMIT ?",
            (since, player["uuid"], other, other, player["uuid"], limit),
        ).fetchall()
        db.execute(
            "UPDATE messages SET read = 1 WHERE recipient = ? AND sender = ? AND id <= ?",
            (player["uuid"], other, rows[-1]["id"] if rows else since),
        )
        typing_row = db.execute(
            "SELECT at FROM typing WHERE owner = ? AND other = ?",
            (other, player["uuid"]),
        ).fetchone()
    typing = bool(typing_row and _now() - int(typing_row["at"]) <= TYPING_WINDOW)
    messages = [
        {
            "id": row["id"],
            "from": row["sender"],
            "body": row["body"],
            "kind": row["kind"] or "text",
            "edited": bool(row["edited"]),
            "sentAt": _iso(row["sent"]),
        }
        for row in rows
    ]
    return 200, {
        "messages": messages,
        "last": messages[-1]["id"] if messages else since,
        "typing": typing,
    }


def _typing(player, body: dict) -> tuple[int, dict]:
    """Marks that the player is typing to a friend; polls read it for a few seconds."""
    to = _uuid(body.get("to"))
    if not to:
        return 400, {"error": "invalid recipient"}
    with DB_LOCK, _connect() as db:
        db.execute(
            "INSERT INTO typing (owner, other, at) VALUES (?, ?, ?) "
            "ON CONFLICT(owner, other) DO UPDATE SET at = excluded.at",
            (player["uuid"], to, _now()),
        )
    return 200, {"ok": True}


def _edit_message(player, body: dict) -> tuple[int, dict]:
    message_id = _int(body.get("id"))
    if not message_id:
        return 400, {"error": "invalid message"}
    parsed, error = _message_payload(body.get("body"))
    if error:
        return 400, {"error": error}
    kind, text = parsed
    with DB_LOCK, _connect() as db:
        row = db.execute("SELECT sender FROM messages WHERE id = ?", (message_id,)).fetchone()
        if not row:
            return 404, {"error": "unknown message"}
        if row["sender"] != player["uuid"]:
            return 403, {"error": "not your message"}
        db.execute(
            "UPDATE messages SET body = ?, kind = ?, edited = 1 WHERE id = ?",
            (text, kind, message_id),
        )
    return 200, {"ok": True, "message": {"id": message_id, "body": text, "kind": kind, "edited": True}}


def _delete_message(player, body: dict) -> tuple[int, dict]:
    message_id = _int(body.get("id"))
    if not message_id:
        return 400, {"error": "invalid message"}
    with DB_LOCK, _connect() as db:
        row = db.execute("SELECT sender FROM messages WHERE id = ?", (message_id,)).fetchone()
        if not row:
            return 200, {"ok": True}
        if row["sender"] != player["uuid"]:
            return 403, {"error": "not your message"}
        db.execute("DELETE FROM messages WHERE id = ?", (message_id,))
    return 200, {"ok": True}


def _inbox(player, query: dict) -> tuple[int, dict]:
    since = int((query.get("since") or ["0"])[0] or 0)
    limit = min(MAX_LIMIT, max(1, int((query.get("limit") or [DEFAULT_LIMIT])[0] or DEFAULT_LIMIT)))
    with DB_LOCK, _connect() as db:
        rows = db.execute(
            "SELECT m.id, m.sender, p.name, m.body, m.kind, m.sent FROM messages m "
            "JOIN players p ON p.uuid = m.sender WHERE m.recipient = ? AND m.id > ? "
            "ORDER BY m.id LIMIT ?",
            (player["uuid"], since, limit),
        ).fetchall()
    messages = [
        {
            "id": row["id"],
            "from": row["sender"],
            "fromName": row["name"],
            "body": row["body"],
            "kind": row["kind"] or "text",
            "sentAt": _iso(row["sent"]),
        }
        for row in rows
    ]
    return 200, {"messages": messages, "last": messages[-1]["id"] if messages else since}


def _groups(player) -> tuple[int, dict]:
    now = _now()
    with DB_LOCK, _connect() as db:
        rows = db.execute(
            "SELECT g.id, g.name, g.owner, g.created FROM groups g "
            "JOIN group_members m ON m.group_id = g.id WHERE m.uuid = ? "
            "ORDER BY g.id DESC",
            (player["uuid"],),
        ).fetchall()
        groups = [_group_summary(db, row, player["uuid"], now) for row in rows]
    return 200, {"groups": groups}


def _create_group(player, body: dict) -> tuple[int, dict]:
    name = str(body.get("name", "") or "").strip()
    raw_members = body.get("members") or []
    if not isinstance(raw_members, list):
        return 400, {"error": "members required", "hint": "pass a list of friend uuids"}
    wanted: list[str] = []
    for value in raw_members[:MAX_GROUP_MEMBERS]:
        other = _uuid(value)
        if other and other != player["uuid"] and other not in wanted:
            wanted.append(other)
    if not wanted:
        return 400, {"error": "members required",
                     "hint": "choose at least one friend"}
    with DB_LOCK, _connect() as db:
        accepted = {
            row[0]
            for row in db.execute(
                "SELECT other FROM friends WHERE owner = ? AND state = 'accepted' "
                "UNION SELECT owner FROM friends WHERE other = ? AND state = 'accepted'",
                (player["uuid"], player["uuid"]),
            )
        }
        allowed = [member for member in wanted if member in accepted]
        if not allowed:
            return 403, {"error": "not friends"}
        if len(allowed) > MAX_GROUP_MEMBERS - 1:
            allowed = allowed[: MAX_GROUP_MEMBERS - 1]
        placeholders = ",".join("?" for _ in allowed)
        name_rows = db.execute(
            f"SELECT name FROM players WHERE uuid IN ({placeholders}) ORDER BY name COLLATE NOCASE",
            tuple(allowed),
        ).fetchall()
        if not name:
            labels = [row["name"] for row in name_rows[:2]]
            name = (", ".join(labels) or "Gruppe") + (" +" if len(name_rows) > 2 else "")
        if not GROUP_NAME_RE.match(name):
            return 400, {"error": "invalid group name",
                         "hint": "use 1-32 characters without control codes"}
        now = _now()
        cursor = db.execute(
            "INSERT INTO groups (name, owner, created) VALUES (?, ?, ?)",
            (name, player["uuid"], now),
        )
        group_id = cursor.lastrowid
        db.execute(
            "INSERT INTO group_members (group_id, uuid, joined) VALUES (?, ?, ?)",
            (group_id, player["uuid"], now),
        )
        for member in allowed:
            db.execute(
                "INSERT INTO group_members (group_id, uuid, joined) VALUES (?, ?, ?)",
                (group_id, member, now),
            )
        row = db.execute(
            "SELECT id, name, owner, created FROM groups WHERE id = ?", (group_id,)
        ).fetchone()
        group = _group_summary(db, row, player["uuid"], now)
    return 200, {"ok": True, "group": group}


def _rename_group(player, body: dict) -> tuple[int, dict]:
    group_id = _int(body.get("group"))
    if not group_id:
        return 400, {"error": "invalid group"}
    name = str(body.get("name", "") or "").strip()
    if not GROUP_NAME_RE.match(name):
        return 400, {"error": "invalid group name",
                     "hint": "use 1-32 characters without control codes"}
    with DB_LOCK, _connect() as db:
        row = db.execute("SELECT owner FROM groups WHERE id = ?", (group_id,)).fetchone()
        if not row:
            return 404, {"error": "unknown group"}
        if row["owner"] != player["uuid"]:
            return 403, {"error": "not group owner"}
        db.execute("UPDATE groups SET name = ? WHERE id = ?", (name, group_id))
    return 200, {"ok": True, "name": name}


def _add_group_member(player, body: dict) -> tuple[int, dict]:
    group_id = _int(body.get("group"))
    other = _uuid(body.get("uuid"))
    if not group_id:
        return 400, {"error": "invalid group"}
    if not other:
        return 400, {"error": "invalid uuid"}
    with DB_LOCK, _connect() as db:
        row = db.execute("SELECT 1 FROM groups WHERE id = ?", (group_id,)).fetchone()
        if not row:
            return 404, {"error": "unknown group"}
        if not _group_member(db, group_id, player["uuid"]):
            return 403, {"error": "not a member"}
        if _group_member(db, group_id, other):
            return 409, {"error": "already a member"}
        friend = db.execute(
            "SELECT 1 FROM friends WHERE state = 'accepted' AND "
            "((owner = ? AND other = ?) OR (owner = ? AND other = ?))",
            (player["uuid"], other, other, player["uuid"]),
        ).fetchone()
        if not friend:
            return 403, {"error": "not friends"}
        count = db.execute(
            "SELECT COUNT(*) FROM group_members WHERE group_id = ?", (group_id,)
        ).fetchone()[0]
        if count >= MAX_GROUP_MEMBERS:
            return 400, {"error": "group full"}
        db.execute(
            "INSERT INTO group_members (group_id, uuid, joined) VALUES (?, ?, ?)",
            (group_id, other, _now()),
        )
    return 200, {"ok": True}


def _leave_group(player, body: dict) -> tuple[int, dict]:
    group_id = _int(body.get("group"))
    if not group_id:
        return 400, {"error": "invalid group"}
    with DB_LOCK, _connect() as db:
        row = db.execute("SELECT owner FROM groups WHERE id = ?", (group_id,)).fetchone()
        if not row:
            return 200, {"ok": True}
        if not _group_member(db, group_id, player["uuid"]):
            return 404, {"error": "not a member"}
        db.execute(
            "DELETE FROM group_members WHERE group_id = ? AND uuid = ?",
            (group_id, player["uuid"]),
        )
        db.execute(
            "DELETE FROM group_read WHERE group_id = ? AND uuid = ?",
            (group_id, player["uuid"]),
        )
        db.execute(
            "DELETE FROM group_typing WHERE group_id = ? AND uuid = ?",
            (group_id, player["uuid"]),
        )
        remaining = db.execute(
            "SELECT uuid FROM group_members WHERE group_id = ? ORDER BY joined",
            (group_id,),
        ).fetchall()
        if not remaining:
            db.execute("DELETE FROM group_messages WHERE group_id = ?", (group_id,))
            db.execute("DELETE FROM group_read WHERE group_id = ?", (group_id,))
            db.execute("DELETE FROM group_typing WHERE group_id = ?", (group_id,))
            db.execute("DELETE FROM groups WHERE id = ?", (group_id,))
        elif row["owner"] == player["uuid"]:
            db.execute(
                "UPDATE groups SET owner = ? WHERE id = ?",
                (remaining[0]["uuid"], group_id),
            )
    return 200, {"ok": True}


def _group_send(player, body: dict) -> tuple[int, dict]:
    group_id = _int(body.get("group"))
    if not group_id:
        return 400, {"error": "invalid group"}
    parsed, error = _message_payload(body.get("body"))
    if error:
        return 400, {"error": error}
    kind, text = parsed
    with DB_LOCK, _connect() as db:
        if not _group_member(db, group_id, player["uuid"]):
            return 403, {"error": "not a member"}
        now = _now()
        cursor = db.execute(
            "INSERT INTO group_messages (group_id, sender, body, sent, kind) "
            "VALUES (?, ?, ?, ?, ?)",
            (group_id, player["uuid"], text, now, kind),
        )
        db.execute(
            "INSERT INTO group_read (group_id, uuid, last_id) VALUES (?, ?, ?) "
            "ON CONFLICT(group_id, uuid) DO UPDATE SET last_id = excluded.last_id",
            (group_id, player["uuid"], cursor.lastrowid),
        )
    return 200, {
        "ok": True,
        "message": {
            "id": cursor.lastrowid,
            "group": group_id,
            "from": player["uuid"],
            "fromName": player["name"],
            "body": text,
            "kind": kind,
            "edited": False,
            "sentAt": _iso(now),
        },
    }


def _group_thread(player, query: dict) -> tuple[int, dict]:
    group_id = _int((query.get("group") or [""])[0])
    if not group_id:
        return 400, {"error": "invalid group"}
    since = int((query.get("since") or ["0"])[0] or 0)
    limit = min(MAX_LIMIT, max(1, int((query.get("limit") or [DEFAULT_LIMIT])[0] or DEFAULT_LIMIT)))
    now = _now()
    with DB_LOCK, _connect() as db:
        if not _group_member(db, group_id, player["uuid"]):
            return 403, {"error": "not a member"}
        rows = db.execute(
            "SELECT m.id, m.sender, p.name, m.body, m.kind, m.sent, m.edited "
            "FROM group_messages m LEFT JOIN players p ON p.uuid = m.sender "
            "WHERE m.group_id = ? AND m.id > ? ORDER BY m.id LIMIT ?",
            (group_id, since, limit),
        ).fetchall()
        last_id = rows[-1]["id"] if rows else since
        db.execute(
            "INSERT INTO group_read (group_id, uuid, last_id) VALUES (?, ?, ?) "
            "ON CONFLICT(group_id, uuid) DO UPDATE SET last_id = excluded.last_id",
            (group_id, player["uuid"], last_id),
        )
        typing_rows = db.execute(
            "SELECT p.name FROM group_typing t JOIN players p ON p.uuid = t.uuid "
            "WHERE t.group_id = ? AND t.at > ? AND t.uuid <> ?",
            (group_id, now - TYPING_WINDOW, player["uuid"]),
        ).fetchall()
    messages = [
        {
            "id": row["id"],
            "group": group_id,
            "from": row["sender"],
            "fromName": row["name"],
            "body": row["body"],
            "kind": row["kind"] or "text",
            "edited": bool(row["edited"]),
            "sentAt": _iso(row["sent"]),
        }
        for row in rows
    ]
    return 200, {
        "messages": messages,
        "last": last_id,
        "typing": [row["name"] for row in typing_rows],
    }


def _group_typing(player, body: dict) -> tuple[int, dict]:
    group_id = _int(body.get("group"))
    if not group_id:
        return 400, {"error": "invalid group"}
    with DB_LOCK, _connect() as db:
        if not _group_member(db, group_id, player["uuid"]):
            return 403, {"error": "not a member"}
        db.execute(
            "INSERT INTO group_typing (group_id, uuid, at) VALUES (?, ?, ?) "
            "ON CONFLICT(group_id, uuid) DO UPDATE SET at = excluded.at",
            (group_id, player["uuid"], _now()),
        )
    return 200, {"ok": True}


def _group_edit(player, body: dict) -> tuple[int, dict]:
    message_id = _int(body.get("id"))
    if not message_id:
        return 400, {"error": "invalid message"}
    parsed, error = _message_payload(body.get("body"))
    if error:
        return 400, {"error": error}
    kind, text = parsed
    with DB_LOCK, _connect() as db:
        row = db.execute(
            "SELECT sender FROM group_messages WHERE id = ?", (message_id,)
        ).fetchone()
        if not row:
            return 404, {"error": "unknown message"}
        if row["sender"] != player["uuid"]:
            return 403, {"error": "not your message"}
        db.execute(
            "UPDATE group_messages SET body = ?, kind = ?, edited = 1 WHERE id = ?",
            (text, kind, message_id),
        )
    return 200, {"ok": True, "message": {"id": message_id, "body": text, "kind": kind, "edited": True}}


def _group_delete(player, body: dict) -> tuple[int, dict]:
    message_id = _int(body.get("id"))
    if not message_id:
        return 400, {"error": "invalid message"}
    with DB_LOCK, _connect() as db:
        row = db.execute(
            "SELECT sender FROM group_messages WHERE id = ?", (message_id,)
        ).fetchone()
        if not row:
            return 200, {"ok": True}
        if row["sender"] != player["uuid"]:
            return 403, {"error": "not your message"}
        db.execute("DELETE FROM group_messages WHERE id = ?", (message_id,))
    return 200, {"ok": True}


def handle(method: str, path: str, query: dict, body: bytes, header) -> tuple[int, dict]:
    """Route one friends request. Returns (status, payload)."""
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")
    try:
        payload = json.loads(body.decode("utf-8")) if body else {}
    except (UnicodeDecodeError, json.JSONDecodeError):
        return 400, {"error": "invalid json"}
    if not isinstance(payload, dict):
        return 400, {"error": "invalid json"}

    if path == "/v1/friends/register" and method == "POST":
        return _register(payload, header)
    if path == "/v1/friends/lookup" and method == "GET":
        return _lookup(query)

    player = _auth(header)
    if not player:
        return 401, {"error": "player auth required",
                     "hint": "send X-Octo-Player and X-Octo-Secret"}
    _touch(player["uuid"])

    if path == "/v1/friends" and method == "GET":
        return 200, _overview(player)
    if path == "/v1/friends/presence" and method == "POST":
        return _presence(player, payload)
    if path == "/v1/friends/request" and method == "POST":
        return _request(player, payload)
    if path == "/v1/friends/accept" and method == "POST":
        return _accept(player, payload)
    if path == "/v1/friends/remove" and method == "POST":
        return _remove(player, payload)
    if path == "/v1/friends/messages" and method == "POST":
        return _messages(player, payload)
    if path == "/v1/friends/messages/edit" and method == "POST":
        return _edit_message(player, payload)
    if path == "/v1/friends/messages/delete" and method == "POST":
        return _delete_message(player, payload)
    if path == "/v1/friends/messages" and method == "GET":
        return _thread(player, query)
    if path == "/v1/friends/typing" and method == "POST":
        return _typing(player, payload)
    if path == "/v1/friends/inbox" and method == "GET":
        return _inbox(player, query)

    if path == "/v1/friends/groups" and method == "GET":
        return _groups(player)
    if path == "/v1/friends/groups" and method == "POST":
        return _create_group(player, payload)
    if path == "/v1/friends/groups/rename" and method == "POST":
        return _rename_group(player, payload)
    if path == "/v1/friends/groups/add" and method == "POST":
        return _add_group_member(player, payload)
    if path == "/v1/friends/groups/leave" and method == "POST":
        return _leave_group(player, payload)
    if path == "/v1/friends/groups/messages" and method == "POST":
        return _group_send(player, payload)
    if path == "/v1/friends/groups/messages/edit" and method == "POST":
        return _group_edit(player, payload)
    if path == "/v1/friends/groups/messages/delete" and method == "POST":
        return _group_delete(player, payload)
    if path == "/v1/friends/groups/messages" and method == "GET":
        return _group_thread(player, query)
    if path == "/v1/friends/groups/typing" and method == "POST":
        return _group_typing(player, payload)

    return 404, {"error": "not found"}
