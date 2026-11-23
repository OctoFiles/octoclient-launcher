//! Instance folders and their content manifest.
//!
//! Every instance owns a game directory (created on demand). Installed mods,
//! resource packs and shaders are listed from disk, enriched with the metadata
//! from `instance-content.json` (title, icon, project id) and exposed to the UI.
//! Nothing here decides *where* an instance lives — commands resolve the path.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{LauncherError, Result};
use crate::storage;

pub const CONTENT_FILE: &str = "instance-content.json";
pub const CONTENT_FOLDERS: [(&str, &str); 3] = [
    ("mods", "mod"),
    ("resourcepacks", "resourcepack"),
    ("shaderpacks", "shader"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ContentEntry {
    /// Path relative to the instance directory, using `/`.
    pub path: String,
    /// `mod`, `resourcepack` or `shader`.
    pub kind: String,
    pub project_id: Option<String>,
    pub title: String,
    pub icon_url: Option<String>,
    pub version_number: Option<String>,
    pub size: u64,
}

impl Default for ContentEntry {
    fn default() -> Self {
        Self {
            path: String::new(),
            kind: String::new(),
            project_id: None,
            title: String::new(),
            icon_url: None,
            version_number: None,
            size: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InstalledPack {
    pub project_id: String,
    pub title: String,
    pub icon_url: Option<String>,
    pub version_number: String,
    pub installed_at: String,
    pub loader: Option<String>,
    pub game_version: Option<String>,
    /// Files written by the pack (relative paths) for clean removal.
    pub files: Vec<String>,
}

impl Default for InstalledPack {
    fn default() -> Self {
        Self {
            project_id: String::new(),
            title: String::new(),
            icon_url: None,
            version_number: String::new(),
            installed_at: String::new(),
            loader: None,
            game_version: None,
            files: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ContentManifest {
    pub version: u32,
    pub entries: Vec<ContentEntry>,
    pub packs: Vec<InstalledPack>,
}

impl Default for ContentManifest {
    fn default() -> Self {
        Self {
            version: 1,
            entries: Vec::new(),
            packs: Vec::new(),
        }
    }
}

impl ContentManifest {
    pub fn load(dir: &Path) -> Result<Self> {
        Ok(storage::read_json::<Self>(&dir.join(CONTENT_FILE))?.unwrap_or_default())
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        storage::write_json(&dir.join(CONTENT_FILE), self)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentSnapshot {
    pub directory: String,
    pub entries: Vec<ContentEntry>,
    pub packs: Vec<InstalledPack>,
}

/// Creates the standard instance folder layout.
pub fn ensure_layout(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    for (folder, _) in CONTENT_FOLDERS {
        std::fs::create_dir_all(dir.join(folder))?;
    }
    std::fs::create_dir_all(dir.join("config"))?;
    Ok(())
}

pub fn folder_for(kind: &str) -> Option<&'static str> {
    CONTENT_FOLDERS
        .iter()
        .find(|(_, entry_kind)| *entry_kind == kind)
        .map(|(folder, _)| *folder)
}

/// Rejects absolute paths and `..` so API-provided paths cannot escape the instance.
pub fn safe_relative(path: &str) -> Option<PathBuf> {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') {
        return None;
    }
    let mut out = PathBuf::new();
    for part in normalized.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return None;
        }
        out.push(part);
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Adds/updates one entry and persists the manifest.
pub fn upsert_entry(dir: &Path, manifest: &mut ContentManifest, entry: ContentEntry) -> Result<()> {
    manifest.entries.retain(|existing| existing.path != entry.path);
    manifest.entries.push(entry);
    manifest.save(dir)
}

pub fn record_pack(
    dir: &Path,
    manifest: &mut ContentManifest,
    pack: InstalledPack,
    entries: Vec<ContentEntry>,
) -> Result<()> {
    for entry in entries {
        manifest.entries.retain(|existing| existing.path != entry.path);
        manifest.entries.push(entry);
    }
    manifest.packs.retain(|existing| existing.project_id != pack.project_id);
    manifest.packs.push(pack);
    manifest.save(dir)
}

/// Lists installed content: manifest entries plus files dropped in manually.
pub fn snapshot(dir: &Path, manifest: &mut ContentManifest) -> Result<ContentSnapshot> {
    ensure_layout(dir)?;
    manifest.entries.retain(|entry| dir.join(&entry.path).exists());

    for (folder, kind) in CONTENT_FOLDERS {
        let Ok(read_dir) = std::fs::read_dir(dir.join(folder)) else {
            continue;
        };
        for item in read_dir.flatten() {
            let Ok(metadata) = item.metadata() else {
                continue;
            };
            let name = item.file_name().to_string_lossy().to_string();
            let relative = format!("{folder}/{name}");
            if manifest.entries.iter().any(|entry| entry.path == relative) {
                continue;
            }
            manifest.entries.push(ContentEntry {
                path: relative,
                kind: kind.to_string(),
                project_id: None,
                title: name,
                icon_url: None,
                version_number: None,
                size: if metadata.is_file() { metadata.len() } else { 0 },
            });
        }
    }

    manifest.save(dir)?;

    let mut entries = manifest.entries.clone();
    entries.sort_by(|left, right| {
        left.kind
            .cmp(&right.kind)
            .then_with(|| left.title.to_lowercase().cmp(&right.title.to_lowercase()))
    });

    Ok(ContentSnapshot {
        directory: dir.to_string_lossy().to_string(),
        entries,
        packs: manifest.packs.clone(),
    })
}

/// Copies dropped files into the matching content folder.
///
/// With an explicit `kind` only files that fit that folder are accepted.
/// Without one (the overview tab) the extension decides: `.jar` becomes a mod,
/// `.zip`/`.mcpack` a resource pack. Returns the number of imported files and
/// the names that were skipped.
pub fn import_files(
    dir: &Path,
    manifest: &mut ContentManifest,
    kind: Option<&str>,
    paths: &[String],
) -> Result<(usize, Vec<String>)> {
    ensure_layout(dir)?;
    let mut imported = 0usize;
    let mut skipped: Vec<String> = Vec::new();

    for raw in paths {
        let source = Path::new(raw);
        let label = source
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| raw.clone());

        if !source.is_file() {
            skipped.push(label);
            continue;
        }
        let extension = source
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();

        let target_kind = match kind {
            Some("mod") => "mod",
            Some("resourcepack") => "resourcepack",
            Some("shader") => "shader",
            _ => match extension.as_str() {
                "jar" => "mod",
                "zip" | "mcpack" => "resourcepack",
                _ => "",
            },
        };

        let accepted = match target_kind {
            "mod" => extension == "jar",
            "resourcepack" => matches!(extension.as_str(), "zip" | "mcpack"),
            "shader" => extension == "zip",
            _ => false,
        };
        let Some(folder) = folder_for(target_kind).filter(|_| accepted) else {
            skipped.push(label);
            continue;
        };

        let file_name = sanitize_file_name(&label);
        let relative = format!("{folder}/{file_name}");
        let target = dir.join(folder).join(&file_name);
        std::fs::copy(source, &target)?;
        let size = std::fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0);
        let title = source
            .file_stem()
            .map(|value| value.to_string_lossy().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| file_name.clone());

        upsert_entry(
            dir,
            manifest,
            ContentEntry {
                path: relative,
                kind: target_kind.to_string(),
                project_id: None,
                title,
                icon_url: None,
                version_number: None,
                size,
            },
        )?;
        imported += 1;
    }

    Ok((imported, skipped))
}

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric()
                || matches!(character, '-' | '_' | '.' | ' ' | '(' | ')' | '+')
            {
                character
            } else {
                '_'
            }
        })
        .take(120)
        .collect();
    let trimmed = cleaned.trim_matches([' ', '.']).to_string();
    if trimmed.is_empty() {
        "datei".into()
    } else {
        trimmed
    }
}

pub fn remove_content(
    dir: &Path,
    manifest: &mut ContentManifest,
    kind: &str,
    path: &str,
) -> Result<()> {
    let folder = folder_for(kind)
        .ok_or_else(|| LauncherError::Invalid(format!("Unbekannter Inhaltstyp: {kind}")))?;
    let relative = safe_relative(path)
        .ok_or_else(|| LauncherError::Invalid("Ungültiger Dateipfad.".into()))?;
    if !relative.starts_with(folder) {
        return Err(LauncherError::Invalid(
            "Die Datei liegt nicht im passenden Inhaltsordner.".into(),
        ));
    }

    let target = dir.join(&relative);
    if target.is_dir() {
        std::fs::remove_dir_all(&target)?;
    } else if target.is_file() {
        std::fs::remove_file(&target)?;
    }

    manifest.entries.retain(|entry| entry.path != path);
    manifest.save(dir)
}

pub fn remove_pack(dir: &Path, manifest: &mut ContentManifest, project_id: &str) -> Result<()> {
    let Some(pack) = manifest
        .packs
        .iter()
        .find(|pack| pack.project_id == project_id)
        .cloned()
    else {
        return Ok(());
    };

    for file in &pack.files {
        let Some(relative) = safe_relative(file) else {
            continue;
        };
        let target = dir.join(&relative);
        if target.is_file() {
            let _ = std::fs::remove_file(target);
        }
    }

    manifest
        .entries
        .retain(|entry| !pack.files.iter().any(|file| file == &entry.path));
    manifest.packs.retain(|pack| pack.project_id != project_id);
    manifest.save(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_dropped_files_into_the_matching_folder() {
        let dir = std::env::temp_dir().join(format!(
            "frost-import-test-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        ensure_layout(&dir).expect("layout");

        let mod_source = dir.join("Example Mod.jar");
        let pack_source = dir.join("Example Pack.zip");
        std::fs::write(&mod_source, b"jar").expect("mod source");
        std::fs::write(&pack_source, b"zip").expect("pack source");

        let mut manifest = ContentManifest::default();
        let (imported, skipped) = import_files(
            &dir,
            &mut manifest,
            Some("mod"),
            &[mod_source.to_string_lossy().to_string()],
        )
        .expect("import mod");
        assert_eq!(imported, 1);
        assert!(skipped.is_empty());
        assert!(dir.join("mods/Example Mod.jar").is_file());
        assert!(manifest
            .entries
            .iter()
            .any(|entry| entry.path == "mods/Example Mod.jar" && entry.kind == "mod"));

        let (imported, skipped) = import_files(
            &dir,
            &mut manifest,
            None,
            &[pack_source.to_string_lossy().to_string()],
        )
        .expect("import pack");
        assert_eq!(imported, 1);
        assert!(skipped.is_empty());
        assert!(dir.join("resourcepacks/Example Pack.zip").is_file());
        assert!(manifest
            .entries
            .iter()
            .any(|entry| entry.path == "resourcepacks/Example Pack.zip"));

        // Wrong file types are reported instead of silently copied.
        let (imported, skipped) = import_files(
            &dir,
            &mut manifest,
            Some("shader"),
            &[mod_source.to_string_lossy().to_string()],
        )
        .expect("reject mod as shader");
        assert_eq!(imported, 0);
        assert_eq!(skipped.len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
