//! Skin lookup by Minecraft name or UUID.
//!
//! The official Minecraft profile endpoints are used: the name lookup resolves
//! a name to its account id, the session server returns the signed texture
//! property and the skin PNG is downloaded once and handed to the UI as a data
//! URL. No account credentials are needed for this lookup.

use base64::Engine as _;
use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{LauncherError, Result};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedSkin {
    pub name: String,
    pub uuid: String,
    /// 64×64 (or legacy 64×32) skin PNG as data URL.
    pub skin_data_url: String,
    /// `classic` or `slim`.
    pub model: String,
    pub source: String,
}

#[derive(Debug, Deserialize)]
struct NameLookup {
    id: String,
    name: String,
}

#[derive(Debug, Deserialize)]
struct Profile {
    name: String,
    #[serde(default)]
    properties: Vec<ProfileProperty>,
}

#[derive(Debug, Deserialize)]
struct ProfileProperty {
    name: String,
    value: String,
}

/// Accepts dashed and undashed UUIDs and returns the plain lowercase hex id.
fn normalize_uuid(input: &str) -> Option<String> {
    let hex: String = input.chars().filter(|character| *character != '-').collect();
    if hex.len() == 32 && hex.chars().all(|character| character.is_ascii_hexdigit()) {
        Some(hex.to_ascii_lowercase())
    } else {
        None
    }
}

fn dashed_uuid(hex: &str) -> String {
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn valid_username(input: &str) -> bool {
    let length = input.chars().count();
    (3..=16).contains(&length)
        && input
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

#[tauri::command]
pub async fn resolve_minecraft_skin(
    state: State<'_, AppState>,
    query: String,
) -> Result<ResolvedSkin> {
    resolve(&state.http, &query).await
}

async fn resolve(http: &reqwest::Client, query: &str) -> Result<ResolvedSkin> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err(LauncherError::Invalid(
            "Gib einen Minecraft-Namen oder eine UUID ein.".into(),
        ));
    }

    // Resolve the account id: a UUID is used directly, a name goes through the
    // public Minecraft Services lookup (api.mojang.com is blocked in some
    // networks, minecraftservices is the endpoint the game itself uses).
    let (account_id, resolved_name) = if let Some(hex) = normalize_uuid(trimmed) {
        (hex, None)
    } else {
        if !valid_username(trimmed) {
            return Err(LauncherError::Invalid(
                "Minecraft-Namen haben 3 bis 16 Zeichen (Buchstaben, Zahlen, _).".into(),
            ));
        }
        let response = http
            .get(format!(
                "https://api.minecraftservices.com/minecraft/profile/lookup/name/{trimmed}"
            ))
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(LauncherError::Invalid(format!(
                "Kein Minecraft-Konto mit dem Namen „{trimmed}“ gefunden."
            )));
        }
        let lookup: NameLookup = response.json().await?;
        (lookup.id.to_ascii_lowercase(), Some(lookup.name))
    };

    if normalize_uuid(&account_id).is_none() {
        return Err(LauncherError::Message(
            "Mojang hat eine ungültige Profil-ID zurückgegeben.".into(),
        ));
    }

    let response = http
        .get(format!(
            "https://sessionserver.mojang.com/session/minecraft/profile/{account_id}"
        ))
        .send()
        .await?;
    if response.status() == reqwest::StatusCode::NO_CONTENT || !response.status().is_success() {
        return Err(LauncherError::Invalid(
            "Für dieses Profil ist kein Skin hinterlegt.".into(),
        ));
    }
    let profile: Profile = response.json().await?;

    let textures = profile
        .properties
        .iter()
        .find(|property| property.name == "textures")
        .ok_or_else(|| LauncherError::Invalid("Das Profil enthält keine Skin-Daten.".into()))?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(textures.value.as_bytes())
        .map_err(|_| LauncherError::Message("Die Skin-Daten konnten nicht gelesen werden.".into()))?;
    let payload: serde_json::Value = serde_json::from_slice(&decoded)
        .map_err(|_| LauncherError::Message("Die Skin-Daten sind beschädigt.".into()))?;
    let skin = payload
        .pointer("/textures/SKIN")
        .ok_or_else(|| LauncherError::Invalid("Dieses Profil hat keinen Skin.".into()))?;
    let skin_url = skin
        .get("url")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| LauncherError::Invalid("Dieses Profil hat keinen Skin.".into()))?;
    let model = skin
        .pointer("/metadata/model")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("classic")
        .to_string();

    let bytes = http
        .get(skin_url)
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;
    if bytes.len() < 64 {
        return Err(LauncherError::Invalid(
            "Der Skin konnte nicht heruntergeladen werden.".into(),
        ));
    }

    Ok(ResolvedSkin {
        name: resolved_name.unwrap_or(profile.name),
        uuid: dashed_uuid(&account_id),
        skin_data_url: format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ),
        model,
        source: "mojang".into(),
    })
}

/// Uploads a PNG skin to the signed-in Minecraft account (Mojang skin API).
///
/// `model` is `classic` or `slim`; both the texture and the arm width change,
/// so the next game start uses exactly the skin shown in the launcher.
#[tauri::command]
pub async fn apply_minecraft_skin(
    state: State<'_, AppState>,
    data_url: String,
    model: String,
) -> Result<()> {
    let token = state
        .auth
        .access_token()
        .ok_or(LauncherError::NotSignedIn)?;
    let payload = data_url
        .strip_prefix("data:image/png;base64,")
        .ok_or_else(|| LauncherError::Invalid("Der Skin ist kein PNG.".into()))?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.as_bytes())
        .map_err(|_| LauncherError::Invalid("Der Skin konnte nicht gelesen werden.".into()))?;
    if bytes.len() < 64 || !bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err(LauncherError::Invalid("Die Skin-Datei ist kein gültiges PNG.".into()));
    }

    let variant = if model.eq_ignore_ascii_case("slim") {
        "slim"
    } else {
        "classic"
    };
    let part = Part::bytes(bytes)
        .file_name("skin.png")
        .mime_str("image/png")
        .map_err(|error| LauncherError::Message(error.to_string()))?;
    let form = Form::new().text("variant", variant).part("file", part);

    let response = state
        .http
        .post("https://api.minecraftservices.com/minecraft/profile/skins")
        .bearer_auth(token)
        .multipart(form)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(LauncherError::Auth(format!(
            "Minecraft hat den Skin abgelehnt ({status}). {}",
            detail.trim()
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_dashed_and_undashed_uuids() {
        let plain = "069a79f444e94726a5befca90e38aaf5";
        assert_eq!(normalize_uuid(plain).as_deref(), Some(plain));
        assert_eq!(
            normalize_uuid("069a79f4-44e9-4726-a5be-fca90e38aaf5").as_deref(),
            Some(plain)
        );
        assert_eq!(normalize_uuid("Notch"), None);
        assert_eq!(normalize_uuid("1234"), None);
        assert_eq!(
            dashed_uuid(plain),
            "069a79f4-44e9-4726-a5be-fca90e38aaf5"
        );
    }

    #[test]
    fn validates_minecraft_names() {
        assert!(valid_username("Notch"));
        assert!(valid_username("a_b1"));
        assert!(!valid_username("ab"));
        assert!(!valid_username("name with space"));
        assert!(!valid_username("12345678901234567"));
    }

    #[test]
    #[ignore = "network: resolves a live Mojang skin for Notch"]
    fn resolves_a_live_skin() {
        let http = reqwest::Client::builder()
            .user_agent("OctoClientLauncher/0.1.0")
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("client");
        let skin = tauri::async_runtime::block_on(resolve(&http, "Notch"))
            .expect("skin resolved");
        assert_eq!(skin.name, "Notch");
        assert_eq!(skin.uuid, "069a79f4-44e9-4726-a5be-fca90e38aaf5");
        assert!(skin.skin_data_url.starts_with("data:image/png;base64,"));
        assert!(skin.skin_data_url.len() > 500);
    }
}
