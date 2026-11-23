//! Live Minecraft version catalog from Mojang.
//!
//! Fetches `version_manifest_v2.json` so newly released versions show up without
//! shipping a new launcher. The result is cached on disk for a few hours, so the
//! Instanzen tab works offline and only hits the network when it is stale.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::{LauncherError, Result};
use crate::storage;

const MANIFEST_URL: &str = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
/// Re-check Mojang at most every hour, so a new release shows up quickly.
const CACHE_TTL_SECS: i64 = 60 * 60;
/// Keep the catalog compact but complete enough for launchers.
const MAX_RELEASES: usize = 90;
const MAX_SNAPSHOTS: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameVersion {
    pub id: String,
    /// `release`, `snapshot`, `old_beta`, `old_alpha`
    pub kind: String,
    pub released: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionCatalog {
    pub latest_release: String,
    pub latest_snapshot: String,
    pub fetched_at: i64,
    /// `live` when fetched now, `cache` when served from disk.
    pub source: String,
    pub versions: Vec<GameVersion>,
}

#[derive(Deserialize)]
struct RawManifest {
    latest: RawLatest,
    versions: Vec<RawVersion>,
}

#[derive(Deserialize)]
struct RawLatest {
    release: String,
    snapshot: String,
}

#[derive(Deserialize)]
struct RawVersion {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    #[serde(rename = "releaseTime")]
    released: String,
}

pub async fn catalog(
    http: &reqwest::Client,
    cache_file: &Path,
    force: bool,
) -> Result<VersionCatalog> {
    let cached = storage::read_json::<VersionCatalog>(cache_file)?;
    let now = chrono::Utc::now().timestamp();

    if !force {
        if let Some(cache) = cached.as_ref() {
            let fresh = now - cache.fetched_at < CACHE_TTL_SECS;
            if fresh && !cache.versions.is_empty() {
                return Ok(VersionCatalog {
                    source: "cache".into(),
                    ..cache.clone()
                });
            }
        }
    }

    match fetch_live(http).await {
        Ok(mut live) => {
            live.fetched_at = now;
            live.source = "live".into();
            let _ = storage::write_json(cache_file, &live);
            Ok(live)
        }
        // Offline: use the cache, even if it is older than the TTL.
        Err(err) => cached
            .filter(|cache| !cache.versions.is_empty())
            .map(|cache| VersionCatalog {
                source: "cache".into(),
                ..cache
            })
            .ok_or(err),
    }
}

async fn fetch_live(http: &reqwest::Client) -> Result<VersionCatalog> {
    let response = http.get(MANIFEST_URL).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(LauncherError::Message(format!(
            "Mojang-Versionsliste antwortete mit HTTP {}.",
            status.as_u16()
        )));
    }

    let manifest: RawManifest = response.json().await?;
    let mut releases = Vec::new();
    let mut snapshots = Vec::new();
    for entry in manifest.versions {
        let version = GameVersion {
            id: entry.id,
            kind: entry.kind.clone(),
            released: entry.released,
        };
        match entry.kind.as_str() {
            "release" => releases.push(version),
            "snapshot" | "old_beta" | "old_alpha" => snapshots.push(version),
            _ => {}
        }
    }
    releases.truncate(MAX_RELEASES);
    snapshots.truncate(MAX_SNAPSHOTS);
    releases.extend(snapshots);

    Ok(VersionCatalog {
        latest_release: manifest.latest.release,
        latest_snapshot: manifest.latest.snapshot,
        fetched_at: 0,
        source: "live".into(),
        versions: releases,
    })
}
