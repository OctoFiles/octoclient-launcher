//! Microsoft account commands.
//!
//! `auth_begin_login` requests a device code and starts a background poll loop.
//! Progress is pushed to the UI through the `auth://changed` event, so the
//! modal never has to poll the backend itself.

use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::auth::{microsoft, AuthManager, AuthSnapshot, PendingLogin, PendingStatus};
use crate::config::LauncherConfig;
use crate::error::{LauncherError, Result};
use crate::state::AppState;

/// Client id precedence: explicit argument → settings → env → built-in app.
/// Public so the background refresh task in `lib.rs` uses the same resolution.
pub fn resolve_client_id(config: &LauncherConfig, override_id: Option<String>) -> String {
    override_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| config.integrations.ms_client_id.clone())
        .or_else(|| {
            std::env::var("FROST_MS_CLIENT_ID")
                .ok()
                .filter(|value| !value.trim().is_empty())
        })
        .unwrap_or_else(|| microsoft::DEFAULT_CLIENT_ID.to_string())
}

fn emit(auth: &AuthManager, app: &AppHandle) {
    let _ = app.emit("auth://changed", auth.snapshot());
}

#[tauri::command]
pub fn auth_current(state: State<'_, AppState>) -> AuthSnapshot {
    state.auth.snapshot()
}

#[tauri::command]
pub async fn auth_begin_login(
    app: AppHandle,
    state: State<'_, AppState>,
    client_id: Option<String>,
) -> Result<PendingLogin> {
    let client_id = resolve_client_id(&state.config(), client_id);
    let pending = state.auth.begin(client_id).await?;
    emit(&state.auth, &app);

    let auth = state.auth.clone();
    let http = state.http.clone();
    let task_app = app.clone();

    tauri::async_runtime::spawn(async move {
        loop {
            let Some((client_id, device_code, interval)) = auth.pending_target() else {
                break;
            };
            if auth.pending_expired() {
                auth.set_pending_status(PendingStatus::Expired, None);
                emit(&auth, &task_app);
                break;
            }

            tokio::time::sleep(Duration::from_secs(interval)).await;

            // The user may have cancelled while we were waiting.
            if auth.pending_target().is_none() {
                break;
            }

            match microsoft::poll_device_token(&http, &client_id, &device_code).await {
                Ok(microsoft::TokenPoll::Token(tokens)) => {
                    match auth.complete_login(tokens).await {
                        Ok(_) => emit(&auth, &task_app),
                        Err(err) => {
                            auth.set_pending_status(PendingStatus::Error, Some(err.to_string()));
                            emit(&auth, &task_app);
                        }
                    }
                    break;
                }
                Ok(microsoft::TokenPoll::Pending) => continue,
                Ok(microsoft::TokenPoll::SlowDown) => {
                    auth.bump_interval();
                    continue;
                }
                Ok(microsoft::TokenPoll::Expired) => {
                    auth.set_pending_status(PendingStatus::Expired, None);
                    emit(&auth, &task_app);
                    break;
                }
                Err(err) => {
                    auth.set_pending_status(PendingStatus::Error, Some(err.to_string()));
                    emit(&auth, &task_app);
                    break;
                }
            }
        }
    });

    Ok(pending)
}

#[tauri::command]
pub fn auth_cancel_login(app: AppHandle, state: State<'_, AppState>) -> AuthSnapshot {
    state.auth.cancel();
    let snapshot = state.auth.snapshot();
    let _ = app.emit("auth://changed", snapshot.clone());
    snapshot
}

#[tauri::command]
pub async fn auth_switch(
    app: AppHandle,
    state: State<'_, AppState>,
    uuid: String,
    client_id: Option<String>,
) -> Result<AuthSnapshot> {
    state.auth.switch_account(&uuid)?;
    // Renew the token of the newly active account if it is about to expire.
    // A failed refresh keeps the account selected; the next launch retries.
    let client = resolve_client_id(&state.config(), client_id);
    let _ = state.auth.refresh_if_needed(&client, 120).await;
    let snapshot = state.auth.snapshot();
    emit(&state.auth, &app);
    Ok(snapshot)
}

#[tauri::command]
pub fn auth_remove(app: AppHandle, state: State<'_, AppState>, uuid: String) -> Result<AuthSnapshot> {
    state.auth.remove_account(&uuid)?;
    let snapshot = state.auth.snapshot();
    let _ = app.emit("auth://changed", snapshot.clone());
    Ok(snapshot)
}

/// Opens the Microsoft verification page in a popup window inside the launcher.
///
/// Must stay `async`: on Windows `WebviewWindowBuilder::build` deadlocks when it
/// runs inside a synchronous command, which is exactly what left the popup white
/// before (see tauri-apps/tauri#13092).
#[tauri::command]
pub async fn open_auth_popup(app: AppHandle, url: String) -> Result<()> {
    let trimmed = url.trim().to_string();
    if !trimmed.starts_with("https://") {
        return Err(LauncherError::Invalid(
            "Nur HTTPS-Adressen sind für die Anmeldung erlaubt.".into(),
        ));
    }
    let parsed = trimmed
        .parse()
        .map_err(|_| LauncherError::Invalid("Ungültige Anmelde-URL.".into()))?;

    if let Some(window) = app.get_webview_window("auth-popup") {
        // A previous attempt may have loaded nothing — navigate again instead of
        // only showing the stale (white) window.
        window
            .navigate(parsed)
            .map_err(|error| LauncherError::Message(error.to_string()))?;
        let _ = window.show();
        let _ = window.set_focus();
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, "auth-popup", WebviewUrl::External(parsed))
        .title("Microsoft-Anmeldung · OctoClient")
        .inner_size(540.0, 780.0)
        .center()
        .focused(true)
        .build()
        .map_err(|error| LauncherError::Message(error.to_string()))?;
    Ok(())
}

#[tauri::command]
pub fn auth_sign_out(app: AppHandle, state: State<'_, AppState>) -> AuthSnapshot {
    state.auth.sign_out();
    let snapshot = state.auth.snapshot();
    let _ = app.emit("auth://changed", snapshot.clone());
    snapshot
}

#[tauri::command]
pub async fn auth_refresh(
    app: AppHandle,
    state: State<'_, AppState>,
    client_id: Option<String>,
) -> Result<AuthSnapshot> {
    let client_id = resolve_client_id(&state.config(), client_id);
    state.auth.refresh(client_id).await?;
    let snapshot = state.auth.snapshot();
    emit(&state.auth, &app);
    Ok(snapshot)
}
