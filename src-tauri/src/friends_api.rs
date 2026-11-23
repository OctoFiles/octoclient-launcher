//! HTTP client for the shared OctoClient friends server.
//!
//! The launcher never asks the player for a URL: the server address defaults to
//! the public instance and can only be overridden with `FROST_FRIENDS_API`.

use reqwest::Method;
use serde_json::{json, Value};

use crate::error::{LauncherError, Result};

/// Works out of the box — no URL has to be typed anywhere.
pub const DEFAULT_BASE_URL: &str = "https://octoclient.pythonanywhere.com";
const REQUEST_TIMEOUT_SECS: u64 = 15;

/// Server base URL without a trailing slash.
pub fn base_url() -> String {
    std::env::var("FROST_FRIENDS_API")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| value.starts_with("http"))
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

/// Canonical dashed, lower-case UUID from either spelling (dashed or compact).
pub fn dashed_uuid(raw: &str) -> Option<String> {
    let text = raw.trim().to_ascii_lowercase();
    if text.is_empty() || text.chars().any(|c| !(c.is_ascii_hexdigit() || c == '-')) {
        return None;
    }
    let hex: String = text.chars().filter(|c| c.is_ascii_hexdigit()).collect();
    if hex.len() != 32 {
        return None;
    }
    Some(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// Turns the server's `{ "error": …, "hint": … }` payloads into a readable message.
fn friendly(status: u16, payload: &Value) -> LauncherError {
    let code = payload.get("error").and_then(Value::as_str).unwrap_or("");
    let message = match code {
        "player auth required" => {
            "Der Freundes-Server hat den gespeicherten Schlüssel abgelehnt. Bitte installiere die \
             neueste OctoClient-Version — sie verbindet sich dann automatisch neu."
        }
        "name already registered" => {
            "Der Freundes-Server kennt dein Konto noch aus einer früheren Installation und gibt es \
             nicht frei. Bitte aktualisiere dort `octoclient_friends.py` — danach verbindet sich \
             der Launcher automatisch neu."
        }
        "name taken" => "Dieser Name ist auf dem Freundes-Server bereits vergeben.",
        "unknown player" => "Diesen Spieler gibt es (noch) nicht. Prüfe die Schreibweise.",
        "already friends" => "Ihr seid schon Freunde.",
        "cannot add yourself" => "Du kannst dich nicht selbst hinzufügen.",
        "cannot message yourself" => "Du kannst dir nicht selbst schreiben.",
        "not friends" => "Ihr seid noch keine Freunde.",
        "not your message" => "Nur die eigene Nachricht lässt sich ändern.",
        "unknown message" => "Diese Nachricht gibt es nicht mehr.",
        "empty message" => "Die Nachricht ist leer.",
        "message too long" => "Die Nachricht ist zu lang.",
        "media too large" => "Das Bild oder GIF ist zu groß (maximal 4 MB).",
        "unsupported media" => "Dieses Dateiformat wird im Chat nicht unterstützt.",
        "members required" => "Wähle mindestens einen Freund für die Gruppe.",
        "invalid group" => "Diese Gruppe gibt es nicht mehr.",
        "unknown group" => "Diese Gruppe gibt es nicht mehr.",
        "invalid group name" => "Der Gruppenname muss 1–32 Zeichen haben.",
        "not a member" => "Du bist kein Mitglied dieser Gruppe.",
        "already a member" => "Der Spieler ist schon in der Gruppe.",
        "group full" => "Die Gruppe ist voll (maximal 32 Mitglieder).",
        "not group owner" => "Nur der Ersteller kann die Gruppe umbenennen.",
        "invalid name" => "Der Name muss 2–16 Zeichen haben (Buchstaben, Zahlen, _).",
        "invalid uuid" => "Der Freundes-Server kennt diese Spieler-UUID nicht.",
        "rate limited" => "Zu viele Anfragen — bitte einen Moment warten.",
        "unauthorized" => "Der Freundes-Server verlangt ein Token.",
        "" => return LauncherError::Message(format!("Freundes-Server antwortet mit HTTP {status}.")),
        other => return LauncherError::Message(format!("Freundes-Server: {other}")),
    };
    LauncherError::Message(message.to_string())
}

/// Sends one request and keeps the status, so callers can react to specific
/// failures (the register flow does).
async fn call_raw(
    http: &reqwest::Client,
    base: &str,
    method: Method,
    path: &str,
    auth: Option<(&str, &str)>,
    body: Option<Value>,
) -> Result<(u16, Value)> {
    let mut request = http
        .request(method, format!("{base}{path}"))
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS));
    if let Some((uuid, secret)) = auth {
        request = request
            .header("X-Octo-Player", uuid)
            .header("X-Octo-Secret", secret);
    }
    if let Some(body) = body {
        request = request.json(&body);
    }

    let response = request
        .send()
        .await
        .map_err(|error| LauncherError::Message(format!("Freundes-Server nicht erreichbar: {error}")))?;
    let status = response.status();
    let raw = response
        .text()
        .await
        .map_err(|error| LauncherError::Message(format!("Antwort des Freundes-Servers fehlt: {error}")))?;
    let payload: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    Ok((status.as_u16(), payload))
}

async fn call(
    http: &reqwest::Client,
    base: &str,
    method: Method,
    path: &str,
    auth: Option<(&str, &str)>,
    body: Option<Value>,
) -> Result<Value> {
    let (status, payload) = call_raw(http, base, method, path, auth, body).await?;
    if !(200..300).contains(&status) {
        return Err(friendly(status, &payload));
    }
    Ok(payload)
}

/// Claims (or renames) the player's name and returns the secret for later calls.
///
/// If the server still knows this UUID from an earlier install while the local
/// secret is gone (fresh Windows profile, deleted `friends.json`), the first
/// attempt fails with `name already registered`. The second attempt asks the
/// server to start over, so the launcher heals itself without manual cleanup.
pub async fn register(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    name: &str,
    secret: Option<&str>,
) -> Result<String> {
    let mut payload = Value::Null;
    for reclaim in [false, true] {
        let mut body = json!({ "uuid": uuid, "name": name });
        if reclaim {
            body["reclaim"] = json!(true);
        }
        let auth = match (reclaim, secret) {
            (false, Some(value)) => Some((uuid, value)),
            _ => None,
        };
        let (status, value) = call_raw(
            http,
            base,
            Method::POST,
            "/v1/friends/register",
            auth,
            Some(body),
        )
        .await?;
        if (200..300).contains(&status) {
            payload = value;
            break;
        }
        let stale = !reclaim
            && value.get("error").and_then(Value::as_str) == Some("name already registered");
        if !stale {
            return Err(friendly(status, &value));
        }
    }
    payload
        .get("secret")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| {
            LauncherError::Message("Der Freundes-Server hat kein Geheimnis zurückgegeben.".into())
        })
}

pub async fn presence(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    state: &str,
    detail: Option<&str>,
) -> Result<()> {
    let mut body = json!({ "state": state });
    if let Some(detail) = detail {
        body["detail"] = json!(detail);
    }
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/presence",
        Some((uuid, secret)),
        Some(body),
    )
    .await
    .map(|_| ())
}

pub async fn overview(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
) -> Result<Value> {
    call(http, base, Method::GET, "/v1/friends", Some((uuid, secret)), None).await
}

pub async fn friend_request(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    name: &str,
) -> Result<()> {
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/request",
        Some((uuid, secret)),
        Some(json!({ "name": name })),
    )
    .await
    .map(|_| ())
}

pub async fn friend_accept(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    other: &str,
) -> Result<()> {
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/accept",
        Some((uuid, secret)),
        Some(json!({ "uuid": other })),
    )
    .await
    .map(|_| ())
}

pub async fn friend_remove(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    other: &str,
) -> Result<()> {
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/remove",
        Some((uuid, secret)),
        Some(json!({ "uuid": other })),
    )
    .await
    .map(|_| ())
}

pub async fn send_message(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    to: &str,
    text: &str,
) -> Result<()> {
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/messages",
        Some((uuid, secret)),
        Some(json!({ "to": to, "body": text })),
    )
    .await
    .map(|_| ())
}

/// Tells the server the player is writing to `to`.
pub async fn typing(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    to: &str,
) -> Result<()> {
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/typing",
        Some((uuid, secret)),
        Some(json!({ "to": to })),
    )
    .await
    .map(|_| ())
}

/// Rewrites one of the player's own messages.
pub async fn edit_message(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    id: i64,
    text: &str,
) -> Result<()> {
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/messages/edit",
        Some((uuid, secret)),
        Some(json!({ "id": id, "body": text })),
    )
    .await
    .map(|_| ())
}

/// Removes one of the player's own messages for both sides.
pub async fn delete_message(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    id: i64,
) -> Result<()> {
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/messages/delete",
        Some((uuid, secret)),
        Some(json!({ "id": id })),
    )
    .await
    .map(|_| ())
}

pub async fn messages(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    with: &str,
    since: i64,
) -> Result<Value> {
    call(
        http,
        base,
        Method::GET,
        &format!("/v1/friends/messages?with={with}&since={since}"),
        Some((uuid, secret)),
        None,
    )
    .await
}

// --- Group chats -------------------------------------------------------

pub async fn groups(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
) -> Result<Value> {
    call(http, base, Method::GET, "/v1/friends/groups", Some((uuid, secret)), None).await
}

pub async fn group_create(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    name: Option<&str>,
    members: &[String],
) -> Result<Value> {
    let mut body = json!({ "members": members });
    if let Some(name) = name.filter(|value| !value.trim().is_empty()) {
        body["name"] = json!(name);
    }
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/groups",
        Some((uuid, secret)),
        Some(body),
    )
    .await
}

pub async fn group_rename(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    group: i64,
    name: &str,
) -> Result<()> {
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/groups/rename",
        Some((uuid, secret)),
        Some(json!({ "group": group, "name": name })),
    )
    .await
    .map(|_| ())
}

pub async fn group_add(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    group: i64,
    member: &str,
) -> Result<()> {
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/groups/add",
        Some((uuid, secret)),
        Some(json!({ "group": group, "uuid": member })),
    )
    .await
    .map(|_| ())
}

pub async fn group_leave(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    group: i64,
) -> Result<()> {
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/groups/leave",
        Some((uuid, secret)),
        Some(json!({ "group": group })),
    )
    .await
    .map(|_| ())
}

pub async fn group_send(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    group: i64,
    text: &str,
) -> Result<()> {
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/groups/messages",
        Some((uuid, secret)),
        Some(json!({ "group": group, "body": text })),
    )
    .await
    .map(|_| ())
}

pub async fn group_messages(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    group: i64,
    since: i64,
) -> Result<Value> {
    call(
        http,
        base,
        Method::GET,
        &format!("/v1/friends/groups/messages?group={group}&since={since}"),
        Some((uuid, secret)),
        None,
    )
    .await
}

pub async fn group_typing(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    group: i64,
) -> Result<()> {
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/groups/typing",
        Some((uuid, secret)),
        Some(json!({ "group": group })),
    )
    .await
    .map(|_| ())
}

pub async fn group_edit(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    id: i64,
    text: &str,
) -> Result<()> {
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/groups/messages/edit",
        Some((uuid, secret)),
        Some(json!({ "id": id, "body": text })),
    )
    .await
    .map(|_| ())
}

pub async fn group_delete(
    http: &reqwest::Client,
    base: &str,
    uuid: &str,
    secret: &str,
    id: i64,
) -> Result<()> {
    call(
        http,
        base,
        Method::POST,
        "/v1/friends/groups/messages/delete",
        Some((uuid, secret)),
        Some(json!({ "id": id })),
    )
    .await
    .map(|_| ())
}
