//! Cosmetic loadout bridge between the launcher and the game.
//!
//! The game owns `config/octoclient.json`; the launcher only reads the enabled
//! catalog modules from it. Equipping in the launcher writes a small shared
//! loadout file which the game applies on startup. This keeps the two sides in
//! sync without duplicating the game's 3,000+ cosmetic settings.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use super::active_instance_dir;
use crate::error::Result;
use crate::state::AppState;

const LOADOUT_FILE: &str = "octoclient_launcher_loadout.json";
const GAME_CONFIG_FILE: &str = "octoclient.json";
const MAX_SELECTION: usize = 64;
const MAX_MODULES: usize = 8192;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LauncherLoadout {
    version: u32,
    selection: Vec<String>,
}

fn game_config_dir(app: &AppHandle, state: &AppState) -> Result<PathBuf> {
    let config = state.config();
    let (_, game_dir) = active_instance_dir(app, state, &config)?;
    Ok(game_dir.join("config"))
}

/// Reads the cosmetics currently equipped in Minecraft.
///
/// `None` means the game never wrote a config, so the launcher keeps its own
/// selection instead of clearing it.
#[tauri::command]
pub fn read_cosmetic_loadout(
    app: AppHandle,
    state: State<'_, AppState>,
    module_names: Vec<String>,
) -> Result<Option<Vec<String>>> {
    let path = game_config_dir(&app, &state)?.join("octoclient.json");
    if !path.is_file() {
        return Ok(None);
    }
    let root: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
    let Some(modules) = root.get("modules").and_then(Value::as_array) else {
        return Ok(None);
    };
    let known: HashSet<&str> = module_names.iter().map(String::as_str).collect();
    let mut enabled = Vec::new();
    for module in modules {
        let Some(name) = module.get("name").and_then(Value::as_str) else {
            continue;
        };
        if module
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            && known.contains(name)
        {
            enabled.push(name.to_string());
        }
    }
    Ok(Some(enabled))
}

/// Writes the loadout the game will apply on its next start.
///
/// `module_names` are the game-side module names of the selected cosmetics and
/// `known_module_names` every cosmetic module name the launcher knows. When both
/// are given the game's own config has its `enabled` flags updated as well, so
/// the cosmetics are worn without opening the in-game cosmetic menu.
#[tauri::command]
pub fn write_cosmetic_loadout(
    app: AppHandle,
    state: State<'_, AppState>,
    selection: Vec<String>,
    module_names: Option<Vec<String>>,
    known_module_names: Option<Vec<String>>,
) -> Result<()> {
    let mut seen = HashSet::new();
    let mut clean = Vec::with_capacity(selection.len().min(MAX_SELECTION));
    for id in selection {
        if clean.len() >= MAX_SELECTION {
            break;
        }
        let id = id.trim();
        if id.is_empty()
            || id.len() > 120
            || !id.contains(':')
            || !seen.insert(id.to_string())
        {
            continue;
        }
        clean.push(id.to_string());
    }
    let dir = game_config_dir(&app, &state)?;
    fs::create_dir_all(&dir)?;
    let loadout = LauncherLoadout {
        version: 1,
        selection: clean,
    };
    let path = dir.join(LOADOUT_FILE);
    let temp = dir.join(format!("{LOADOUT_FILE}.tmp"));
    fs::write(&temp, serde_json::to_string_pretty(&loadout)?)?;
    fs::rename(&temp, &path).or_else(|_| {
        // Windows can refuse to replace a file opened by the game; copying in
        // place still leaves a valid JSON document for the next launch.
        fs::write(&path, serde_json::to_string_pretty(&loadout)?)
    })?;
    if temp.exists() {
        let _ = fs::remove_file(&temp);
    }

    if let (Some(active), Some(known)) = (module_names, known_module_names) {
        // A malformed or missing game config must never block equipping in the
        // launcher; the shared loadout file above still carries the selection.
        if let Err(error) = enable_game_modules(&dir, &active, &known) {
            eprintln!("[octoclient] Spiel-Kosmetik nicht aktualisiert: {error}");
        }
    }
    Ok(())
}

/// Flips the `enabled` flag of cosmetic modules in `config/octoclient.json`.
///
/// Only names in `known` are touched, so HUD and gameplay modules keep their
/// settings. Unknown entries and every other setting stay byte-identical.
fn enable_game_modules(dir: &std::path::Path, active: &[String], known: &[String]) -> Result<()> {
    let path = dir.join(GAME_CONFIG_FILE);
    if !path.is_file() {
        return Ok(());
    }
    let raw = fs::read_to_string(&path)?;
    let mut root: Value = serde_json::from_str(&raw)?;
    let Some(modules) = root.get_mut("modules").and_then(Value::as_array_mut) else {
        return Ok(());
    };

    let active: HashSet<&str> = active.iter().map(String::as_str).collect();
    let known: HashSet<&str> = known
        .iter()
        .take(MAX_MODULES)
        .map(String::as_str)
        .collect();

    let mut changed = false;
    for module in modules.iter_mut() {
        let Some(name) = module
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
        else {
            continue;
        };
        if !module.is_object() || !known.contains(name.as_str()) {
            continue;
        }
        let wanted = active.contains(name.as_str());
        if module.get("enabled").and_then(Value::as_bool) == Some(wanted) {
            continue;
        }
        module["enabled"] = Value::Bool(wanted);
        changed = true;
    }
    if !changed {
        return Ok(());
    }

    let text = serde_json::to_string_pretty(&root)?;
    let temp = dir.join(format!("{GAME_CONFIG_FILE}.tmp"));
    fs::write(&temp, &text)?;
    fs::rename(&temp, &path).or_else(|_| fs::write(&path, &text))?;
    if temp.exists() {
        let _ = fs::remove_file(&temp);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loadout_roundtrip() {
        let json = serde_json::to_string(&LauncherLoadout {
            version: 1,
            selection: vec!["CAPE:2".into(), "WINGS:1".into()],
        })
        .unwrap();
        let parsed: LauncherLoadout = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.selection, vec!["CAPE:2", "WINGS:1"]);
    }
}
