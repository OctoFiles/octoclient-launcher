//! Java detection, version discovery and process launching.
//!
//! This module builds a complete Java command line from an installed version
//! manifest. Game files are installed by `installer.rs`; this module only reads
//! the manifest, resolves its argument templates and starts the game.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;
use serde_json::Value;

use crate::auth::account::Account;
use crate::config::LauncherConfig;
use crate::error::{LauncherError, Result};

pub const JAVA_EXE: &str = if cfg!(windows) { "java.exe" } else { "java" };
pub const CLASSPATH_SEPARATOR: &str = if cfg!(windows) { ";" } else { ":" };

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaInfo {
    pub path: String,
    pub version: Option<String>,
    pub vendor: Option<String>,
    /// Where the runtime was found: `configured`, `JAVA_HOME`, `PATH` or `scan`.
    pub source: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledVersion {
    pub id: String,
    #[serde(rename = "type")]
    pub version_type: String,
    pub released: Option<String>,
}

/// Finds a usable Java runtime, preferring the explicitly configured path.
pub fn detect_java(hint: Option<&str>) -> Option<JavaInfo> {
    for (candidate, source) in java_candidates(hint) {
        if !candidate.is_file() {
            continue;
        }
        if let Some(version) = read_java_version(&candidate) {
            return Some(JavaInfo {
                vendor: vendor_of(&version),
                version: Some(version),
                path: candidate.to_string_lossy().to_string(),
                source: source.to_string(),
            });
        }
    }
    None
}

/// Finds an already downloaded Mojang runtime inside the game directory.
/// This is what makes Java detection useful on machines without a system JDK.
pub fn detect_runtime_java(game_dir: &Path) -> Option<JavaInfo> {
    let entries = std::fs::read_dir(game_dir.join("runtime")).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        let exe = dir.join("bin").join(JAVA_EXE);
        if !exe.is_file() {
            continue;
        }
        if let Some(version) = read_java_version(&exe) {
            return Some(JavaInfo {
                path: exe.to_string_lossy().to_string(),
                version: Some(version),
                vendor: Some("Mojang Runtime".into()),
                source: "runtime".into(),
            });
        }
    }
    None
}

fn java_candidates(hint: Option<&str>) -> Vec<(PathBuf, &'static str)> {
    let mut candidates: Vec<(PathBuf, &'static str)> = Vec::new();

    let normalize = |raw: &str| -> Option<PathBuf> {
        let path = PathBuf::from(raw);
        if path.is_dir() {
            let joined = path.join("bin").join(JAVA_EXE);
            return joined.is_file().then_some(joined);
        }
        path.is_file().then_some(path)
    };

    if let Some(hint) = hint.and_then(|value| normalize(value)) {
        candidates.push((hint, "configured"));
    }
    if let Ok(home) = std::env::var("JAVA_HOME") {
        if let Some(path) = normalize(&home) {
            candidates.push((path, "JAVA_HOME"));
        }
    }
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_env) {
            let exe = dir.join(JAVA_EXE);
            if exe.is_file() {
                candidates.push((exe, "PATH"));
            }
        }
    }

    // Common JDK install locations (one level deep covers versioned folders).
    let mut scan_roots = if cfg!(windows) {
        vec![
            PathBuf::from("C:/Program Files/Java"),
            PathBuf::from("C:/Program Files/Eclipse Adoptium"),
            PathBuf::from("C:/Program Files/Microsoft"),
            PathBuf::from("C:/Program Files/Zulu"),
            PathBuf::from("C:/Program Files/Amazon Corretto"),
            PathBuf::from("C:/Program Files/BellSoft"),
            PathBuf::from("C:/Program Files/JetBrains"),
            PathBuf::from("C:/Program Files/Android/Android Studio/jbr"),
            PathBuf::from("C:/Program Files (x86)/Java"),
            PathBuf::from("C:/Program Files/Common Files/Oracle/Java"),
            PathBuf::from("C:/Program Files (x86)/Common Files/Oracle/Java"),
        ]
    } else {
        vec![
            PathBuf::from("/usr/lib/jvm"),
            PathBuf::from("/Library/Java/JavaVirtualMachines"),
        ]
    };

    // Launcher-bundled and per-user runtimes (Adoptium, Microsoft, IntelliJ).
    if cfg!(windows) {
        for env_key in ["LOCALAPPDATA", "USERPROFILE"] {
            if let Ok(base) = std::env::var(env_key) {
                let base = PathBuf::from(base);
                scan_roots.push(base.join("Programs/Eclipse Adoptium"));
                scan_roots.push(base.join("Programs/Microsoft"));
                scan_roots.push(base.join("Programs/Java"));
                scan_roots.push(base.join("Programs/Zulu"));
                scan_roots.push(base.join(".jdks"));
            }
        }
    }

    for root in scan_roots {
        // Some installers (Oracle javapath) put java.exe directly in the folder.
        let root_exe = root.join(JAVA_EXE);
        if root_exe.is_file() {
            candidates.push((root_exe, "scan"));
        }
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let dir = entry.path();
            let direct = dir.join("bin").join(JAVA_EXE);
            if direct.is_file() {
                candidates.push((direct, "scan"));
                continue;
            }
            let folder_exe = dir.join(JAVA_EXE);
            if folder_exe.is_file() {
                candidates.push((folder_exe, "scan"));
                continue;
            }
            // e.g. Adoptium/jdk-21.0.2+13 or macOS bundles.
            let nested = dir.join("Contents/Home/bin").join(JAVA_EXE);
            if nested.is_file() {
                candidates.push((nested, "scan"));
                continue;
            }
            if let Ok(children) = std::fs::read_dir(&dir) {
                for child in children.flatten() {
                    let exe = child.path().join("bin").join(JAVA_EXE);
                    if exe.is_file() {
                        candidates.push((exe, "scan"));
                    }
                }
            }
        }
    }

    // De-duplicate while keeping priority order.
    let mut seen = std::collections::HashSet::new();
    candidates.retain(|(path, _)| seen.insert(path.clone()));
    candidates
}

fn read_java_version(exe: &Path) -> Option<String> {
    let output = Command::new(exe).arg("-version").output().ok()?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
    parse_java_version(&text)
}

fn parse_java_version(text: &str) -> Option<String> {
    let start = text.find('"')? + 1;
    let rest = &text[start..];
    let end = rest.find('"')?;
    let version = rest[..end].trim();
    if version.is_empty() {
        None
    } else {
        Some(version.to_string())
    }
}

fn vendor_of(version: &str) -> Option<String> {
    let vendor = if version.starts_with("1.8") {
        "Oracle / Legacy"
    } else if version.contains("temurin") {
        "Eclipse Temurin"
    } else {
        "Java"
    };
    Some(vendor.to_string())
}

/// Reads `versions/<id>/<id>.json` manifests from the game directory.
pub fn scan_versions(game_dir: &Path) -> Vec<InstalledVersion> {
    let versions_dir = game_dir.join("versions");
    let Ok(entries) = std::fs::read_dir(&versions_dir) else {
        return Vec::new();
    };

    let mut versions = Vec::new();
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let Some(id) = dir
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
        else {
            continue;
        };
        let manifest = dir.join(format!("{id}.json"));
        let parsed = std::fs::read_to_string(&manifest)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());

        let version_type = parsed
            .as_ref()
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("release")
            .to_string();
        let released = parsed
            .as_ref()
            .and_then(|value| value.get("releaseTime"))
            .and_then(Value::as_str)
            .map(str::to_string);

        versions.push(InstalledVersion {
            id,
            version_type,
            released,
        });
    }

    versions.sort_by(|a, b| b.id.cmp(&a.id));
    versions
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

fn library_allowed(library: &Value) -> bool {
    let Some(rules) = library.get("rules").and_then(Value::as_array) else {
        return true;
    };
    let os = os_name();
    let mut allowed = false;
    for rule in rules {
        let action = rule.get("action").and_then(Value::as_str).unwrap_or("allow");
        let applies = match rule.get("os") {
            None => true,
            Some(spec) => spec
                .get("name")
                .and_then(Value::as_str)
                .map(|name| name == os)
                .unwrap_or(true),
        };
        if applies {
            allowed = action != "disallow";
        }
    }
    allowed
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchPlan {
    pub version: String,
    pub main_class: String,
    pub java: String,
    pub args: Vec<String>,
    pub note: String,
}

/// Builds the Java command line for an installed version.
///
/// Uses the argument templates from the version manifest (including rules for OS,
/// architecture and custom resolution), so modern versions such as 26.2 get the
/// JVM flags they require.
pub fn build_plan(
    config: &LauncherConfig,
    account: &Account,
    access_token: &str,
    version: &str,
    game_dir: &Path,
    java: &JavaInfo,
    version_label: Option<&str>,
) -> Result<LaunchPlan> {
    let version_dir = game_dir.join("versions").join(version);
    let manifest_path = version_dir.join(format!("{version}.json"));
    if !manifest_path.is_file() {
        return Err(LauncherError::VersionMissing(version.to_string()));
    }

    let raw = std::fs::read_to_string(&manifest_path)?;
    let manifest: Value = serde_json::from_str(&raw)?;

    let main_class = manifest
        .get("mainClass")
        .and_then(Value::as_str)
        .unwrap_or("net.minecraft.client.main.Main")
        .to_string();

    let asset_index = manifest
        .get("assetIndex")
        .and_then(|index| index.get("id"))
        .and_then(Value::as_str)
        .unwrap_or(version)
        .to_string();
    let assets_dir = game_dir.join("assets");
    let natives_dir = version_dir.join("natives");

    let mut classpath_entries: Vec<String> = Vec::new();
    if let Some(libraries) = manifest.get("libraries").and_then(Value::as_array) {
        for library in libraries {
            if !library_allowed(library) {
                continue;
            }
            if let Some(path) = library
                .get("downloads")
                .and_then(|downloads| downloads.get("artifact"))
                .and_then(|artifact| artifact.get("path"))
                .and_then(Value::as_str)
            {
                let full = game_dir.join("libraries").join(path);
                if full.is_file() {
                    classpath_entries.push(full.to_string_lossy().to_string());
                }
            }
        }
    }

    let client_jar = version_dir.join(format!("{version}.jar"));
    if client_jar.is_file() {
        classpath_entries.push(client_jar.to_string_lossy().to_string());
    }
    if classpath_entries.is_empty() {
        return Err(LauncherError::Message(format!(
            "Für {version} wurden keine Spieldateien gefunden. Das Profil ist unvollständig."
        )));
    }
    let classpath = classpath_entries.join(CLASSPATH_SEPARATOR);

    let mut args: Vec<String> = Vec::new();
    args.push(format!("-Xms{}M", config.java.min_ram_mb));
    args.push(format!("-Xmx{}M", config.java.max_ram_mb));
    if !config.java.extra_jvm_args.trim().is_empty() {
        for part in config.java.extra_jvm_args.split_whitespace() {
            args.push(part.to_string());
        }
    }
    let display_version = version_label.unwrap_or(version);
    let mut context: HashMap<&str, String> = HashMap::new();
    context.insert("auth_player_name", account.username.clone());
    context.insert("version_name", display_version.to_string());
    context.insert(
        "game_directory",
        game_dir.to_string_lossy().to_string(),
    );
    context.insert("assets_root", assets_dir.to_string_lossy().to_string());
    context.insert("game_assets", assets_dir.to_string_lossy().to_string());
    context.insert("assets_index_name", asset_index.clone());
    context.insert("auth_uuid", account.uuid.replace('-', ""));
    context.insert("auth_access_token", access_token.to_string());
    context.insert(
        "auth_session",
        format!("token:{}", access_token),
    );
    context.insert("user_type", "msa".into());
    context.insert("version_type", "OctoClient".into());
    context.insert("user_properties", "{}".into());
    context.insert("clientid", String::new());
    context.insert("auth_xuid", String::new());
    context.insert("launcher_name", "OctoClient".into());
    context.insert("launcher_version", "0.1.0".into());
    context.insert(
        "natives_directory",
        natives_dir.to_string_lossy().to_string(),
    );
    context.insert(
        "library_directory",
        game_dir.join("libraries").to_string_lossy().to_string(),
    );
    context.insert("classpath", classpath);
    context.insert("classpath_separator", CLASSPATH_SEPARATOR.into());
    context.insert("resolution_width", config.game.width.to_string());
    context.insert("resolution_height", config.game.height.to_string());
    context.insert("quickPlayPath", String::new());

    // Modern manifests define JVM and game arguments; older ones only have the
    // legacy `minecraftArguments` string.
    if let Some(jvm_args) = manifest
        .pointer("/arguments/jvm")
        .and_then(Value::as_array)
    {
        args.extend(resolve_arguments(jvm_args, &context));
    } else {
        if natives_dir.is_dir() {
            args.push(format!(
                "-Djava.library.path={}",
                natives_dir.to_string_lossy()
            ));
        }
        args.push("-Dminecraft.launcher.brand=OctoClient".into());
        args.push("-Dminecraft.launcher.version=0.1.0".into());
        args.push("-cp".into());
        args.push(context.get("classpath").cloned().unwrap_or_default());
    }
    args.push(main_class.clone());

    if let Some(game_args) = manifest
        .pointer("/arguments/game")
        .and_then(Value::as_array)
    {
        args.extend(resolve_arguments(game_args, &context));
    } else if let Some(legacy) = manifest.get("minecraftArguments").and_then(Value::as_str) {
        for token in legacy.split_whitespace() {
            args.push(substitute(token, &context));
        }
    }

    // Legacy manifests do not include the window size.
    if !args.iter().any(|arg| arg == "--width") {
        args.push("--width".into());
        args.push(config.game.width.to_string());
        args.push("--height".into());
        args.push(config.game.height.to_string());
    }
    if config.game.fullscreen && !args.iter().any(|arg| arg == "--fullscreen") {
        args.push("--fullscreen".into());
    }

    Ok(LaunchPlan {
        version: display_version.to_string(),
        main_class,
        java: java.path.clone(),
        args,
        note: format!(
            "Startet {} mit {} MB RAM über {}.",
            display_version, config.java.max_ram_mb, java.path
        ),
    })
}

fn substitute(template: &str, context: &HashMap<&str, String>) -> String {
    let mut value = template.to_string();
    for (key, replacement) in context {
        value = value.replace(&format!("${{{key}}}"), replacement);
    }
    value
}

fn argument_rule_matches(rule: &Value) -> bool {
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
            // The launcher always passes width/height, so custom resolution is on.
            let actual = feature == "has_custom_resolution";
            if actual != expected.as_bool().unwrap_or(false) {
                return false;
            }
        }
    }
    true
}

fn argument_allowed(entry: &Value) -> bool {
    let Some(rules) = entry.get("rules").and_then(Value::as_array) else {
        return true;
    };
    let mut allowed = false;
    for rule in rules {
        if argument_rule_matches(rule) {
            allowed = rule.get("action").and_then(Value::as_str).unwrap_or("allow") != "disallow";
        }
    }
    allowed
}

fn resolve_arguments(entries: &[Value], context: &HashMap<&str, String>) -> Vec<String> {
    let mut args = Vec::new();
    for entry in entries {
        if let Some(text) = entry.as_str() {
            args.push(substitute(text, context));
            continue;
        }
        if !argument_allowed(entry) {
            continue;
        }
        match entry.get("value") {
            Some(Value::String(text)) => args.push(substitute(text, context)),
            Some(Value::Array(values)) => {
                for value in values {
                    if let Some(text) = value.as_str() {
                        args.push(substitute(text, context));
                    }
                }
            }
            _ => {}
        }
    }
    args
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "needs the downloaded test install" ]
    fn builds_a_modern_launch_plan() {
        let game_dir = std::env::temp_dir().join("frost-installer-test");
        // Only meaningful after the ignored installer test has run.
        if !game_dir.join("versions/26.2/26.2.json").is_file() {
            return;
        }
        let config = LauncherConfig::default();
        let account = Account {
            username: "TestPlayer".into(),
            uuid: "00000000-0000-0000-0000-000000000000".into(),
            skin_data_url: None,
            signed_in_at: String::new(),
            expires_at: 0,
        };
        let java = JavaInfo {
            path: game_dir
                .join("runtime/java-runtime-epsilon/bin/java.exe")
                .to_string_lossy()
                .to_string(),
            version: Some("25.0.1".into()),
            vendor: None,
            source: "runtime".into(),
        };

        let plan = build_plan(&config, &account, "token", "26.2", &game_dir, &java, None)
            .expect("launch plan");
        assert!(plan
            .args
            .iter()
            .any(|arg| arg == "--sun-misc-unsafe-memory-access=allow"));
        assert!(plan.args.iter().any(|arg| arg.contains("26.2.jar")));
        assert!(plan.args.iter().any(|arg| arg == "--assetIndex"));
        assert!(plan.args.iter().any(|arg| arg == "net.minecraft.client.main.Main"));
        assert!(plan.args.iter().any(|arg| arg == "TestPlayer"));
        println!("launch plan with {} arguments", plan.args.len());

        let fabric_dir = std::fs::read_dir(game_dir.join("versions"))
            .expect("versions directory")
            .flatten()
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("fabric-loader-")
            })
            .map(|entry| entry.file_name().to_string_lossy().to_string());
        if let Some(fabric_id) = fabric_dir {
            let plan = build_plan(
                &config,
                &account,
                "token",
                &fabric_id,
                &game_dir,
                &java,
                Some("Fabric 26.2"),
            )
            .expect("fabric launch plan");
            assert!(plan
                .args
                .iter()
                .any(|arg| arg == "net.fabricmc.loader.impl.launch.knot.KnotClient"));
            assert!(plan.args.windows(2).any(|pair| {
                pair[0] == "--version" && pair[1] == "Fabric 26.2"
            }));
            assert!(plan
                .args
                .iter()
                .any(|arg| arg.contains("fabric-loader")));
            println!(
                "fabric launch plan {} with {} arguments",
                fabric_id,
                plan.args.len()
            );
        }
    }
}

/// Spawns the game process and returns its PID.
pub fn spawn_game(plan: &LaunchPlan, game_dir: &Path, show_console: bool) -> Result<u32> {
    let mut command = Command::new(&plan.java);
    command
        .args(&plan.args)
        .current_dir(game_dir)
        .stdin(Stdio::null());

    if !show_console {
        command.stdout(Stdio::null()).stderr(Stdio::null());
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if !show_console {
            command.creation_flags(CREATE_NO_WINDOW);
        }
    }

    let child = command
        .spawn()
        .map_err(|err| LauncherError::Message(format!("Java konnte nicht gestartet werden: {err}")))?;
    Ok(child.id())
}
