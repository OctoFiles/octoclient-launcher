//! Instance management: live versions, content folders and Modrinth installs.

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::config::LauncherConfig;
use crate::error::{LauncherError, Result};
use crate::instances::{self, ContentEntry, ContentManifest, ContentSnapshot, InstalledPack};
use crate::minecraft_meta::{self, VersionCatalog};
use crate::modrinth;
use crate::state::AppState;

use super::instance_dir_for;

#[tauri::command]
pub async fn list_minecraft_versions(
    state: State<'_, AppState>,
    force: Option<bool>,
) -> Result<VersionCatalog> {
    minecraft_meta::catalog(
        &state.http,
        &state.paths.version_cache_file,
        force.unwrap_or(false),
    )
    .await
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub loader: String,
    pub directory: String,
    pub installed_versions: Vec<String>,
    pub mods: usize,
    pub resourcepacks: usize,
    pub shaderpacks: usize,
    pub packs: usize,
}

#[tauri::command]
pub fn instance_info(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<InstanceInfo> {
    let config = state.config();
    let (instance, dir) = instance_dir_for(&app, &state, &config, &instance_id)?;
    instances::ensure_layout(&dir)?;
    let mut manifest = ContentManifest::load(&dir)?;
    let snapshot = instances::snapshot(&dir, &mut manifest)?;
    let count = |kind: &str| {
        snapshot
            .entries
            .iter()
            .filter(|entry| entry.kind == kind)
            .count()
    };

    Ok(InstanceInfo {
        id: instance.id,
        name: instance.name,
        version: instance.version.clone(),
        loader: instance.mod_profile.clone(),
        directory: dir.to_string_lossy().to_string(),
        installed_versions: crate::launcher::scan_versions(&dir)
            .into_iter()
            .map(|entry| entry.id)
            .collect(),
        mods: count("mod"),
        resourcepacks: count("resourcepack"),
        shaderpacks: count("shader"),
        packs: snapshot.packs.len(),
    })
}

#[tauri::command]
pub fn list_instance_content(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<ContentSnapshot> {
    let config = state.config();
    let (_, dir) = instance_dir_for(&app, &state, &config, &instance_id)?;
    let mut manifest = ContentManifest::load(&dir)?;
    instances::snapshot(&dir, &mut manifest)
}

#[tauri::command]
pub async fn search_modrinth(
    state: State<'_, AppState>,
    query: String,
    kind: String,
    loader: Option<String>,
    game_version: Option<String>,
    offset: Option<u32>,
) -> Result<modrinth::SearchResults> {
    if !matches!(kind.as_str(), "mod" | "resourcepack" | "shader" | "modpack") {
        return Err(LauncherError::Invalid(format!(
            "Unbekannter Inhaltstyp: {kind}"
        )));
    }
    modrinth::search(
        &state.http,
        &query,
        &kind,
        loader.as_deref(),
        game_version.as_deref(),
        offset.unwrap_or(0),
    )
    .await
}

#[tauri::command]
pub async fn install_modrinth_content(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    project_id: String,
    kind: String,
) -> Result<ContentSnapshot> {
    let config = state.config();
    let (instance, dir) = instance_dir_for(&app, &state, &config, &instance_id)?;
    instances::ensure_layout(&dir)?;

    if kind == "mod" && instance.mod_profile == "vanilla" {
        return Err(LauncherError::Invalid(
            "Vanilla kann keine Mods laden. Stelle die Instanz auf Fabric oder Forge."
                .into(),
        ));
    }

    let installed = modrinth::install_content(
        &state.http,
        &dir,
        &project_id,
        &kind,
        &instance.mod_profile,
        &instance.version,
    )
    .await?;

    let mut manifest = ContentManifest::load(&dir)?;
    instances::upsert_entry(
        &dir,
        &mut manifest,
        ContentEntry {
            path: installed.path,
            kind: installed.kind,
            project_id: Some(installed.project_id),
            title: installed.title,
            icon_url: installed.icon_url,
            version_number: Some(installed.version_number),
            size: installed.size,
        },
    )?;

    instances::snapshot(&dir, &mut manifest)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModpackResult {
    pub config: LauncherConfig,
    pub snapshot: ContentSnapshot,
    pub pack: InstalledPack,
}

#[tauri::command]
pub async fn install_modrinth_modpack(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    project_id: String,
) -> Result<ModpackResult> {
    let config = state.config();
    let (instance, dir) = instance_dir_for(&app, &state, &config, &instance_id)?;
    instances::ensure_layout(&dir)?;

    let outcome =
        modrinth::install_modpack(&state.http, &dir, &project_id, &instance.version).await?;

    let pack = InstalledPack {
        project_id,
        title: outcome.title.clone(),
        icon_url: outcome.icon_url.clone(),
        version_number: outcome.version_number.clone(),
        installed_at: chrono::Utc::now().to_rfc3339(),
        loader: outcome.loader.clone(),
        game_version: outcome.game_version.clone(),
        files: outcome.files.clone(),
    };

    let entries: Vec<ContentEntry> = outcome
        .entries
        .into_iter()
        .map(|entry| ContentEntry {
            path: entry.path,
            kind: entry.kind,
            project_id: None,
            title: entry.title,
            icon_url: None,
            version_number: None,
            size: entry.size,
        })
        .collect();

    let mut manifest = ContentManifest::load(&dir)?;
    instances::record_pack(&dir, &mut manifest, pack.clone(), entries)?;
    let snapshot = instances::snapshot(&dir, &mut manifest)?;

    // The pack defines its own Minecraft version and loader; adopt them.
    let next_version = outcome.game_version.clone();
    let next_loader = outcome.loader.clone();
    if next_version.is_some() || next_loader.is_some() {
        state.update_config(|config| {
            if let Some(instance) = config
                .instances
                .iter_mut()
                .find(|instance| instance.id == instance_id)
            {
                if let Some(version) = next_version.as_ref() {
                    instance.version = version.clone();
                }
                if let Some(loader) = next_loader.as_ref() {
                    instance.mod_profile = loader.clone();
                }
            }
        })?;
    }

    Ok(ModpackResult {
        config: state.config(),
        snapshot,
        pack,
    })
}

#[tauri::command]
pub fn remove_instance_content(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    kind: String,
    path: String,
) -> Result<ContentSnapshot> {
    let config = state.config();
    let (_, dir) = instance_dir_for(&app, &state, &config, &instance_id)?;
    let mut manifest = ContentManifest::load(&dir)?;
    instances::remove_content(&dir, &mut manifest, &kind, &path)?;
    instances::snapshot(&dir, &mut manifest)
}

#[tauri::command]
pub fn remove_instance_modpack(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    project_id: String,
) -> Result<ContentSnapshot> {
    let config = state.config();
    let (_, dir) = instance_dir_for(&app, &state, &config, &instance_id)?;
    let mut manifest = ContentManifest::load(&dir)?;
    instances::remove_pack(&dir, &mut manifest, &project_id)?;
    instances::snapshot(&dir, &mut manifest)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub imported: usize,
    pub skipped: Vec<String>,
    pub snapshot: ContentSnapshot,
}

/// Imports files dropped onto the instance window (mods, packs, shaders).
#[tauri::command]
pub fn import_instance_files(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
    paths: Vec<String>,
    kind: Option<String>,
) -> Result<ImportOutcome> {
    let config = state.config();
    let (_, dir) = instance_dir_for(&app, &state, &config, &instance_id)?;
    instances::ensure_layout(&dir)?;
    let mut manifest = ContentManifest::load(&dir)?;
    let (imported, skipped) =
        instances::import_files(&dir, &mut manifest, kind.as_deref(), &paths)?;
    let snapshot = instances::snapshot(&dir, &mut manifest)?;
    Ok(ImportOutcome {
        imported,
        skipped,
        snapshot,
    })
}

#[tauri::command]
pub fn open_instance_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<String> {
    let config = state.config();
    let (_, dir) = instance_dir_for(&app, &state, &config, &instance_id)?;
    instances::ensure_layout(&dir)?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|err| {
            LauncherError::Message(format!("Ordner konnte nicht geöffnet werden: {err}"))
        })?;
    Ok(dir.to_string_lossy().to_string())
}

#[derive(Debug, serde::Deserialize)]
struct PackIndex {
    #[serde(default)]
    files: Vec<PackIndexFile>,
}

#[derive(Debug, serde::Deserialize)]
struct PackIndexFile {
    path: String,
    #[serde(default)]
    downloads: Vec<String>,
}

/// Imports a local `.mrpack`, `.noriskpack`, `.octopack` or `.zip` pack into
/// the active instance. Modrinth packs download their listed files; overrides
/// from any format are extracted below `overrides/`.
#[tauri::command]
pub async fn import_pack_file(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    data: String,
) -> Result<ImportOutcome> {
    use base64::Engine as _;
    use std::io::Read;

    let _ = &name;
    let payload = data.split_once(',').map(|(_, body)| body).unwrap_or(&data);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| LauncherError::Invalid("Die Paketdatei konnte nicht gelesen werden.".into()))?;
    let config = state.config();
    let (_, dir) = super::active_instance_dir(&app, &state, &config)?;
    instances::ensure_layout(&dir)?;

    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| LauncherError::Invalid("Das Paket ist kein gültiges ZIP-Archiv.".into()))?;
    let names: Vec<String> = (0..archive.len())
        .filter_map(|index| archive.by_index(index).ok().map(|entry| entry.name().to_string()))
        .collect();
    let mut imported = 0usize;
    let mut skipped: Vec<String> = Vec::new();

    if let Some(index_pos) = names.iter().position(|entry| entry.ends_with("modrinth.index.json")) {
        let mut raw = String::new();
        archive
            .by_index(index_pos)
            .map_err(|_| LauncherError::Invalid("Der Modrinth-Index fehlt.".into()))?
            .read_to_string(&mut raw)?;
        let index: PackIndex = serde_json::from_str(&raw)?;
        for file in index.files {
            let Some(target) = instances::safe_relative(&file.path) else {
                skipped.push(file.path);
                continue;
            };
            let Some(url) = file.downloads.first() else {
                skipped.push(file.path);
                continue;
            };
            let response = state.http.get(url).send().await;
            let Ok(response) = response else {
                skipped.push(file.path);
                continue;
            };
            if !response.status().is_success() {
                skipped.push(file.path);
                continue;
            }
            let Some(bytes) = response.bytes().await.ok() else {
                skipped.push(file.path);
                continue;
            };
            let path = dir.join(target);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, bytes)?;
            imported += 1;
        }
    }

    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| LauncherError::Invalid("Das Paket ist beschädigt.".into()))?;
        let entry_name = entry.name().to_string();
        let relative = entry_name
            .strip_prefix("overrides/")
            .unwrap_or(&entry_name)
            .to_string();
        let Some(relative) = instances::safe_relative(&relative) else {
            continue;
        };
        if entry.unix_mode().map(|mode| mode & 0o170000 == 0o120000).unwrap_or(false) {
            continue;
        }
        if entry.is_dir() {
            std::fs::create_dir_all(dir.join(relative))?;
            continue;
        }
        if relative.components().count() == 1
            && relative.extension().and_then(|value| value.to_str()) == Some("json")
        {
            // Pack metadata, never game content.
            continue;
        }
        let path = dir.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut content = Vec::new();
        entry.read_to_end(&mut content)?;
        std::fs::write(path, content)?;
        imported += 1;
    }

    let mut manifest = ContentManifest::load(&dir)?;
    let snapshot = instances::snapshot(&dir, &mut manifest)?;
    Ok(ImportOutcome {
        imported,
        skipped,
        snapshot,
    })
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackExport {
    pub path: String,
    pub entries: usize,
}

/// Writes the active (or given) instance's mods/config/packs into a portable
/// `.octopack` ZIP under `<app data>/exports` and returns its path.
#[tauri::command]
pub fn export_instance_pack(
    app: AppHandle,
    state: State<'_, AppState>,
    instance_id: Option<String>,
) -> Result<PackExport> {
    use std::io::Write;
    use tauri::Manager;

    let config = state.config();
    let id = instance_id.unwrap_or_else(|| config.active_instance_id.clone());
    let (instance, dir) = instance_dir_for(&app, &state, &config, &id)?;
    let export_dir = app.path().app_data_dir()?.join("exports");
    std::fs::create_dir_all(&export_dir)?;
    let safe_name: String = instance
        .name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect();
    let file_path = export_dir.join(format!(
        "{}-{}.octopack",
        safe_name.trim_matches('-'),
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ));

    let file = std::fs::File::create(&file_path)?;
    let mut zip = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let meta = serde_json::json!({
        "format": "octoclient-pack",
        "version": 1,
        "name": instance.name,
        "minecraft": instance.version,
        "loader": instance.mod_profile,
        "createdAt": chrono::Utc::now().to_rfc3339(),
    });
    zip.start_file("octoclient-pack.json", options)?;
    zip.write_all(serde_json::to_string_pretty(&meta)?.as_bytes())?;

    let mut entries = 0usize;
    let mut total = 0u64;
    for folder in ["mods", "config", "resourcepacks", "shaderpacks"] {
        let root = dir.join(folder);
        if root.is_dir() {
            add_pack_folder(&mut zip, &root, folder, options, &mut entries, &mut total)?;
        }
    }
    zip.finish()?;
    Ok(PackExport {
        path: file_path.to_string_lossy().to_string(),
        entries,
    })
}

fn add_pack_folder(
    zip: &mut zip::ZipWriter<std::fs::File>,
    root: &std::path::Path,
    prefix: &str,
    options: zip::write::SimpleFileOptions,
    entries: &mut usize,
    total: &mut u64,
) -> Result<()> {
    use std::io::Write;

    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let relative = format!("{prefix}/{name}");
        if path.is_dir() {
            add_pack_folder(zip, &path, &relative, options, entries, total)?;
            continue;
        }
        if !path.is_file() {
            continue;
        }
        let size = entry.metadata()?.len();
        if *total + size > 300 * 1024 * 1024 {
            continue;
        }
        *total += size;
        zip.start_file(format!("overrides/{relative}"), options)?;
        zip.write_all(&std::fs::read(&path)?)?;
        *entries += 1;
    }
    Ok(())
}
