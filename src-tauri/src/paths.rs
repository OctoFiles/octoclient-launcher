//! Application paths. Everything the launcher persists lives in the OS-specific
//! config/data directories so a portable or packaged build behaves the same.

use std::fs;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::Result;

#[derive(Debug, Clone)]
pub struct AppPaths {
    pub config_dir: PathBuf,
    pub data_dir: PathBuf,
    pub config_file: PathBuf,
    pub auth_fallback_file: PathBuf,
    pub skins_dir: PathBuf,
    pub instances_dir: PathBuf,
    pub version_cache_file: PathBuf,
}

impl AppPaths {
    pub fn resolve(app: &AppHandle) -> Result<Self> {
        let config_dir = app.path().app_config_dir()?;
        let data_dir = app.path().app_data_dir()?;
        let skins_dir = data_dir.join("skins");
        let instances_dir = data_dir.join("instances");

        fs::create_dir_all(&config_dir)?;
        fs::create_dir_all(&data_dir)?;
        fs::create_dir_all(&skins_dir)?;
        fs::create_dir_all(&instances_dir)?;

        Ok(Self {
            config_file: config_dir.join("config.json"),
            auth_fallback_file: data_dir.join("auth-session.json"),
            version_cache_file: config_dir.join("minecraft-versions.json"),
            config_dir,
            data_dir,
            skins_dir,
            instances_dir,
        })
    }
}
