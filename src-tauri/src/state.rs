//! Shared state injected into every command.

use std::sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard};

use crate::auth::AuthManager;
use crate::config::LauncherConfig;
use crate::error::Result;
use crate::launcher::{self, JavaInfo};
use crate::paths::AppPaths;

fn read_lock<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    lock.read().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn write_lock<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    lock.write().unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct AppState {
    pub paths: AppPaths,
    pub config: RwLock<LauncherConfig>,
    pub auth: Arc<AuthManager>,
    pub http: reqwest::Client,
    /// Cached Java detection (invalidated when settings change).
    pub java_cache: RwLock<Option<JavaInfo>>,
}

impl AppState {
    pub fn config(&self) -> LauncherConfig {
        read_lock(&self.config).clone()
    }

    pub fn save_config(&self) -> Result<()> {
        let config = self.config();
        crate::storage::write_json(&self.paths.config_file, &config)
    }

    /// Mutates, normalizes and persists the config (used when a modpack switches
    /// the instance's Minecraft version or loader).
    pub fn update_config(&self, updater: impl FnOnce(&mut LauncherConfig)) -> Result<()> {
        {
            let mut guard = write_lock(&self.config);
            updater(&mut guard);
            *guard = guard.clone().normalized();
        }
        self.save_config()
    }

    /// Detects Java once and caches it.
    pub fn java(&self, config: &LauncherConfig) -> Option<JavaInfo> {
        if let Some(cached) = read_lock(&self.java_cache).clone() {
            return Some(cached);
        }
        let detected = launcher::detect_java(config.java.path.as_deref());
        if let Some(info) = detected.clone() {
            *write_lock(&self.java_cache) = Some(info);
        }
        detected
    }

    pub fn set_java_cache(&self, info: Option<JavaInfo>) {
        *write_lock(&self.java_cache) = info;
    }

    pub fn invalidate_java_cache(&self) {
        *write_lock(&self.java_cache) = None;
    }
}
