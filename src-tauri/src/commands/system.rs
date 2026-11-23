//! System information and Java detection.

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::error::{LauncherError, Result};
use crate::launcher::{self, InstalledVersion, JavaInfo};
use crate::state::AppState;

use super::{active_instance_dir, resolve_game_dir};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os: String,
    pub arch: String,
    pub app_version: String,
    pub total_memory_mb: u64,
    pub config_dir: String,
    pub data_dir: String,
    pub config_file: String,
    pub default_game_dir: String,
    pub game_dir: String,
    pub java: Option<JavaInfo>,
    pub installed_versions: Vec<InstalledVersion>,
}

#[tauri::command]
pub fn system_info(app: AppHandle, state: State<'_, AppState>) -> Result<SystemInfo> {
    let config = state.config();
    let default_game_dir = resolve_game_dir(&app, &config);
    let game_dir = active_instance_dir(&app, &state, &config)
        .map(|(_, dir)| dir)
        .unwrap_or_else(|_| default_game_dir.clone());

    let mut system = sysinfo::System::new();
    system.refresh_memory();
    let java = state
        .java(&config)
        .or_else(|| launcher::detect_runtime_java(&game_dir));

    Ok(SystemInfo {
        os: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: app.package_info().version.to_string(),
        total_memory_mb: system.total_memory() / 1024 / 1024,
        config_dir: state.paths.config_dir.to_string_lossy().to_string(),
        data_dir: state.paths.data_dir.to_string_lossy().to_string(),
        config_file: state.paths.config_file.to_string_lossy().to_string(),
        default_game_dir: default_game_dir.to_string_lossy().to_string(),
        game_dir: game_dir.to_string_lossy().to_string(),
        java,
        installed_versions: launcher::scan_versions(&game_dir),
    })
}

#[tauri::command]
pub fn detect_java(
    app: AppHandle,
    state: State<'_, AppState>,
    path: Option<String>,
) -> Option<JavaInfo> {
    // Without a path this is a full automatic scan. The configured path is not
    // used as a hidden hint, so a stale entry can no longer win over a real
    // installation found on the system.
    let hint = path.filter(|value| !value.trim().is_empty());
    let mut info = launcher::detect_java(hint.as_deref());

    // A machine without a system JDK still has the Mojang runtime the launcher
    // downloaded into the active instance.
    if info.is_none() && hint.is_none() {
        let config = state.config();
        if let Ok((_, dir)) = active_instance_dir(&app, &state, &config) {
            info = launcher::detect_runtime_java(&dir);
        }
    }

    state.set_java_cache(info.clone());
    info
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<()> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://")
        || trimmed.starts_with("http://127.0.0.1")
        || trimmed.starts_with("http://localhost"))
    {
        return Err(LauncherError::Invalid(
            "Es dürfen nur HTTPS-Adressen geöffnet werden.".into(),
        ));
    }
    app.opener()
        .open_url(trimmed, None::<&str>)
        .map_err(|err| LauncherError::Message(format!("Link konnte nicht geöffnet werden: {err}")))
}
