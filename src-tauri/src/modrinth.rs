//! Modrinth API client.
//!
//! Search and download mods, resource packs, shaders and modpacks. Files are
//! written straight into the instance directory (`mods/`, `resourcepacks/`,
//! `shaderpacks/`); modpacks additionally extract their overrides.
//!
//! Modrinth requires a descriptive User-Agent and is happy with unauthenticated
//! requests. Nothing here needs an API key.

use std::collections::HashMap;
use std::io::{Cursor, Read};
use std::path::Path;

use serde::{Deserialize, Serialize};
use sha1::{Digest, Sha1};

use crate::error::{LauncherError, Result};
use crate::instances::safe_relative;

const API: &str = "https://api.modrinth.com/v2";
const USER_AGENT: &str = "OctoClientLauncher/0.1.0 (OctoClient Launcher)";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub project_id: String,
    pub slug: String,
    pub title: String,
    pub description: String,
    pub icon_url: Option<String>,
    pub downloads: u64,
    pub project_type: String,
    pub categories: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub hits: Vec<SearchHit>,
    pub total: u64,
    pub offset: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledContent {
    /// Path relative to the instance directory, using `/`.
    pub path: String,
    pub kind: String,
    pub project_id: String,
    pub title: String,
    pub icon_url: Option<String>,
    pub version_number: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackOutcome {
    pub title: String,
    pub icon_url: Option<String>,
    pub version_number: String,
    pub game_version: Option<String>,
    pub loader: Option<String>,
    pub files: Vec<String>,
    pub entries: Vec<InstalledContent>,
}

#[derive(Deserialize)]
struct RawSearch {
    hits: Vec<RawHit>,
    total_hits: u64,
}

#[derive(Deserialize)]
struct RawHit {
    project_id: String,
    slug: String,
    title: String,
    description: String,
    #[serde(default)]
    icon_url: Option<String>,
    downloads: u64,
    project_type: String,
    #[serde(default)]
    categories: Vec<String>,
}

#[derive(Deserialize)]
struct RawProject {
    title: String,
    #[serde(default)]
    icon_url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawVersionFile {
    url: String,
    filename: String,
    #[serde(default)]
    primary: bool,
    #[serde(default)]
    hashes: RawHashes,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct RawHashes {
    #[serde(default)]
    sha1: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RawVersion {
    version_number: String,
    files: Vec<RawVersionFile>,
}

/// `kind` is `mod`, `resourcepack`, `shader` or `modpack`.
pub async fn search(
    http: &reqwest::Client,
    query: &str,
    kind: &str,
    loader: Option<&str>,
    game_version: Option<&str>,
    offset: u32,
) -> Result<SearchResults> {
    let mut facets: Vec<Vec<String>> = vec![vec![format!("project_type:{kind}")]];
    if matches!(kind, "mod" | "modpack") {
        if let Some(loader) = loader.filter(|value| !value.is_empty() && *value != "vanilla") {
            facets.push(vec![format!("categories:{loader}")]);
        }
        if let Some(version) = game_version.filter(|value| !value.is_empty()) {
            facets.push(vec![format!("versions:{version}")]);
        }
    }
    let facets_json = serde_json::to_string(&facets)
        .map_err(|err| LauncherError::Message(format!("Filter konnten nicht gebaut werden: {err}")))?;

    let response = http
        .get(format!("{API}/search"))
        .header("User-Agent", USER_AGENT)
        .query(&[
            ("query", query.to_string()),
            ("facets", facets_json),
            ("limit", "20".to_string()),
            ("offset", offset.to_string()),
        ])
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        return Err(LauncherError::Message(format!(
            "Modrinth-Suche fehlgeschlagen (HTTP {}).",
            status.as_u16()
        )));
    }

    let raw: RawSearch = response.json().await?;
    Ok(SearchResults {
        total: raw.total_hits,
        offset,
        hits: raw
            .hits
            .into_iter()
            .map(|hit| SearchHit {
                project_id: hit.project_id,
                slug: hit.slug,
                title: hit.title,
                description: hit.description,
                icon_url: hit.icon_url,
                downloads: hit.downloads,
                project_type: hit.project_type,
                categories: hit.categories,
            })
            .collect(),
    })
}

/// Installs the best matching file of a project into `instance_dir`.
pub async fn install_content(
    http: &reqwest::Client,
    instance_dir: &Path,
    project_id: &str,
    kind: &str,
    loader: &str,
    game_version: &str,
) -> Result<InstalledContent> {
    let folder = match kind {
        "mod" => "mods",
        "resourcepack" => "resourcepacks",
        "shader" => "shaderpacks",
        other => {
            return Err(LauncherError::Invalid(format!(
                "Unbekannter Inhaltstyp: {other}"
            )))
        }
    };

    let versions = fetch_versions(http, project_id, kind, Some(loader), Some(game_version)).await?;
    let version = versions.into_iter().next().ok_or_else(|| {
        LauncherError::Message(format!(
            "Keine passende Datei für Minecraft {game_version} / {loader} gefunden."
        ))
    })?;
    let file = version
        .files
        .iter()
        .find(|file| file.primary)
        .or_else(|| version.files.first())
        .ok_or_else(|| LauncherError::Message("Die Version enthält keine Download-Datei.".into()))?;
    let file_name = safe_file_name(&file.filename)?;
    let target = instance_dir.join(folder).join(&file_name);
    let size = download(http, &file.url, &target, file.hashes.sha1.as_deref()).await?;

    let (title, icon_url) = match project_meta(http, project_id).await {
        Ok((title, icon)) => (title, icon),
        Err(_) => (file_name.clone(), None),
    };

    Ok(InstalledContent {
        path: format!("{folder}/{file_name}"),
        kind: kind.to_string(),
        project_id: project_id.to_string(),
        title,
        icon_url,
        version_number: version.version_number,
        size,
    })
}

/// Downloads a `.mrpack`, installs all listed files and extracts overrides.
pub async fn install_modpack(
    http: &reqwest::Client,
    instance_dir: &Path,
    project_id: &str,
    game_version: &str,
) -> Result<ModpackOutcome> {
    let versions = fetch_versions(http, project_id, "modpack", None, Some(game_version)).await?;
    let version = versions.into_iter().next().ok_or_else(|| {
        LauncherError::Message(format!(
            "Kein Modpack für Minecraft {game_version} gefunden."
        ))
    })?;
    let file = version
        .files
        .iter()
        .find(|file| file.primary)
        .or_else(|| version.files.first())
        .ok_or_else(|| LauncherError::Message("Das Modpack hat keine Download-Datei.".into()))?;

    let response = http
        .get(&file.url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(LauncherError::Message(format!(
            "Modpack-Download fehlgeschlagen (HTTP {}).",
            response.status().as_u16()
        )));
    }
    let bytes = response.bytes().await?;

    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|err| {
        LauncherError::Message(format!("Modpack-Archiv konnte nicht gelesen werden: {err}"))
    })?;

    let mut index_text = String::new();
    {
        let mut index_entry = archive.by_name("modrinth.index.json").map_err(|_| {
            LauncherError::Message("Das Modpack enthält keine modrinth.index.json.".into())
        })?;
        index_entry.read_to_string(&mut index_text)?;
    }
    let index: ModpackIndex = serde_json::from_str(&index_text)?;

    let mut written: Vec<String> = Vec::new();
    let mut entries: Vec<InstalledContent> = Vec::new();

    for pack_file in &index.files {
        if pack_file
            .env
            .as_ref()
            .and_then(|env| env.client.as_deref())
            == Some("unsupported")
        {
            continue;
        }
        let Some(relative) = safe_relative(&pack_file.path) else {
            continue;
        };
        let Some(url) = pack_file.downloads.first() else {
            continue;
        };
        let target = instance_dir.join(&relative);
        let size = download(http, url, &target, pack_file.hashes.sha1.as_deref()).await?;
        let relative_string = relative.to_string_lossy().replace('\\', "/");
        if let Some(kind) = kind_for_path(&relative_string) {
            entries.push(InstalledContent {
                title: file_title(&relative_string),
                path: relative_string.clone(),
                kind: kind.to_string(),
                project_id: String::new(),
                icon_url: None,
                version_number: String::new(),
                size,
            });
        }
        written.push(relative_string);
    }

    // Extract `overrides/` and `client-overrides/` into the instance.
    for entry_index in 0..archive.len() {
        let mut entry = archive.by_index(entry_index).map_err(|err| {
            LauncherError::Message(format!("Modpack-Eintrag konnte nicht gelesen werden: {err}"))
        })?;
        let name = entry.name().to_string();
        let rest = name
            .strip_prefix("overrides/")
            .or_else(|| name.strip_prefix("client-overrides/"));
        let Some(rest) = rest else {
            continue;
        };
        if rest.is_empty() {
            continue;
        }
        let Some(relative) = safe_relative(rest) else {
            continue;
        };
        let target = instance_dir.join(&relative);
        if entry.is_dir() {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut out = std::fs::File::create(&target)?;
        std::io::copy(&mut entry, &mut out)?;
        written.push(relative.to_string_lossy().replace('\\', "/"));
    }

    let (project_title, icon_url) = match project_meta(http, project_id).await {
        Ok((title, icon)) => (title, icon),
        Err(_) => (index.name.clone(), None),
    };

    let detected_game = index.dependencies.get("minecraft").cloned();
    let detected_loader = if index.dependencies.contains_key("fabric-loader") {
        Some("fabric".to_string())
    } else if index.dependencies.contains_key("forge") {
        Some("forge".to_string())
    } else {
        None
    };

    Ok(ModpackOutcome {
        title: if project_title.trim().is_empty() {
            index.name
        } else {
            project_title
        },
        icon_url,
        version_number: version.version_number,
        game_version: detected_game,
        loader: detected_loader,
        files: written,
        entries,
    })
}

async fn fetch_versions(
    http: &reqwest::Client,
    project_id: &str,
    kind: &str,
    loader: Option<&str>,
    game_version: Option<&str>,
) -> Result<Vec<RawVersion>> {
    let mut request = http
        .get(format!("{API}/project/{project_id}/version"))
        .header("User-Agent", USER_AGENT);

    if matches!(kind, "mod" | "modpack") {
        if let Some(loader) = loader.filter(|value| !value.is_empty() && *value != "vanilla") {
            let loaders = serde_json::to_string(&[loader]).unwrap_or_default();
            request = request.query(&[("loaders", loaders)]);
        }
        if let Some(version) = game_version.filter(|value| !value.is_empty()) {
            let versions = serde_json::to_string(&[version]).unwrap_or_default();
            request = request.query(&[("game_versions", versions)]);
        }
    }

    let response = request.send().await?;
    if !response.status().is_success() {
        return Err(LauncherError::Message(format!(
            "Modrinth-Versionen konnten nicht geladen werden (HTTP {}).",
            response.status().as_u16()
        )));
    }
    Ok(response.json::<Vec<RawVersion>>().await?)
}

async fn project_meta(
    http: &reqwest::Client,
    project_id: &str,
) -> Result<(String, Option<String>)> {
    let response = http
        .get(format!("{API}/project/{project_id}"))
        .header("User-Agent", USER_AGENT)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(LauncherError::Message("Projekt nicht gefunden.".into()));
    }
    let project: RawProject = response.json().await?;
    Ok((project.title, project.icon_url))
}

async fn download(
    http: &reqwest::Client,
    url: &str,
    target: &Path,
    sha1: Option<&str>,
) -> Result<u64> {
    let response = http
        .get(url)
        .header("User-Agent", USER_AGENT)
        .send()
        .await?;
    if !response.status().is_success() {
        return Err(LauncherError::Message(format!(
            "Download fehlgeschlagen (HTTP {}).",
            response.status().as_u16()
        )));
    }
    let bytes = response.bytes().await?;
    if let Some(expected) = sha1 {
        let actual = hex_sha1(&bytes);
        if !actual.eq_ignore_ascii_case(expected) {
            return Err(LauncherError::Message(
                "SHA1-Prüfung fehlgeschlagen – Download verworfen.".into(),
            ));
        }
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(target, &bytes)?;
    Ok(bytes.len() as u64)
}

fn hex_sha1(bytes: &[u8]) -> String {
    let mut hasher = Sha1::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn safe_file_name(name: &str) -> Result<String> {
    let cleaned = Path::new(name)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .unwrap_or_default();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        return Err(LauncherError::Invalid("Ungültiger Dateiname.".into()));
    }
    Ok(cleaned.replace(['\\', '/'], "_"))
}

fn kind_for_path(path: &str) -> Option<&'static str> {
    match path.split('/').next()? {
        "mods" => Some("mod"),
        "resourcepacks" => Some("resourcepack"),
        "shaderpacks" => Some("shader"),
        _ => None,
    }
}

fn file_title(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

#[derive(Deserialize)]
struct ModpackIndex {
    #[serde(default)]
    name: String,
    #[serde(default)]
    files: Vec<PackFile>,
    #[serde(default)]
    dependencies: HashMap<String, String>,
}

#[derive(Deserialize)]
struct PackFile {
    path: String,
    #[serde(default)]
    downloads: Vec<String>,
    #[serde(default)]
    hashes: RawHashes,
    #[serde(default)]
    env: Option<PackEnv>,
}

#[derive(Deserialize)]
struct PackEnv {
    #[serde(default)]
    client: Option<String>,
}
