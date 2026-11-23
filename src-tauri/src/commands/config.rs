//! Settings commands.

use tauri::{AppHandle, Manager, State};

use crate::config::LauncherConfig;
use crate::error::Result;
use crate::state::AppState;

#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> LauncherConfig {
    state.config()
}

#[tauri::command]
pub fn save_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: LauncherConfig,
) -> Result<LauncherConfig> {
    let config = config.normalized();

    {
        let mut current = state
            .config
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *current = config.clone();
    }
    state.save_config()?;
    state.invalidate_java_cache();

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(config.system.always_on_top);
    }

    Ok(config)
}

#[tauri::command]
pub fn reset_config(app: AppHandle, state: State<'_, AppState>) -> Result<LauncherConfig> {
    let config = LauncherConfig::default().normalized();

    {
        let mut current = state
            .config
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *current = config.clone();
    }
    state.save_config()?;
    state.invalidate_java_cache();

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(config.system.always_on_top);
    }

    Ok(config)
}
