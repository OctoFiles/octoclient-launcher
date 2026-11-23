//! Game launch commands.

use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{LauncherError, Result};
use crate::installer;
use crate::launcher::{self, InstalledVersion, LaunchPlan};
use crate::state::AppState;

use super::{active_instance_dir, instance_dir_for};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub version: String,
    pub java: String,
    pub args: Vec<String>,
    pub note: String,
    pub pid: u32,
}

#[tauri::command]
pub fn list_versions(app: AppHandle, state: State<'_, AppState>) -> Vec<InstalledVersion> {
    let config = state.config();
    match active_instance_dir(&app, &state, &config) {
        Ok((_, game_dir)) => launcher::scan_versions(&game_dir),
        Err(_) => Vec::new(),
    }
}

#[tauri::command]
pub fn build_launch_preview(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<LaunchPlan>> {
    let config = state.config();
    let Some(account) = state.auth.current() else {
        return Err(LauncherError::NotSignedIn);
    };
    let Some(token) = state.auth.access_token() else {
        return Err(LauncherError::NotSignedIn);
    };
    let Some(java) = state.java(&config) else {
        return Ok(None);
    };
    let (instance, game_dir) = active_instance_dir(&app, &state, &config)?;

    match launcher::build_plan(
        &config,
        &account,
        &token,
        &instance.version,
        &game_dir,
        &java,
        None,
    ) {
        Ok(plan) => Ok(Some(plan)),
        // A version that is not installed is a normal state, not an error here.
        Err(LauncherError::VersionMissing(_)) => Ok(None),
        Err(err) => Err(err),
    }
}

#[tauri::command]
pub async fn launch_game(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: Option<String>,
) -> Result<LaunchResult> {
    let config = state.config();
    let account = state.auth.current().ok_or(LauncherError::NotSignedIn)?;
    let token = state.auth.access_token().ok_or(LauncherError::NotSignedIn)?;
    // The Play screen launches the active instance; the instance window can
    // start any saved instance directly.
    let (instance, game_dir) = match instance_id.as_deref() {
        Some(id) => instance_dir_for(&app, &state, &config, id)?,
        None => active_instance_dir(&app, &state, &config)?,
    };

    if instance.mod_profile == "forge" {
        return Err(LauncherError::Message(
            "Forge wird noch nicht automatisch installiert. Stelle die Instanz auf Fabric oder Vanilla."
                .into(),
        ));
    }

    // Install missing game files (and a suitable Java runtime) before launching.
    let progress: installer::ProgressSink = {
        let handle = app.clone();
        Arc::new(move |update| {
            let _ = handle.emit("install://progress", update);
        })
    };
    let installed = installer::install(
        &state.http,
        &game_dir,
        &instance.version,
        progress.clone(),
    )
    .await?;

    // Fabric needs its own profile + libraries; without it Minecraft runs
    // vanilla and silently ignores everything in the mods folder.
    let fabric = if instance.mod_profile == "fabric" {
        Some(
            installer::install_fabric(
                &state.http,
                &game_dir,
                &instance.version,
                progress.clone(),
            )
            .await?,
        )
    } else {
        None
    };
    let (launch_version, display_version) = match fabric.as_ref() {
        Some(fabric) => (
            fabric.version_id.clone(),
            format!("Fabric {}", instance.version),
        ),
        None => (instance.version.clone(), instance.version.clone()),
    };

    let java = installer::ensure_java(
        &state.http,
        &game_dir,
        installed.java_major,
        installed.java_component.as_deref(),
        state.java(&config),
        progress,
    )
    .await?;
    state.set_java_cache(Some(java.clone()));

    let _ = app.emit(
        "install://progress",
        installer::InstallProgress {
            version: instance.version.clone(),
            stage: "done".into(),
            current: 1,
            total: 1,
        },
    );

    let plan = launcher::build_plan(
        &config,
        &account,
        &token,
        &launch_version,
        &game_dir,
        &java,
        Some(&display_version),
    )?;

    let pid = launcher::spawn_game(&plan, &game_dir, config.launch.show_console)?;

    if config.launch.close_launcher {
        app.exit(0);
    }

    Ok(LaunchResult {
        version: plan.version,
        java: plan.java,
        args: plan.args,
        note: plan.note,
        pid,
    })
}
