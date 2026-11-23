//! Automated Minecraft installation.
//!
//! Downloads everything a version needs into the game directory that the
//! launcher actually uses:
//!
//! * `versions/<id>/<id>.json` and `<id>.jar`
//! * libraries (respecting Mojang's OS rules) and legacy natives
//! * the asset index plus all asset objects
//! * a Mojang Java runtime when the installed Java is too old for the version
//!
//! Everything is resumable: existing files are skipped, a marker is only
//! written after a complete install, and a half-finished install simply
//! continues on the next attempt.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::Value;
use sha1::{Digest, Sha1};

use crate::error::{LauncherError, Result};
use crate::launcher::{JavaInfo, JAVA_EXE};

const VERSION_MANIFEST_URL: &str =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const RUNTIME_ALL_URL: &str = "https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json";
const ASSET_BASE: &str = "https://resources.download.minecraft.net";
const CONCURRENCY: usize = 16;
const DOWNLOAD_TIMEOUT_SECS: u64 = 300;
const MARKER: &str = ".frost-installed";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallProgress {
    pub version: String,
    /// `version`, `libraries`, `assets`, `runtime` or `done`.
    pub stage: String,
    pub current: u64,
    pub total: u64,
}

pub type ProgressSink = Arc<dyn Fn(InstallProgress) + Send + Sync>;

#[derive(Debug)]
pub struct InstallOutcome {
    pub version: String,
    pub files: u64,
    pub bytes: u64,
    pub java_major: u32,
    pub java_component: Option<String>,
    pub freshly_installed: bool,
}

#[derive(Debug)]
struct DownloadTask {
    url: String,
    path: PathBuf,
    sha1: Option<String>,
    size: u64,
}

struct VersionEntry {
    url: String,
    sha1: Option<String>,
}

#[derive(Debug)]
pub struct FabricInstall {
    /// Version id to launch (e.g. `fabric-loader-0.20.1-26.2`).
    pub version_id: String,
    pub loader_version: String,
}

/// Downloads/repairs the version in `game_dir`; returns its Java requirements.
pub async fn install(
    http: &reqwest::Client,
    game_dir: &Path,
    version_id: &str,
    progress: ProgressSink,
) -> Result<InstallOutcome> {
    let version_dir = game_dir.join("versions").join(version_id);
    let manifest_path = version_dir.join(format!("{version_id}.json"));
    let jar_path = version_dir.join(format!("{version_id}.jar"));
    let marker = version_dir.join(MARKER);

    if manifest_path.is_file() && jar_path.is_file() && marker.is_file() {
        if let Ok(raw) = std::fs::read_to_string(&manifest_path) {
            if let Ok(json) = serde_json::from_str::<Value>(&raw) {
                return Ok(outcome_from_json(version_id, &json, 0, 0, false));
            }
        }
    }

    emit(&progress, version_id, "version", 0, 1);
    let entry = find_version_entry(http, version_id).await?;
    let raw = http_get_text(http, &entry.url).await?;
    if let Some(expected) = entry.sha1.as_deref() {
        verify_sha1(raw.as_bytes(), expected)?;
    }
    let manifest: Value = serde_json::from_str(&raw)?;
    std::fs::create_dir_all(&version_dir)?;
    std::fs::write(&manifest_path, &raw)?;
    std::fs::create_dir_all(version_dir.join("natives"))?;

    let mut files = 1u64;
    let mut bytes = raw.len() as u64;

    let client = manifest
        .pointer("/downloads/client")
        .ok_or_else(|| LauncherError::Message("Die Version enthält keinen Client-Download.".into()))?;
    let client_url = artifact_url(client)?;
    let client_sha = client.get("sha1").and_then(Value::as_str);
    let client_size = client.get("size").and_then(Value::as_u64).unwrap_or(0);
    if !file_ok(&jar_path, client_size) {
        bytes += download_file(http, &client_url, &jar_path, client_sha).await?;
        files += 1;
    }

    // Libraries: artifacts for the classpath, classifiers for legacy natives.
    let libraries = manifest
        .get("libraries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let libraries_root = game_dir.join("libraries");
    let mut tasks: Vec<DownloadTask> = Vec::new();
    let mut native_jars: Vec<PathBuf> = Vec::new();

    for library in &libraries {
        if !library_allowed(library) {
            continue;
        }
        if let Some(artifact) = library.pointer("/downloads/artifact") {
            push_task(&mut tasks, artifact, &libraries_root);
        }
        if let Some(classifier) = native_classifier(library) {
            let pointer = format!("/downloads/classifiers/{classifier}");
            if let Some(native) = library.pointer(&pointer) {
                if let Some(path) = native.get("path").and_then(Value::as_str) {
                    let target = libraries_root.join(path);
                    push_task(&mut tasks, native, &libraries_root);
                    native_jars.push(target);
                }
            }
        }
    }

    let (library_files, library_bytes) =
        download_many(http, tasks, version_id, "libraries", &progress).await?;
    files += library_files;
    bytes += library_bytes;

    if !native_jars.is_empty() {
        let natives_dir = version_dir.join("natives");
        std::fs::create_dir_all(&natives_dir)?;
        for jar in native_jars {
            extract_natives(&jar, &natives_dir);
        }
    }

    // Assets (index + every object).
    if let Some(asset_index) = manifest.get("assetIndex") {
        let index_url = artifact_url(asset_index)?;
        let index_id = asset_index
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or(version_id);
        let indexes_dir = game_dir.join("assets").join("indexes");
        std::fs::create_dir_all(&indexes_dir)?;
        let index_path = indexes_dir.join(format!("{index_id}.json"));
        let index_sha = asset_index.get("sha1").and_then(Value::as_str);

        if !file_ok(
            &index_path,
            asset_index.get("size").and_then(Value::as_u64).unwrap_or(0),
        ) {
            download_file(http, &index_url, &index_path, index_sha).await?;
        }

        let index_raw = std::fs::read_to_string(&index_path)?;
        let index: Value = serde_json::from_str(&index_raw)?;
        let mut asset_tasks: Vec<DownloadTask> = Vec::new();
        if let Some(objects) = index.get("objects").and_then(Value::as_object) {
            for object in objects.values() {
                let Some(hash) = object.get("hash").and_then(Value::as_str) else {
                    continue;
                };
                if hash.len() < 2 {
                    continue;
                }
                let prefix = &hash[..2];
                let target = game_dir
                    .join("assets")
                    .join("objects")
                    .join(prefix)
                    .join(hash);
                let size = object.get("size").and_then(Value::as_u64).unwrap_or(0);
                if file_ok(&target, size) {
                    continue;
                }
                asset_tasks.push(DownloadTask {
                    url: format!("{ASSET_BASE}/{prefix}/{hash}"),
                    path: target,
                    sha1: Some(hash.to_string()),
                    size,
                });
            }
        }

        let (asset_files, asset_bytes) =
            download_many(http, asset_tasks, version_id, "assets", &progress).await?;
        files += asset_files;
        bytes += asset_bytes;
    }

    let outcome = outcome_from_json(version_id, &manifest, files, bytes, true);
    let marker_body = serde_json::json!({
        "version": version_id,
        "installedAt": chrono::Utc::now().to_rfc3339(),
    });
    std::fs::write(marker, marker_body.to_string())?;
    Ok(outcome)
}

/// Installs the latest stable Fabric loader for a Minecraft version and writes a
/// standalone profile (vanilla libraries + Fabric libraries) so the launcher can
/// start it without manifest inheritance.
pub async fn install_fabric(
    http: &reqwest::Client,
    game_dir: &Path,
    mc_version: &str,
    progress: ProgressSink,
) -> Result<FabricInstall> {
    emit(&progress, mc_version, "fabric", 0, 1);
    let loaders_raw = http_get_text(
        http,
        &format!("https://meta.fabricmc.net/v2/versions/loader/{mc_version}"),
    )
    .await?;
    let loaders: Vec<Value> = serde_json::from_str(&loaders_raw)?;
    let loader_version = loaders
        .iter()
        .find(|entry| {
            entry
                .pointer("/loader/stable")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .or_else(|| loaders.first())
        .and_then(|entry| entry.pointer("/loader/version").and_then(Value::as_str))
        .ok_or_else(|| {
            LauncherError::Message(format!(
                "Fabric bietet für Minecraft {mc_version} keinen Loader an."
            ))
        })?
        .to_string();

    let profile_raw = http_get_text(
        http,
        &format!(
            "https://meta.fabricmc.net/v2/versions/loader/{mc_version}/{loader_version}/profile/json"
        ),
    )
    .await?;
    let profile: Value = serde_json::from_str(&profile_raw)?;
    let version_id = profile
        .get("id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("fabric-loader-{loader_version}-{mc_version}"));

    let fabric_dir = game_dir.join("versions").join(&version_id);
    let manifest_path = fabric_dir.join(format!("{version_id}.json"));
    let jar_path = fabric_dir.join(format!("{version_id}.jar"));
    if manifest_path.is_file() && jar_path.is_file() && fabric_dir.join(MARKER).is_file() {
        return Ok(FabricInstall {
            version_id,
            loader_version,
        });
    }

    let vanilla_path = game_dir
        .join("versions")
        .join(mc_version)
        .join(format!("{mc_version}.json"));
    let vanilla_raw = std::fs::read_to_string(&vanilla_path)
        .map_err(|_| LauncherError::VersionMissing(mc_version.to_string()))?;
    let vanilla: Value = serde_json::from_str(&vanilla_raw)?;
    let vanilla_jar = game_dir
        .join("versions")
        .join(mc_version)
        .join(format!("{mc_version}.jar"));
    if !vanilla_jar.is_file() {
        return Err(LauncherError::VersionMissing(mc_version.to_string()));
    }

    let merged = merge_fabric_profile(&vanilla, &profile, &version_id);
    std::fs::create_dir_all(&fabric_dir)?;
    std::fs::create_dir_all(fabric_dir.join("natives"))?;
    std::fs::write(&manifest_path, serde_json::to_string_pretty(&merged)?)?;
    if !jar_path.is_file() {
        std::fs::copy(&vanilla_jar, &jar_path)?;
    }

    let libraries_root = game_dir.join("libraries");
    let mut tasks: Vec<DownloadTask> = Vec::new();
    if let Some(libraries) = merged.get("libraries").and_then(Value::as_array) {
        for library in libraries {
            if !library_allowed(library) {
                continue;
            }
            if let Some(artifact) = library.pointer("/downloads/artifact") {
                push_task(&mut tasks, artifact, &libraries_root);
            }
        }
    }
    download_many(http, tasks, &version_id, "libraries", &progress).await?;

    std::fs::write(
        fabric_dir.join(MARKER),
        serde_json::json!({ "version": version_id, "loader": loader_version }).to_string(),
    )?;
    emit(&progress, &version_id, "fabric", 1, 1);
    Ok(FabricInstall {
        version_id,
        loader_version,
    })
}

fn merge_fabric_profile(vanilla: &Value, profile: &Value, id: &str) -> Value {
    let fabric_libraries: Vec<Value> = profile
        .get("libraries")
        .and_then(Value::as_array)
        .map(|libraries| libraries.iter().filter_map(fabric_library).collect())
        .unwrap_or_default();
    let fabric_keys: HashSet<String> = fabric_libraries
        .iter()
        .filter_map(|library| {
            library
                .get("name")
                .and_then(Value::as_str)
                .map(maven_key)
        })
        .collect();

    let mut libraries: Vec<Value> = vanilla
        .get("libraries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|library| {
            library
                .get("name")
                .and_then(Value::as_str)
                .map(|name| !fabric_keys.contains(&maven_key(name)))
                .unwrap_or(true)
        })
        .collect();
    libraries.extend(fabric_libraries);

    let vanilla_args = vanilla.get("arguments");
    let mut game = vanilla_args
        .and_then(|arguments| arguments.get("game"))
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let mut jvm = vanilla_args
        .and_then(|arguments| arguments.get("jvm"))
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    if let (Some(target), Some(extra)) = (
        jvm.as_array_mut(),
        profile
            .pointer("/arguments/jvm")
            .and_then(Value::as_array),
    ) {
        target.extend(extra.iter().cloned());
    }
    if let (Some(target), Some(extra)) = (
        game.as_array_mut(),
        profile
            .pointer("/arguments/game")
            .and_then(Value::as_array),
    ) {
        target.extend(extra.iter().cloned());
    }

    let mut merged = serde_json::Map::new();
    merged.insert("id".into(), Value::String(id.to_string()));
    merged.insert("type".into(), Value::String("release".into()));
    for key in ["releaseTime", "time", "assetIndex", "assets", "javaVersion"] {
        if let Some(value) = vanilla.get(key) {
            merged.insert(key.into(), value.clone());
        }
    }
    if let Some(client) = vanilla.pointer("/downloads/client") {
        merged.insert(
            "downloads".into(),
            serde_json::json!({ "client": client }),
        );
    }
    merged.insert(
        "mainClass".into(),
        profile.get("mainClass").cloned().unwrap_or_else(|| {
            vanilla
                .get("mainClass")
                .cloned()
                .unwrap_or_else(|| Value::String("net.minecraft.client.main.Main".into()))
        }),
    );
    merged.insert("libraries".into(), Value::Array(libraries));
    merged.insert(
        "arguments".into(),
        serde_json::json!({ "game": game, "jvm": jvm }),
    );
    Value::Object(merged)
}

fn fabric_library(library: &Value) -> Option<Value> {
    if library.get("downloads").is_some() {
        return Some(library.clone());
    }
    let name = library.get("name").and_then(Value::as_str)?;
    let path = maven_path(name)?;
    let base = library
        .get("url")
        .and_then(Value::as_str)
        .unwrap_or("https://maven.fabricmc.net/");

    let mut artifact = serde_json::Map::new();
    artifact.insert("path".into(), Value::String(path.clone()));
    artifact.insert(
        "url".into(),
        Value::String(format!("{}/{}", base.trim_end_matches('/'), path)),
    );
    if let Some(sha1) = library.get("sha1").and_then(Value::as_str) {
        artifact.insert("sha1".into(), Value::String(sha1.to_string()));
    }
    if let Some(size) = library.get("size").and_then(Value::as_u64) {
        artifact.insert("size".into(), Value::Number(size.into()));
    }

    Some(serde_json::json!({
        "name": name,
        "downloads": { "artifact": artifact },
    }))
}

fn maven_key(name: &str) -> String {
    name.split(':').take(2).collect::<Vec<_>>().join(":")
}

fn maven_path(coordinates: &str) -> Option<String> {
    let parts: Vec<&str> = coordinates.split(':').collect();
    if parts.len() < 3 {
        return None;
    }
    let (group, artifact, version) = (parts[0], parts[1], parts[2]);
    let classifier = parts.get(3).copied().filter(|value| !value.is_empty());
    let extension = parts
        .get(4)
        .copied()
        .filter(|value| !value.is_empty())
        .unwrap_or("jar");
    let file = match classifier {
        Some(classifier) => format!("{artifact}-{version}-{classifier}.{extension}"),
        None => format!("{artifact}-{version}.{extension}"),
    };
    Some(format!(
        "{}/{}/{}/{}",
        group.replace('.', "/"),
        artifact,
        version,
        file
    ))
}

/// Returns a usable Java for the version, installing Mojang's runtime if the
/// detected Java is missing or too old.
pub async fn ensure_java(
    http: &reqwest::Client,
    game_dir: &Path,
    required_major: u32,
    component: Option<&str>,
    current: Option<JavaInfo>,
    progress: ProgressSink,
) -> Result<JavaInfo> {
    if let Some(java) = current.as_ref() {
        let sufficient = java
            .version
            .as_deref()
            .and_then(java_major)
            .map(|major| major >= required_major)
            .unwrap_or(true);
        if sufficient {
            return Ok(java.clone());
        }
    }

    let Some(component) = component else {
        return current.ok_or(LauncherError::JavaMissing);
    };

    let runtime_dir = game_dir.join("runtime").join(component);
    let java_path = runtime_dir.join("bin").join(JAVA_EXE);
    if java_path.is_file() {
        return Ok(runtime_info(&runtime_dir, component));
    }

    let platform = runtime_platform();
    emit(&progress, "", "runtime", 0, 1);
    let all_raw = http_get_text(http, RUNTIME_ALL_URL).await?;
    let all: Value = serde_json::from_str(&all_raw)?;
    let entry = all
        .get(platform)
        .and_then(|platforms| platforms.get(component))
        .and_then(Value::as_array)
        .and_then(|entries| entries.first())
        .ok_or_else(|| {
            LauncherError::Message(format!(
                "Mojang stellt die Java-Runtime {component} für {platform} nicht bereit."
            ))
        })?;

    let manifest_url = entry
        .pointer("/manifest/url")
        .and_then(Value::as_str)
        .ok_or_else(|| LauncherError::Message("Java-Runtime ohne Manifest-URL.".into()))?;
    let manifest_raw = http_get_text(http, manifest_url).await?;
    let manifest: Value = serde_json::from_str(&manifest_raw)?;
    let files = manifest
        .get("files")
        .and_then(Value::as_object)
        .ok_or_else(|| LauncherError::Message("Java-Runtime-Manifest ist unvollständig.".into()))?;

    let mut tasks: Vec<DownloadTask> = Vec::new();
    for (relative, file) in files {
        let kind = file.get("type").and_then(Value::as_str).unwrap_or("file");
        let target: PathBuf = relative
            .split('/')
            .fold(runtime_dir.clone(), |path, part| path.join(part));

        if kind == "directory" {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if kind != "file" {
            continue;
        }
        let Some(raw) = file.pointer("/downloads/raw") else {
            continue;
        };
        let Some(url) = raw.get("url").and_then(Value::as_str) else {
            continue;
        };
        let size = raw.get("size").and_then(Value::as_u64).unwrap_or(0);
        if file_ok(&target, size) {
            continue;
        }
        tasks.push(DownloadTask {
            url: url.to_string(),
            path: target,
            sha1: raw.get("sha1").and_then(Value::as_str).map(str::to_string),
            size,
        });
    }

    download_many(http, tasks, "", "runtime", &progress).await?;

    if !java_path.is_file() {
        return Err(LauncherError::Message(
            "Die Java-Runtime konnte nicht installiert werden.".into(),
        ));
    }

    let mut info = runtime_info(&runtime_dir, component);
    if let Some(version) = entry
        .pointer("/version/name")
        .and_then(Value::as_str)
        .map(str::to_string)
    {
        info.version = Some(version);
    }
    Ok(info)
}

fn runtime_info(runtime_dir: &Path, component: &str) -> JavaInfo {
    JavaInfo {
        path: runtime_dir
            .join("bin")
            .join(JAVA_EXE)
            .to_string_lossy()
            .to_string(),
        version: runtime_version(runtime_dir),
        vendor: Some(format!("Mojang Runtime · {component}")),
        source: "runtime".into(),
    }
}

fn runtime_version(runtime_dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(runtime_dir.join("release")).ok()?;
    raw.lines().find_map(|line| {
        line.strip_prefix("JAVA_VERSION=")
            .map(|value| value.trim().trim_matches('"').to_string())
            .filter(|value| !value.is_empty())
    })
}

fn runtime_platform() -> &'static str {
    if cfg!(windows) {
        if cfg!(target_arch = "aarch64") {
            "windows-arm64"
        } else if cfg!(target_arch = "x86") {
            "windows-x86"
        } else {
            "windows-x64"
        }
    } else if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "mac-os-arm64"
        } else {
            "mac-os"
        }
    } else {
        "linux"
    }
}

fn java_major(version: &str) -> Option<u32> {
    let mut parts = version.split(['.', '_', '-', '+']);
    let first = parts.next()?.parse::<u32>().ok()?;
    if first == 1 {
        parts.next()?.parse::<u32>().ok()
    } else {
        Some(first)
    }
}

async fn find_version_entry(http: &reqwest::Client, version_id: &str) -> Result<VersionEntry> {
    let raw = http_get_text(http, VERSION_MANIFEST_URL).await?;
    let manifest: Value = serde_json::from_str(&raw)?;
    let entry = manifest
        .get("versions")
        .and_then(Value::as_array)
        .and_then(|versions| {
            versions
                .iter()
                .find(|entry| entry.get("id").and_then(Value::as_str) == Some(version_id))
        })
        .ok_or_else(|| {
            LauncherError::Message(format!(
                "Minecraft {version_id} wurde im Mojang-Manifest nicht gefunden."
            ))
        })?;

    Ok(VersionEntry {
        url: entry
            .get("url")
            .and_then(Value::as_str)
            .ok_or_else(|| LauncherError::Message("Version ohne Download-URL.".into()))?
            .to_string(),
        sha1: entry.get("sha1").and_then(Value::as_str).map(str::to_string),
    })
}

fn outcome_from_json(
    version: &str,
    json: &Value,
    files: u64,
    bytes: u64,
    freshly_installed: bool,
) -> InstallOutcome {
    InstallOutcome {
        version: version.to_string(),
        files,
        bytes,
        java_major: json
            .pointer("/javaVersion/majorVersion")
            .and_then(Value::as_u64)
            .unwrap_or(8) as u32,
        java_component: json
            .pointer("/javaVersion/component")
            .and_then(Value::as_str)
            .map(str::to_string),
        freshly_installed,
    }
}

async fn http_get_text(http: &reqwest::Client, url: &str) -> Result<String> {
    let response = http
        .get(url)
        .timeout(std::time::Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(LauncherError::Message(format!(
            "Download fehlgeschlagen (HTTP {}): {url}",
            response.status().as_u16()
        )));
    }
    Ok(response.text().await?)
}

async fn download_many(
    http: &reqwest::Client,
    tasks: Vec<DownloadTask>,
    version: &str,
    stage: &str,
    progress: &ProgressSink,
) -> Result<(u64, u64)> {
    let total = tasks.len() as u64;
    if total == 0 {
        return Ok((0, 0));
    }
    emit(progress, version, stage, 0, total);

    let mut done = 0u64;
    let mut bytes = 0u64;
    let mut stream = stream::iter(tasks.into_iter().map(|task| async move {
        let result = download_file(http, &task.url, &task.path, task.sha1.as_deref()).await;
        (task.size, result)
    }))
    .buffer_unordered(CONCURRENCY);

    while let Some((_size, result)) = stream.next().await {
        bytes += result?;
        done += 1;
        if done == total || done % 25 == 0 {
            emit(progress, version, stage, done, total);
        }
    }

    Ok((done, bytes))
}

async fn download_file(
    http: &reqwest::Client,
    url: &str,
    target: &Path,
    expected_sha1: Option<&str>,
) -> Result<u64> {
    let response = http
        .get(url)
        .timeout(std::time::Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(LauncherError::Message(format!(
            "Download fehlgeschlagen (HTTP {}): {url}",
            response.status().as_u16()
        )));
    }
    let bytes = response.bytes().await?;
    if let Some(expected) = expected_sha1 {
        verify_sha1(&bytes, expected)?;
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "download".into());
    let temp = target.with_file_name(format!("{name}.part"));
    std::fs::write(&temp, &bytes)?;
    // Windows does not always replace an existing destination atomically.
    let _ = std::fs::remove_file(target);
    std::fs::rename(&temp, target)?;
    Ok(bytes.len() as u64)
}

fn verify_sha1(bytes: &[u8], expected: &str) -> Result<()> {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    let actual: String = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err(LauncherError::Message(
            "SHA1-Prüfung fehlgeschlagen – Download verworfen.".into(),
        ))
    }
}

fn file_ok(path: &Path, expected_size: u64) -> bool {
    let Ok(metadata) = std::fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    expected_size == 0 || metadata.len() == expected_size
}

fn push_task(tasks: &mut Vec<DownloadTask>, artifact: &Value, root: &Path) {
    let Some(path) = artifact.get("path").and_then(Value::as_str) else {
        return;
    };
    let Some(url) = artifact.get("url").and_then(Value::as_str) else {
        return;
    };
    let target = root.join(path);
    let size = artifact.get("size").and_then(Value::as_u64).unwrap_or(0);
    if file_ok(&target, size) {
        return;
    }
    tasks.push(DownloadTask {
        url: url.to_string(),
        path: target,
        sha1: artifact
            .get("sha1")
            .and_then(Value::as_str)
            .map(str::to_string),
        size,
    });
}

fn artifact_url(artifact: &Value) -> Result<String> {
    artifact
        .get("url")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| LauncherError::Message("Download ohne URL.".into()))
}

fn os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

fn rule_matches(rule: &Value) -> bool {
    if let Some(os) = rule.get("os") {
        if let Some(name) = os.get("name").and_then(Value::as_str) {
            if name != os_name() {
                return false;
            }
        }
        if let Some(arch) = os.get("arch").and_then(Value::as_str) {
            let matches = match arch {
                "x86" => cfg!(target_arch = "x86"),
                "x86_64" | "amd64" => cfg!(target_arch = "x86_64"),
                "arm64" | "aarch64" => cfg!(target_arch = "aarch64"),
                _ => true,
            };
            if !matches {
                return false;
            }
        }
    }
    if let Some(features) = rule.get("features").and_then(Value::as_object) {
        for (feature, expected) in features {
            let actual = feature == "has_custom_resolution";
            if actual != expected.as_bool().unwrap_or(false) {
                return false;
            }
        }
    }
    true
}

fn rules_allowed(rules: Option<&Vec<Value>>) -> bool {
    let Some(rules) = rules else {
        return true;
    };
    let mut allowed = false;
    for rule in rules {
        if rule_matches(rule) {
            allowed = rule.get("action").and_then(Value::as_str).unwrap_or("allow") != "disallow";
        }
    }
    allowed
}

fn library_allowed(library: &Value) -> bool {
    rules_allowed(library.get("rules").and_then(Value::as_array))
}

fn native_classifier(library: &Value) -> Option<String> {
    let natives = library.get("natives")?.as_object()?;
    let classifier = natives.get(os_name())?.as_str()?;
    Some(classifier.replace(
        "${arch}",
        if cfg!(target_arch = "x86_64") { "64" } else { "32" },
    ))
}

fn extract_natives(jar: &Path, target: &Path) {
    let Ok(file) = std::fs::File::open(jar) else {
        return;
    };
    let Ok(mut archive) = zip::ZipArchive::new(file) else {
        return;
    };
    for index in 0..archive.len() {
        let Ok(mut entry) = archive.by_index(index) else {
            continue;
        };
        if entry.is_dir() {
            continue;
        }
        let name = entry.name().to_string();
        if name.starts_with("META-INF/") || name.ends_with(".sha1") {
            continue;
        }
        let Some(file_name) = Path::new(&name).file_name() else {
            continue;
        };
        let output = target.join(file_name);
        if let Ok(mut file) = std::fs::File::create(output) {
            let _ = std::io::copy(&mut entry, &mut file);
        }
    }
}

fn emit(sink: &ProgressSink, version: &str, stage: &str, current: u64, total: u64) {
    sink(InstallProgress {
        version: version.to_string(),
        stage: stage.to_string(),
        current,
        total,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Full end-to-end download of a real version. Ignored by default because it
    /// transfers several hundred megabytes; run it with `--ignored`.
    #[test]
    #[ignore = "downloads the complete game and Java runtime"]
    fn installs_a_complete_version() {
        let client = reqwest::Client::builder()
            .user_agent("OctoClientLauncher/0.1.0")
            .build()
            .expect("http client");
        let dir = std::env::temp_dir().join("frost-installer-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("test directory");

        let progress: ProgressSink = Arc::new(|update: InstallProgress| {
            if update.stage == "version" || update.current == update.total {
                println!(
                    "{} {}/{} ({})",
                    update.stage, update.current, update.total, update.version
                );
            }
        });

        let outcome = tauri::async_runtime::block_on(install(&client, &dir, "26.2", progress))
            .expect("install 26.2");
        println!(
            "installed {} ({} files, {} bytes, java {:?})",
            outcome.version, outcome.files, outcome.bytes, outcome.java_component
        );

        assert!(dir.join("versions/26.2/26.2.json").is_file());
        assert!(dir.join("versions/26.2/26.2.jar").is_file());
        assert!(dir.join("versions/26.2/.frost-installed").is_file());
        assert!(dir.join("assets/indexes").is_dir());
        assert!(dir.join("libraries").is_dir());

        let fabric = tauri::async_runtime::block_on(install_fabric(
            &client,
            &dir,
            "26.2",
            Arc::new(|_: InstallProgress| {}),
        ))
        .expect("install fabric");
        assert!(dir
            .join("versions")
            .join(&fabric.version_id)
            .join(format!("{}.json", fabric.version_id))
            .is_file());
        let fabric_manifest: Value = serde_json::from_str(
            &std::fs::read_to_string(
                dir.join("versions")
                    .join(&fabric.version_id)
                    .join(format!("{}.json", fabric.version_id)),
            )
            .expect("fabric manifest"),
        )
        .expect("fabric json");
        assert_eq!(
            fabric_manifest.get("mainClass").and_then(Value::as_str),
            Some("net.fabricmc.loader.impl.launch.knot.KnotClient")
        );
        assert!(fabric_manifest
            .get("libraries")
            .and_then(Value::as_array)
            .expect("fabric libraries")
            .iter()
            .any(|library| library
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|name| name.starts_with("net.fabricmc:fabric-loader:"))));
        println!("fabric profile {} (loader {})", fabric.version_id, fabric.loader_version);

        let java = tauri::async_runtime::block_on(ensure_java(
            &client,
            &dir,
            outcome.java_major,
            outcome.java_component.as_deref(),
            None,
            Arc::new(|_: InstallProgress| {}),
        ))
        .expect("java runtime");
        assert!(Path::new(&java.path).is_file());
        println!("java runtime: {} ({:?})", java.path, java.version);
    }
}

