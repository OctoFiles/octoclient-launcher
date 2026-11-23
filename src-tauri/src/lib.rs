//! OctoClient Launcher — application entry.
//!
//! Module map:
//!   auth/        Microsoft OAuth2 device code → Xbox Live → Minecraft Services
//!   config.rs    versioned, validated settings model
//!   launcher.rs  Java detection, version scan, command-line assembly, spawn
//!   news.rs      optional remote news feed
//!   commands/    thin Tauri command layer grouped by domain
//!   state.rs     shared, lock-protected application state

pub mod auth;
pub mod commands;
pub mod config;
pub mod discord;
pub mod error;
pub mod friends;
pub mod friends_api;
pub mod instances;
pub mod installer;
pub mod launcher;
pub mod minecraft_meta;
pub mod modrinth;
pub mod news;
pub mod paths;
pub mod state;
pub mod storage;

use std::sync::{Arc, RwLock};
use std::time::Duration;

use tauri::{Emitter, Manager};

use crate::auth::AuthManager;
use crate::config::LauncherConfig;
use crate::error::LauncherError;
use crate::paths::AppPaths;
use crate::state::AppState;

/// Refresh the access token this long before it expires.
const AUTH_REFRESH_LEEWAY_SECS: i64 = 2 * 60 * 60;
/// How often the background task checks the token lifetime.
const AUTH_REFRESH_INTERVAL_SECS: u64 = 10 * 60;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let paths = AppPaths::resolve(app.handle())?;
            let config = storage::read_json::<LauncherConfig>(&paths.config_file)?
                .unwrap_or_default()
                .normalized();

            let http = reqwest::Client::builder()
                .user_agent("OctoClientLauncher/0.1.0")
                .timeout(Duration::from_secs(30))
                .build()?;

            let auth = Arc::new(AuthManager::new(
                http.clone(),
                paths.skins_dir.clone(),
                paths.auth_fallback_file.clone(),
            ));
            auth.restore();

            let always_on_top = config.system.always_on_top;
            let start_minimized = config.system.start_minimized;
            let auth_task = auth.clone();

            app.manage(AppState {
                paths,
                config: RwLock::new(config),
                auth,
                http,
                java_cache: RwLock::new(None),
            });

            // Keep the session alive: refresh the Minecraft access token before it
            // expires, so the device code is only needed once. Microsoft rotates the
            // refresh token on every refresh and the new one is persisted by the
            // AuthManager. A rejected refresh token is the only case that signs the
            // user out; offline/transient errors keep the session and retry later.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        if auth_task.is_signed_in() {
                            let client_id = {
                                let state = handle.state::<AppState>();
                                commands::auth::resolve_client_id(&state.config(), None)
                            };
                            match auth_task
                                .refresh_if_needed(&client_id, AUTH_REFRESH_LEEWAY_SECS)
                                .await
                            {
                                Ok(Some(_)) => {
                                    let _ = handle.emit("auth://changed", auth_task.snapshot());
                                }
                                Ok(None) => {}
                                Err(LauncherError::SessionExpired) => {
                                    auth_task.sign_out();
                                    let _ = handle.emit("auth://changed", auth_task.snapshot());
                                }
                                Err(_) => {
                                    // Transient error or offline: keep the session.
                                }
                            }
                        }
                        tokio::time::sleep(Duration::from_secs(AUTH_REFRESH_INTERVAL_SECS)).await;
                    }
                });
            }

            // --- Discord Rich Presence -----------------------------------
            // Updates every 20 s from the current config. Without an app id the
            // loop is a no-op, so no Discord application is required to build.
            {
                let handle = app.handle().clone();
                let started_at = chrono::Utc::now().timestamp();
                std::thread::spawn(move || loop {
                    {
                        let state = handle.state::<AppState>();
                        let config = state.config();
                        if config.discord.enabled {
                            if let Some(app_id) = config.discord.app_id.clone() {
                                let instance = config
                                    .instances
                                    .iter()
                                    .find(|instance| instance.id == config.active_instance_id)
                                    .map(|instance| instance.name.clone())
                                    .unwrap_or_else(|| config.profile.version.clone());
                                let detail = if config.discord.show_server {
                                    format!("{} · {}", instance, config.profile.version)
                                } else {
                                    format!("Minecraft {}", config.profile.version)
                                };
                                let _ = discord::set_activity(
                                    &app_id,
                                    &discord::Activity {
                                        details: "OctoClient Launcher".into(),
                                        state: detail,
                                        started_at,
                                    },
                                );
                            }
                        }
                    }
                    std::thread::sleep(Duration::from_secs(20));
                });
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(always_on_top);
                if start_minimized {
                    let _ = window.minimize();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::config::get_config,
            commands::config::save_config,
            commands::config::reset_config,
            commands::cosmetics::read_cosmetic_loadout,
            commands::cosmetics::write_cosmetic_loadout,
            commands::system::system_info,
            commands::system::detect_java,
            commands::system::open_external,
            commands::auth::auth_current,
            commands::auth::auth_begin_login,
            commands::auth::auth_cancel_login,
            commands::auth::auth_sign_out,
            commands::auth::auth_switch,
            commands::auth::auth_remove,
            commands::auth::open_auth_popup,
            commands::auth::auth_refresh,
            commands::launcher::list_versions,
            commands::launcher::build_launch_preview,
            commands::launcher::launch_game,
            commands::skins::resolve_minecraft_skin,
            commands::skins::apply_minecraft_skin,
            commands::instances::list_minecraft_versions,
            commands::instances::instance_info,
            commands::instances::list_instance_content,
            commands::instances::search_modrinth,
            commands::instances::install_modrinth_content,
            commands::instances::install_modrinth_modpack,
            commands::instances::remove_instance_content,
            commands::instances::remove_instance_modpack,
            commands::instances::import_instance_files,
            commands::instances::import_pack_file,
            commands::instances::export_instance_pack,
            commands::instances::open_instance_folder,
            commands::news::fetch_news,
            commands::friends::friends_overview,
            commands::friends::friends_request,
            commands::friends::friends_accept,
            commands::friends::friends_remove,
            commands::friends::friends_send,
            commands::friends::friends_messages,
            commands::friends::friends_typing,
            commands::friends::friends_edit,
            commands::friends::friends_delete,
            commands::friends::friends_set_status,
            commands::friends::friends_groups,
            commands::friends::friends_group_create,
            commands::friends::friends_group_leave,
            commands::friends::friends_group_messages,
            commands::friends::friends_group_send,
            commands::friends::friends_group_typing,
            commands::friends::friends_group_edit,
            commands::friends::friends_group_delete,
        ])
        .run(tauri::generate_context!())
        .expect("error while running OctoClient");
}
