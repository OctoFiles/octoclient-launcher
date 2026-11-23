//! Xbox Live → XSTS → Minecraft Services handshake.
//!
//! Reference: https://minecraft.wiki/w/Microsoft_authentication

use serde::Deserialize;
use serde_json::json;

use crate::error::{LauncherError, Result};

const XBL_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MC_LOGIN_URL: &str = "https://api.minecraftservices.com/authentication/login_with_xbox";
const MC_PROFILE_URL: &str = "https://api.minecraftservices.com/minecraft/profile";

#[derive(Debug, Clone)]
pub struct XboxTicket {
    pub user_hash: String,
    pub xsts_token: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MinecraftAuth {
    pub access_token: String,
    #[serde(default = "default_expiry")]
    pub expires_in: u64,
}

fn default_expiry() -> u64 {
    86_400
}

#[derive(Debug, Clone, Deserialize)]
pub struct MinecraftProfile {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub skins: Vec<SkinEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SkinEntry {
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub state: String,
}

impl MinecraftProfile {
    pub fn skin_url(&self) -> Option<&str> {
        self.skins
            .iter()
            .find(|skin| skin.state.is_empty() || skin.state == "ACTIVE")
            .or_else(|| self.skins.first())
            .map(|skin| skin.url.as_str())
            .filter(|url| !url.is_empty())
    }
}

#[derive(Debug, Deserialize)]
struct XblResponse {
    #[serde(rename = "Token")]
    token: String,
    #[serde(rename = "DisplayClaims")]
    claims: Claims,
}

#[derive(Debug, Deserialize)]
struct Claims {
    #[serde(default)]
    xui: Vec<Xui>,
}

#[derive(Debug, Deserialize)]
struct Xui {
    #[serde(default)]
    uhs: String,
}

#[derive(Debug, Deserialize)]
struct XstsError {
    #[serde(rename = "XErr", default)]
    xerr: Option<i64>,
    #[serde(rename = "Message", default)]
    message: Option<String>,
}

/// Runs Xbox Live authentication followed by XSTS authorization.
pub async fn authenticate(http: &reqwest::Client, msa_access_token: &str) -> Result<XboxTicket> {
    let xbl_response = http
        .post(XBL_URL)
        .header("Accept", "application/json")
        .json(&json!({
            "Properties": {
                "AuthMethod": "RPS",
                "SiteName": "user.auth.xboxlive.com",
                "RpsTicket": format!("d={msa_access_token}")
            },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT"
        }))
        .send()
        .await?;

    let status = xbl_response.status();
    let body = xbl_response.text().await?;
    if !status.is_success() {
        return Err(LauncherError::Auth(format!(
            "Xbox Live hat die Anmeldung abgelehnt ({}). Prüfe, ob dein Microsoft-Konto für Xbox Live freigeschaltet ist.",
            status.as_u16()
        )));
    }
    let xbl: XblResponse = serde_json::from_str(&body)
        .map_err(|_| LauncherError::Auth("Xbox Live lieferte eine unerwartete Antwort.".into()))?;
    let user_hash = xbl
        .claims
        .xui
        .first()
        .map(|xui| xui.uhs.clone())
        .filter(|uhs| !uhs.is_empty())
        .ok_or_else(|| LauncherError::Auth("Xbox Live lieferte keinen User-Hash.".into()))?;

    let xsts_response = http
        .post(XSTS_URL)
        .header("Accept", "application/json")
        .json(&json!({
            "Properties": {
                "SandboxId": "RETAIL",
                "UserTokens": [xbl.token]
            },
            "RelyingParty": "rp://api.minecraftservices.com/",
            "TokenType": "JWT"
        }))
        .send()
        .await?;

    let status = xsts_response.status();
    let body = xsts_response.text().await?;

    if status == reqwest::StatusCode::UNAUTHORIZED {
        let error: XstsError = serde_json::from_str(&body).unwrap_or(XstsError {
            xerr: None,
            message: None,
        });
        return Err(LauncherError::Auth(xsts_message(
            error.xerr,
            error.message.as_deref(),
        )));
    }
    if !status.is_success() {
        return Err(LauncherError::Auth(format!(
            "XSTS hat die Anmeldung abgelehnt ({}).",
            status.as_u16()
        )));
    }

    let xsts: XblResponse = serde_json::from_str(&body)
        .map_err(|_| LauncherError::Auth("XSTS lieferte eine unerwartete Antwort.".into()))?;
    let user_hash = xsts
        .claims
        .xui
        .first()
        .map(|xui| xui.uhs.clone())
        .unwrap_or(user_hash);

    Ok(XboxTicket {
        user_hash,
        xsts_token: xsts.token,
    })
}

fn xsts_message(xerr: Option<i64>, detail: Option<&str>) -> String {
    let base = match xerr {
        Some(2148916233) => {
            "Dieses Microsoft-Konto hat noch kein Xbox-Live-Profil. Erstelle es einmalig auf xbox.com und versuche es erneut."
        }
        Some(2148916235) => {
            "Xbox Live ist in der Region dieses Kontos nicht verfügbar. Ein VPN kann die Anmeldung nicht umgehen."
        }
        Some(2148916236) | Some(2148916237) => {
            "Dieses Konto benötigt eine zusätzliche Bestätigung durch einen Erwachsenen im Microsoft-Konto."
        }
        Some(2148916238) => {
            "Dieses Konto ist als Kinderkonto registriert und darf Minecraft nicht ohne Zustimmung starten."
        }
        Some(2148916227) => "Dieses Xbox-Konto wurde gesperrt.",
        _ => "XSTS hat die Anmeldung abgelehnt.",
    };
    match (xerr, detail) {
        (Some(code), Some(message)) if !message.is_empty() => {
            format!("{base} (XErr {code}: {message})")
        }
        (Some(code), _) => format!("{base} (XErr {code})"),
        (None, Some(message)) if !message.is_empty() => format!("{base} ({message})"),
        _ => base.to_string(),
    }
}

/// Exchanges the XSTS token for a Minecraft access token.
pub async fn login_with_xbox(http: &reqwest::Client, ticket: &XboxTicket) -> Result<MinecraftAuth> {
    let response = http
        .post(MC_LOGIN_URL)
        .header("Accept", "application/json")
        .json(&json!({
            "identityToken": format!("XBL3.0 x={};{}", ticket.user_hash, ticket.xsts_token)
        }))
        .send()
        .await?;

    let status = response.status();
    let body = response.text().await?;

    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err(LauncherError::Auth(
            "Minecraft Services hat die Sitzung abgelehnt. Bitte melde dich erneut an.".into(),
        ));
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(LauncherError::Auth(
            "Minecraft Services drosselt gerade Anfragen. Bitte in einigen Minuten erneut anmelden."
                .into(),
        ));
    }
    if !status.is_success() {
        return Err(LauncherError::Auth(format!(
            "Minecraft Services antwortete mit HTTP {}.",
            status.as_u16()
        )));
    }

    serde_json::from_str::<MinecraftAuth>(&body).map_err(|_| {
        LauncherError::Auth("Minecraft Services lieferte eine unerwartete Token-Antwort.".into())
    })
}

/// Loads the Minecraft profile (name, UUID, skins).
pub async fn fetch_profile(
    http: &reqwest::Client,
    access_token: &str,
) -> Result<MinecraftProfile> {
    let response = http
        .get(MC_PROFILE_URL)
        .bearer_auth(access_token)
        .header("Accept", "application/json")
        .send()
        .await?;

    let status = response.status();
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err(LauncherError::Auth(
            "Für dieses Microsoft-Konto ist kein Minecraft (Java Edition) hinterlegt.".into(),
        ));
    }
    if !status.is_success() {
        return Err(LauncherError::Auth(format!(
            "Minecraft-Profil konnte nicht geladen werden (HTTP {}).",
            status.as_u16()
        )));
    }

    response
        .json::<MinecraftProfile>()
        .await
        .map_err(|_| LauncherError::Auth("Minecraft-Profil war unvollständig.".into()))
}
