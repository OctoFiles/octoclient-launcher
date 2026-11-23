//! Tauri commands, grouped by domain. The frontend talks to these via
//! `invoke(...)`; see `src/lib/bridge.ts` for the typed client.

pub mod auth;
pub mod config;
pub mod cosmetics;
pub mod friends;
pub mod instances;
pub mod launcher;
pub mod news;
pub mod skins;
pub mod system;

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::config::{Instance, LauncherConfig};
use crate::error::{LauncherError, Result};
use crate::state::AppState;

/// Configured game directory or the default `~/.minecraft`.
pub fn resolve_game_dir(app: &AppHandle, config: &LauncherConfig) -> PathBuf {
    match config.game.directory.as_ref() {
        Some(dir) => PathBuf::from(dir),
        None => app
            .path()
            .home_dir()
            .map(|home| home.join(".minecraft"))
            .unwrap_or_else(|_| PathBuf::from(".minecraft")),
    }
}

pub fn find_instance(config: &LauncherConfig, id: &str) -> Result<Instance> {
    config
        .instances
        .iter()
        .find(|instance| instance.id == id)
        .cloned()
        .ok_or_else(|| LauncherError::Invalid("Instanz nicht gefunden.".into()))
}

/// Resolves the game directory of an instance.
///
/// * explicit `directory` wins,
/// * the migrated `default` instance keeps using the global game directory,
/// * every other instance gets its own folder under `<app data>/instances/<id>`.
pub fn instance_dir_for(
    app: &AppHandle,
    state: &AppState,
    config: &LauncherConfig,
    id: &str,
) -> Result<(Instance, PathBuf)> {
    let instance = find_instance(config, id)?;
    let dir = match instance
        .directory
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(dir) => PathBuf::from(dir),
        None if instance.id == "default" => resolve_game_dir(app, config),
        // A custom game directory is the base for every instance, so installs
        // end up under the path the user configured in the settings. Each
        // instance keeps its own subfolder to separate mods and worlds.
        None => match config
            .game
            .directory
            .as_deref()
            .filter(|value| !value.trim().is_empty())
        {
            Some(base) => PathBuf::from(base)
                .join("instances")
                .join(safe_folder_name(&instance.id)),
            None => state
                .paths
                .instances_dir
                .join(safe_folder_name(&instance.id)),
        },
    };
    Ok((instance, dir))
}

pub fn active_instance_dir(
    app: &AppHandle,
    state: &AppState,
    config: &LauncherConfig,
) -> Result<(Instance, PathBuf)> {
    let id = config.active_instance_id.clone();
    instance_dir_for(app, state, config, &id)
}

fn safe_folder_name(id: &str) -> String {
    let cleaned: String = id
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || *character == '-' || *character == '_')
        .take(64)
        .collect();
    if cleaned.is_empty() {
        "instance".into()
    } else {
        cleaned
    }
}
