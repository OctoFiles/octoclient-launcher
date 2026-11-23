//! Friends commands: the whole feature talks to the shared OctoClient friends
//! server, so two launchers can find each other by name and chat.
//!
//! Login is implicit: the Minecraft account is registered once (secret stored in
//! `friends.json`) and every command reconnects with it — nothing has to be
//! configured by the player.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::error::{LauncherError, Result};
use crate::friends::{FriendsDb, Identity};
use crate::friends_api as api;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendView {
    pub uuid: String,
    pub name: String,
    /// `online`, `ingame`, `away` or `offline`.
    pub status: String,
    pub detail: Option<String>,
    pub last_seen: Option<String>,
    pub unread: u32,
    /// The friend is writing in the open conversation right now.
    pub typing: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendsSnapshot {
    pub me: FriendView,
    pub friends: Vec<FriendView>,
    pub incoming: Vec<FriendView>,
    pub outgoing: Vec<FriendView>,
    pub unread: HashMap<String, u32>,
    /// Group chats the player is part of.
    pub groups: Vec<GroupView>,
    /// Server the launcher is connected to (shown in the UI).
    pub server: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: i64,
    pub from: String,
    pub from_name: Option<String>,
    pub body: String,
    /// `text`, `image` or `gif`; media bodies are data URLs.
    pub kind: String,
    pub sent_at: String,
    /// The text was changed after sending.
    pub edited: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FriendsThread {
    pub messages: Vec<ChatMessage>,
    pub last: i64,
    /// The other side is typing.
    pub typing: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMember {
    pub uuid: String,
    pub name: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupPreview {
    pub id: i64,
    pub from: String,
    pub from_name: Option<String>,
    pub body: String,
    pub kind: String,
    pub sent_at: String,
    pub edited: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupView {
    pub id: i64,
    pub name: String,
    pub owner: String,
    pub members: Vec<GroupMember>,
    pub member_count: u32,
    pub unread: u32,
    pub last: Option<GroupPreview>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupThread {
    pub messages: Vec<ChatMessage>,
    pub last: i64,
    /// Names of the members writing right now.
    pub typing: Vec<String>,
}

/// Minecraft names are `[A-Za-z0-9_]{3,16}`; the friends server allows 2–16.
fn sanitize_name(raw: &str) -> Option<String> {
    let cleaned: String = raw
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '_')
        .take(16)
        .collect();
    (cleaned.len() >= 2).then_some(cleaned)
}

/// Text messages stay short; an attachment is a base64 data URL whose size is
/// the only thing that matters (animated GIFs are sent untouched).
fn message_body(raw: &str) -> Result<String> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(LauncherError::Invalid("Die Nachricht ist leer.".into()));
    }
    if text.starts_with("data:") {
        if !text.starts_with("data:image/") || !text.contains(";base64,") {
            return Err(LauncherError::Invalid(
                "Dieses Dateiformat wird im Chat nicht unterstützt.".into(),
            ));
        }
        if text.len() > 6_000_000 {
            return Err(LauncherError::Invalid(
                "Das Bild oder GIF ist zu groß (maximal 4 MB).".into(),
            ));
        }
        return Ok(text.to_string());
    }
    if text.chars().count() > 1000 {
        return Err(LauncherError::Invalid("Die Nachricht ist zu lang.".into()));
    }
    Ok(text.to_string())
}

/// Secrets the server already accepted during this run: the check that heals
/// stale credentials costs one request per session instead of one per call.
fn verified() -> &'static Mutex<HashSet<String>> {
    static VERIFIED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    VERIFIED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn verify_key(server: &str, uuid: &str, secret: &str) -> String {
    format!("{server}|{uuid}|{secret}")
}

/// Identity of the signed-in player, registered (and thereby checked) on use.
///
/// Registering is idempotent: a valid stored secret comes back unchanged, while a
/// stale one — server reset, restored Windows profile, deleted data — is replaced,
/// so two launchers reconnect without anyone cleaning up by hand.
async fn identity(state: &AppState) -> Result<Identity> {
    let account = state
        .auth
        .snapshot()
        .account
        .ok_or(LauncherError::NotSignedIn)?;
    let uuid = api::dashed_uuid(&account.uuid).ok_or_else(|| {
        LauncherError::Invalid("Die UUID des Minecraft-Profils ist ungültig.".into())
    })?;
    let name = sanitize_name(&account.username).ok_or_else(|| {
        LauncherError::Invalid(
            "Der Minecraft-Name lässt sich nicht als Freundes-Name verwenden.".into(),
        )
    })?;
    let server = api::base_url();
    let db = FriendsDb::new(&state.paths.data_dir);

    let existing = db.identity(&uuid, &server);
    if let Some(identity) = existing.as_ref() {
        let known = verified()
            .lock()
            .map(|set| set.contains(&verify_key(&identity.server, &identity.uuid, &identity.secret)))
            .unwrap_or(false);
        if known {
            return Ok(identity.clone());
        }
    }

    let secret = api::register(
        &state.http,
        &server,
        &uuid,
        &name,
        existing.as_ref().map(|identity| identity.secret.as_str()),
    )
    .await?;
    let identity = Identity {
        uuid,
        name,
        secret,
        server,
        // Keep the availability the player picked before re-registering.
        presence: existing
            .as_ref()
            .map(|identity| identity.presence.clone())
            .filter(|presence| !presence.is_empty())
            .unwrap_or_else(|| "online".into()),
    };
    db.remember(&identity)?;
    if let Ok(mut set) = verified().lock() {
        set.insert(verify_key(
            &identity.server,
            &identity.uuid,
            &identity.secret,
        ));
    }
    Ok(identity)
}

fn friend_view(value: &Value, unread: &HashMap<String, u32>) -> Option<FriendView> {
    let uuid = value.get("uuid").and_then(Value::as_str)?.to_string();
    Some(FriendView {
        unread: unread.get(&uuid).copied().unwrap_or(0),
        typing: value.get("typing").and_then(Value::as_bool).unwrap_or(false),
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string(),
        status: value
            .get("status")
            .or_else(|| value.get("presence"))
            .and_then(Value::as_str)
            .unwrap_or("offline")
            .to_string(),
        detail: value
            .get("detail")
            .and_then(Value::as_str)
            .filter(|detail| !detail.trim().is_empty())
            .map(str::to_string),
        last_seen: value
            .get("lastSeen")
            .and_then(Value::as_str)
            .map(str::to_string),
        uuid,
    })
}

fn list(payload: &Value, key: &str, unread: &HashMap<String, u32>) -> Vec<FriendView> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| friend_view(item, unread))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_overview(identity: &Identity, payload: &Value) -> FriendsSnapshot {
    // The hosted server answers with `me`, the bundled one with `player`.
    let me_value = payload
        .get("me")
        .or_else(|| payload.get("player"))
        .cloned()
        .unwrap_or(Value::Null);
    let unread: HashMap<String, u32> = payload
        .get("unread")
        .and_then(Value::as_object)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|(key, value)| value.as_u64().map(|count| (key.clone(), count as u32)))
                .collect()
        })
        .unwrap_or_default();

    let me = friend_view(&me_value, &HashMap::new()).unwrap_or_else(|| FriendView {
        uuid: identity.uuid.clone(),
        name: identity.name.clone(),
        status: "online".into(),
        detail: None,
        last_seen: None,
        unread: 0,
        typing: false,
    });

    FriendsSnapshot {
        me,
        friends: list(payload, "friends", &unread),
        incoming: list(payload, "incoming", &unread),
        outgoing: list(payload, "outgoing", &unread),
        unread,
        groups: payload
            .get("groups")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(parse_group).collect())
            .unwrap_or_default(),
        server: identity.server.clone(),
    }
}

fn parse_group(value: &Value) -> Option<GroupView> {
    Some(GroupView {
        id: value.get("id").and_then(Value::as_i64)?,
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("Gruppe")
            .to_string(),
        owner: value
            .get("owner")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        members: value
            .get("members")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| {
                        Some(GroupMember {
                            uuid: item.get("uuid").and_then(Value::as_str)?.to_string(),
                            name: item
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or("?")
                                .to_string(),
                            status: item
                                .get("status")
                                .and_then(Value::as_str)
                                .unwrap_or("offline")
                                .to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
        member_count: value
            .get("memberCount")
            .and_then(Value::as_u64)
            .unwrap_or(0) as u32,
        unread: value.get("unread").and_then(Value::as_u64).unwrap_or(0) as u32,
        last: value
            .get("last")
            .filter(|item| !item.is_null())
            .map(|item| GroupPreview {
                id: item.get("id").and_then(Value::as_i64).unwrap_or(0),
                from: item
                    .get("from")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                from_name: item
                    .get("fromName")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                body: item
                    .get("body")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                kind: item
                    .get("kind")
                    .and_then(Value::as_str)
                    .unwrap_or("text")
                    .to_string(),
                sent_at: item
                    .get("sentAt")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                edited: item.get("edited").and_then(Value::as_bool).unwrap_or(false),
            }),
    })
}

fn parse_messages(payload: &Value) -> FriendsThread {
    let items = payload
        .get("messages")
        .or_else(|| payload.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let messages: Vec<ChatMessage> = items
        .iter()
        .map(|item| ChatMessage {
            id: item.get("id").and_then(Value::as_i64).unwrap_or(0),
            from: item
                .get("from")
                .or_else(|| item.get("sender"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            from_name: item
                .get("fromName")
                .or_else(|| item.get("from_name"))
                .and_then(Value::as_str)
                .map(str::to_string),
            body: item
                .get("body")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            kind: item
                .get("kind")
                .and_then(Value::as_str)
                .unwrap_or("text")
                .to_string(),
            sent_at: item
                .get("sentAt")
                .or_else(|| item.get("sent_at"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            edited: item.get("edited").and_then(Value::as_bool).unwrap_or(false),
        })
        .collect();
    let last = payload
        .get("last")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| messages.last().map(|message| message.id).unwrap_or(0));
    let typing = payload.get("typing").and_then(Value::as_bool).unwrap_or(false);
    FriendsThread {
        messages,
        last,
        typing,
    }
}

/// Friend list, open requests and unread counters; also acts as heartbeat.
#[tauri::command]
pub async fn friends_overview(state: State<'_, AppState>) -> Result<FriendsSnapshot> {
    let identity = identity(&state).await?;
    // Presence is best effort: a failure must not hide the friend list. The
    // state comes from the friends tab (online / away / offline).
    let presence = if identity.presence.is_empty() {
        "online"
    } else {
        identity.presence.as_str()
    };
    let _ = api::presence(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        presence,
        None,
    )
    .await;
    let payload = api::overview(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
    )
    .await?;
    Ok(parse_overview(&identity, &payload))
}

/// Sends a friend request to a player name.
#[tauri::command]
pub async fn friends_request(state: State<'_, AppState>, name: String) -> Result<()> {
    let name = sanitize_name(&name)
        .ok_or_else(|| LauncherError::Invalid("Bitte einen Spielernamen eingeben.".into()))?;
    let identity = identity(&state).await?;
    api::friend_request(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        &name,
    )
    .await
}

#[tauri::command]
pub async fn friends_accept(state: State<'_, AppState>, uuid: String) -> Result<()> {
    let other = api::dashed_uuid(&uuid)
        .ok_or_else(|| LauncherError::Invalid("Ungültige Spieler-UUID.".into()))?;
    let identity = identity(&state).await?;
    api::friend_accept(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        &other,
    )
    .await
}

/// Unfriends a player or declines/cancels a request.
#[tauri::command]
pub async fn friends_remove(state: State<'_, AppState>, uuid: String) -> Result<()> {
    let other = api::dashed_uuid(&uuid)
        .ok_or_else(|| LauncherError::Invalid("Ungültige Spieler-UUID.".into()))?;
    let identity = identity(&state).await?;
    api::friend_remove(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        &other,
    )
    .await
}

#[tauri::command]
pub async fn friends_send(
    state: State<'_, AppState>,
    uuid: String,
    body: String,
) -> Result<()> {
    let other = api::dashed_uuid(&uuid)
        .ok_or_else(|| LauncherError::Invalid("Ungültige Spieler-UUID.".into()))?;
    let text = message_body(&body)?;
    let identity = identity(&state).await?;
    api::send_message(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        &other,
        &text,
    )
    .await
}

/// Tells the server the player is writing to a friend.
#[tauri::command]
pub async fn friends_typing(state: State<'_, AppState>, uuid: String) -> Result<()> {
    let other = api::dashed_uuid(&uuid)
        .ok_or_else(|| LauncherError::Invalid("Ungültige Spieler-UUID.".into()))?;
    let identity = identity(&state).await?;
    api::typing(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        &other,
    )
    .await
}

/// Rewrites one of the player's own messages.
#[tauri::command]
pub async fn friends_edit(
    state: State<'_, AppState>,
    uuid: String,
    id: i64,
    body: String,
) -> Result<()> {
    api::dashed_uuid(&uuid)
        .ok_or_else(|| LauncherError::Invalid("Ungültige Spieler-UUID.".into()))?;
    let text = message_body(&body)?;
    let identity = identity(&state).await?;
    api::edit_message(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        id,
        &text,
    )
    .await
}

/// Deletes one of the player's own messages for both sides.
#[tauri::command]
pub async fn friends_delete(state: State<'_, AppState>, uuid: String, id: i64) -> Result<()> {
    api::dashed_uuid(&uuid)
        .ok_or_else(|| LauncherError::Invalid("Ungültige Spieler-UUID.".into()))?;
    let identity = identity(&state).await?;
    api::delete_message(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        id,
    )
    .await
}

/// Remembers the availability and pushes it to the server.
#[tauri::command]
pub async fn friends_set_status(state: State<'_, AppState>, status: String) -> Result<()> {
    let presence = match status.as_str() {
        "away" => "away",
        "offline" => "offline",
        _ => "online",
    };
    let identity = identity(&state).await?;
    FriendsDb::new(&state.paths.data_dir).set_presence(&identity.uuid, &identity.server, presence)?;
    api::presence(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        presence,
        None,
    )
    .await
}

/// One conversation; `since` is the last message id already shown.
#[tauri::command]
pub async fn friends_messages(
    state: State<'_, AppState>,
    uuid: String,
    since: Option<i64>,
) -> Result<FriendsThread> {
    let other = api::dashed_uuid(&uuid)
        .ok_or_else(|| LauncherError::Invalid("Ungültige Spieler-UUID.".into()))?;
    let identity = identity(&state).await?;
    let payload = api::messages(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        &other,
        since.unwrap_or(0).max(0),
    )
    .await?;
    Ok(parse_messages(&payload))
}

// --- Group chats -------------------------------------------------------

/// Groups the player is part of (the overview already carries them).
#[tauri::command]
pub async fn friends_groups(state: State<'_, AppState>) -> Result<Vec<GroupView>> {
    let identity = identity(&state).await?;
    let payload = api::groups(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
    )
    .await?;
    Ok(payload
        .get("groups")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(parse_group).collect())
        .unwrap_or_default())
}

/// Creates a group with at least one friend and returns it.
#[tauri::command]
pub async fn friends_group_create(
    state: State<'_, AppState>,
    name: Option<String>,
    members: Vec<String>,
) -> Result<GroupView> {
    let identity = identity(&state).await?;
    let uuids: Vec<String> = members
        .iter()
        .filter_map(|value| api::dashed_uuid(value))
        .collect();
    if uuids.is_empty() {
        return Err(LauncherError::Invalid(
            "Wähle mindestens einen Freund für die Gruppe.".into(),
        ));
    }
    let clean_name = name
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.trim().chars().take(32).collect::<String>());
    let payload = api::group_create(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        clean_name.as_deref(),
        &uuids,
    )
    .await?;
    payload.get("group").and_then(parse_group).ok_or_else(|| {
        LauncherError::Message("Die Gruppe konnte nicht angelegt werden.".into())
    })
}

/// Leaves a group; the server deletes it once the last member is gone.
#[tauri::command]
pub async fn friends_group_leave(state: State<'_, AppState>, id: i64) -> Result<()> {
    let identity = identity(&state).await?;
    api::group_leave(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        id,
    )
    .await
}

/// One group conversation; `since` is the last message id already shown.
#[tauri::command]
pub async fn friends_group_messages(
    state: State<'_, AppState>,
    id: i64,
    since: Option<i64>,
) -> Result<GroupThread> {
    let identity = identity(&state).await?;
    let payload = api::group_messages(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        id,
        since.unwrap_or(0).max(0),
    )
    .await?;
    let messages = parse_messages(&payload).messages;
    let last = payload
        .get("last")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| messages.last().map(|message| message.id).unwrap_or(0));
    let typing = payload
        .get("typing")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok(GroupThread {
        messages,
        last,
        typing,
    })
}

/// Sends a message (text, image or GIF) into a group.
#[tauri::command]
pub async fn friends_group_send(
    state: State<'_, AppState>,
    id: i64,
    body: String,
) -> Result<()> {
    let text = message_body(&body)?;
    let identity = identity(&state).await?;
    api::group_send(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        id,
        &text,
    )
    .await
}

/// Announces that the player is writing in a group.
#[tauri::command]
pub async fn friends_group_typing(state: State<'_, AppState>, id: i64) -> Result<()> {
    let identity = identity(&state).await?;
    api::group_typing(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        id,
    )
    .await
}

/// Rewrites one of the player's own group messages.
#[tauri::command]
pub async fn friends_group_edit(
    state: State<'_, AppState>,
    id: i64,
    body: String,
) -> Result<()> {
    let text = message_body(&body)?;
    let identity = identity(&state).await?;
    api::group_edit(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        id,
        &text,
    )
    .await
}

/// Deletes one of the player's own group messages.
#[tauri::command]
pub async fn friends_group_delete(state: State<'_, AppState>, id: i64) -> Result<()> {
    let identity = identity(&state).await?;
    api::group_delete(
        &state.http,
        &identity.server,
        &identity.uuid,
        &identity.secret,
        id,
    )
    .await
}
