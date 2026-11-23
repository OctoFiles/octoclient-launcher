//! Microsoft identity platform — OAuth 2.0 device code flow.
//!
//! Endpoints: `login.microsoftonline.com/consumers/oauth2/v2.0`.
//! The client id is a **public** client (no secret). The built-in default is the
//! OctoClient Azure app (public client, device code enabled, personal Microsoft
//! accounts). Any other app can be used by setting `integrations.msClientId` or
//! the `FROST_MS_CLIENT_ID` env var (kept for compatibility).

use serde::Deserialize;

use crate::error::{LauncherError, Result};

/// Public Azure AD application id (UUID form) used for the Microsoft login.
/// Override with `integrations.msClientId` or `FROST_MS_CLIENT_ID`.
pub const DEFAULT_CLIENT_ID: &str = "e16699bb-2aa8-46da-b5e3-45cbcce29091";

const DEVICE_CODE_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode";
const TOKEN_URL: &str = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const SCOPE: &str = "XboxLive.signin offline_access";

#[derive(Debug, Clone, Deserialize)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    #[serde(default = "default_interval")]
    pub interval: u64,
    #[serde(default)]
    pub message: String,
}

fn default_interval() -> u64 {
    5
}

#[derive(Debug, Clone, Deserialize)]
pub struct TokenSet {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: Option<String>,
    #[serde(default)]
    pub expires_in: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
struct OAuthErrorBody {
    #[serde(default)]
    error: String,
    #[serde(default)]
    error_description: Option<String>,
}

/// Result of one device-code token poll.
pub enum TokenPoll {
    Token(TokenSet),
    Pending,
    SlowDown,
    Expired,
}

pub async fn request_device_code(http: &reqwest::Client, client_id: &str) -> Result<DeviceCode> {
    let response = http
        .post(DEVICE_CODE_URL)
        .form(&[("client_id", client_id), ("scope", SCOPE)])
        .send()
        .await?;

    let status = response.status();
    let body = response.text().await?;

    if !status.is_success() {
        return Err(LauncherError::Auth(format!(
            "Microsoft hat die Geräte-Anmeldung abgelehnt ({}). {}",
            status.as_u16(),
            describe(&body)
        )));
    }

    serde_json::from_str::<DeviceCode>(&body).map_err(|_| {
        LauncherError::Auth("Microsoft lieferte eine unerwartete Antwort auf die Geräte-Anmeldung.".into())
    })
}

pub async fn poll_device_token(
    http: &reqwest::Client,
    client_id: &str,
    device_code: &str,
) -> Result<TokenPoll> {
    let response = http
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ("device_code", device_code),
        ])
        .send()
        .await?;

    let status = response.status();
    let body = response.text().await?;

    if status.is_success() {
        let tokens: TokenSet = serde_json::from_str(&body).map_err(|_| {
            LauncherError::Auth("Microsoft lieferte eine unerwartete Token-Antwort.".into())
        })?;
        return Ok(TokenPoll::Token(tokens));
    }

    let error: OAuthErrorBody = serde_json::from_str(&body).unwrap_or(OAuthErrorBody {
        error: String::new(),
        error_description: None,
    });

    match error.error.as_str() {
        "authorization_pending" => Ok(TokenPoll::Pending),
        "slow_down" => Ok(TokenPoll::SlowDown),
        "expired_token" | "code_expired" | "bad_verification_code" => Ok(TokenPoll::Expired),
        "authorization_declined" | "access_denied" => Err(LauncherError::Auth(
            "Die Anmeldung wurde im Microsoft-Fenster abgebrochen.".into(),
        )),
        other => Err(LauncherError::Auth(format!(
            "Microsoft-Anmeldung fehlgeschlagen ({}). {}",
            if other.is_empty() { "unbekannt" } else { other },
            error.error_description.unwrap_or_default()
        ))),
    }
}

pub async fn refresh_access_token(
    http: &reqwest::Client,
    client_id: &str,
    refresh_token: &str,
) -> Result<TokenSet> {
    let response = http
        .post(TOKEN_URL)
        .form(&[
            ("client_id", client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("scope", SCOPE),
        ])
        .send()
        .await?;

    let status = response.status();
    let body = response.text().await?;

    if !status.is_success() {
        // `invalid_grant` means the refresh token itself is no longer accepted
        // (revoked, password changed, …). Only then does the user have to sign in
        // again; every other failure is transient and may be retried later.
        let rejected = serde_json::from_str::<OAuthErrorBody>(&body)
            .ok()
            .is_some_and(|error| {
                matches!(
                    error.error.as_str(),
                    "invalid_grant" | "interaction_required" | "consent_required"
                )
            });
        if rejected {
            return Err(LauncherError::SessionExpired);
        }
        return Err(LauncherError::Auth(format!(
            "Sitzung konnte nicht erneuert werden ({}). {}",
            status.as_u16(),
            describe(&body)
        )));
    }

    serde_json::from_str(&body).map_err(|_| {
        LauncherError::Auth("Microsoft lieferte eine unerwartete Token-Antwort.".into())
    })
}

fn describe(body: &str) -> String {
    serde_json::from_str::<OAuthErrorBody>(body)
        .ok()
        .and_then(|error| error.error_description)
        .unwrap_or_else(|| "Bitte erneut versuchen.".into())
}
