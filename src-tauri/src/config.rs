//! Launcher configuration.
//!
//! One versioned struct persisted as JSON in the app config directory. Every
//! section is `#[serde(default)]`, so older configs keep working when new
//! fields are added — old keys are simply ignored and new ones get defaults.

use serde::{Deserialize, Serialize};

pub const CONFIG_VERSION: u32 = 3;
/// Upper bound for saved instances; keeps the UI and the config file sane.
pub const MAX_INSTANCES: usize = 24;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LauncherConfig {
    pub version: u32,
    pub profile: ProfileSelection,
    /// Saved setups (Minecraft version + mod profile), managed in the Instanzen tab.
    pub instances: Vec<Instance>,
    /// Instance used by PLAY and the launch command.
    pub active_instance_id: String,
    pub java: JavaSettings,
    pub game: GameSettings,
    pub launch: LaunchSettings,
    pub discord: DiscordSettings,
    pub appearance: AppearanceSettings,
    pub system: SystemSettings,
    pub integrations: IntegrationSettings,
}

impl Default for LauncherConfig {
    fn default() -> Self {
        Self {
            version: CONFIG_VERSION,
            profile: ProfileSelection::default(),
            instances: vec![Instance::default()],
            active_instance_id: Instance::default().id,
            java: JavaSettings::default(),
            game: GameSettings::default(),
            launch: LaunchSettings::default(),
            discord: DiscordSettings::default(),
            appearance: AppearanceSettings::default(),
            system: SystemSettings::default(),
            integrations: IntegrationSettings::default(),
        }
    }
}

impl LauncherConfig {
    /// Clamp untrusted values coming from the UI before they are persisted.
    pub fn normalized(mut self) -> Self {
        self.version = CONFIG_VERSION;

        self.java.max_ram_mb = self.java.max_ram_mb.clamp(1024, 65_536);
        self.java.min_ram_mb = self.java.min_ram_mb.clamp(512, self.java.max_ram_mb);
        self.java.extra_jvm_args = self.java.extra_jvm_args.trim().chars().take(2000).collect();
        self.java.path = clean_optional(self.java.path);

        self.game.width = self.game.width.clamp(320, 7680);
        self.game.height = self.game.height.clamp(240, 4320);
        self.game.directory = clean_optional(self.game.directory);

        self.profile.version = clean_required(self.profile.version, "1.21.10");
        self.profile.mod_profile = normalize_loader(clean_required(self.profile.mod_profile, "vanilla"));
        self.profile.skin_id = clean_required(self.profile.skin_id, "frost");
        self.profile.skin_model = match self.profile.skin_model.trim().to_ascii_lowercase().as_str() {
            "slim" => "slim".into(),
            _ => "classic".into(),
        };
        self.profile.cape_id = clean_required(self.profile.cape_id, "none");
        self.profile.accessory_id = clean_cosmetic(self.profile.accessory_id);
        self.profile.head_id = clean_cosmetic(self.profile.head_id);
        self.profile.bandana_id = clean_cosmetic(self.profile.bandana_id);
        self.profile.wing_id = clean_cosmetic(self.profile.wing_id);
        self.profile.shield_id = clean_cosmetic(self.profile.shield_id);
        // Launcher-only preview ids from older versions are no longer valid;
        // only `TYPE:id` keys from the mod's catalog are kept.
        for id in [
            &mut self.profile.cape_id,
            &mut self.profile.accessory_id,
            &mut self.profile.head_id,
            &mut self.profile.bandana_id,
            &mut self.profile.wing_id,
            &mut self.profile.shield_id,
        ] {
            if *id != "none" && !id.contains(':') {
                id.clear();
                id.push_str("none");
            }
        }
        let mut seen = std::collections::HashSet::new();
        self.profile.cosmetic_selection.retain(|id| {
            id.len() <= 120 && id.contains(':') && seen.insert(id.clone())
        });
        // A custom skin is stored inline as a small PNG data URL (64×64 stays
        // well below this cap). Anything else falls back to the account skin.
        self.profile.custom_skin_data_url = self.profile.custom_skin_data_url.and_then(|value| {
            let trimmed = value.trim();
            (trimmed.starts_with("data:image/png;base64,") && trimmed.len() <= 2_000_000)
                .then(|| trimmed.to_string())
        });
        let mut seen_skins = std::collections::HashSet::new();
        self.profile.custom_skins.retain(|entry| {
            let data = entry.data_url.trim();
            data.starts_with("data:image/png;base64,")
                && data.len() <= 2_000_000
                && seen_skins.insert(data.to_string())
        });
        for entry in &mut self.profile.custom_skins {
            entry.name = clean_required(entry.name.clone(), "Eigener Skin");
            entry.model = if entry.model.eq_ignore_ascii_case("slim") {
                "slim".into()
            } else {
                "classic".into()
            };
        }
        self.profile.custom_skins.truncate(24);
        self.normalize_instances();

        self.appearance.accent = normalize_color(self.appearance.accent, "#6ee7f9");
        self.appearance.corner_radius = self.appearance.corner_radius.min(28);
        self.appearance.tile_tint = normalize_color(self.appearance.tile_tint, "#6ee7f9");
        self.appearance.tile_opacity = self.appearance.tile_opacity.min(100);
        self.appearance.text_color = normalize_color(self.appearance.text_color, "#f3f8ff");
        self.appearance.font_family = match self.appearance.font_family.as_str() {
            "bahnschrift" | "georgia" | "mono" | "pixel" => self.appearance.font_family.clone(),
            _ => "standard".into(),
        };
        self.discord.app_id = clean_optional(self.discord.app_id)
            .filter(|value| value.chars().all(|character| character.is_ascii_digit()));
        self.appearance.background_color =
            normalize_color(self.appearance.background_color, "#070d18");
        self.appearance.background_image = self.appearance.background_image.and_then(|value| {
            let trimmed = value.trim();
            (trimmed.starts_with("data:image/")
                && trimmed.contains(";base64,")
                && trimmed.len() <= 6_000_000)
                .then(|| trimmed.to_string())
        });
        if self.appearance.background_mode == BackgroundMode::Image
            && self.appearance.background_image.is_none()
        {
            self.appearance.background_mode = BackgroundMode::Stars;
        }

        self.integrations.ms_client_id = clean_optional(self.integrations.ms_client_id);
        self.integrations.news_feed_url = clean_optional(self.integrations.news_feed_url);

        self
    }
}

impl LauncherConfig {
    /// Validates the instance list, migrates configs written before instances
    /// existed and mirrors the active instance into `profile.version` /
    /// `profile.mod_profile` so the existing launch path keeps working.
    fn normalize_instances(&mut self) {
        let mut cleaned: Vec<Instance> = Vec::with_capacity(self.instances.len());
        for instance in self.instances.drain(..).take(MAX_INSTANCES) {
            let id = instance.id.trim();
            if id.is_empty() || cleaned.iter().any(|entry| entry.id == id) {
                continue;
            }
            cleaned.push(Instance {
                id: id.chars().take(64).collect(),
                name: clean_required(instance.name, "Instanz"),
                version: clean_required(instance.version, "1.21.10"),
                mod_profile: normalize_loader(clean_required(instance.mod_profile, "vanilla")),
                favorite: instance.favorite,
                directory: clean_optional(instance.directory),
            });
        }

        // First start after the upgrade: turn the old version/profile choice into
        // one instance instead of losing the user's selection.
        if cleaned.is_empty() {
            let migrated_name = if self.profile.mod_profile == "vanilla" {
                format!("Vanilla {}", self.profile.version)
            } else {
                format!("{} · {}", self.profile.version, self.profile.mod_profile)
            };
            cleaned.push(Instance {
                name: migrated_name,
                version: self.profile.version.clone(),
                mod_profile: self.profile.mod_profile.clone(),
                ..Instance::default()
            });
        }

        if !cleaned.iter().any(|entry| entry.id == self.active_instance_id) {
            self.active_instance_id = cleaned[0].id.clone();
        }

        // The active instance must stay selectable on the Play screen.
        if !cleaned.iter().any(|entry| entry.favorite) {
            if let Some(active) = cleaned
                .iter_mut()
                .find(|entry| entry.id == self.active_instance_id)
            {
                active.favorite = true;
            }
        }

        if let Some(active) = cleaned
            .iter()
            .find(|entry| entry.id == self.active_instance_id)
        {
            self.profile.version = active.version.clone();
            self.profile.mod_profile = active.mod_profile.clone();
        }

        self.instances = cleaned;
    }
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value.and_then(|inner| {
        let trimmed = inner.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.chars().take(500).collect())
        }
    })
}

/// Only Vanilla, Fabric and Forge are supported loaders; unknown legacy
/// profiles (e.g. the old cosmetic presets) fall back to Vanilla.
fn normalize_loader(value: String) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "fabric" => "fabric".into(),
        "forge" => "forge".into(),
        _ => "vanilla".into(),
    }
}

fn clean_cosmetic(value: String) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "none".into()
    } else {
        trimmed.chars().take(64).collect()
    }
}

/// Accepts `#rgb` / `#rrggbb` and falls back for anything else.
fn normalize_color(value: String, fallback: &str) -> String {
    let trimmed = value.trim().to_ascii_lowercase();
    let valid = (trimmed.len() == 4 || trimmed.len() == 7)
        && trimmed.starts_with('#')
        && trimmed.chars().skip(1).all(|c| c.is_ascii_hexdigit());
    if valid {
        trimmed
    } else {
        fallback.to_string()
    }
}

fn clean_required(value: String, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(120).collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProfileSelection {
    pub version: String,
    pub mod_profile: String,
    /// Local cosmetic skin id (see `src/features/play/minecraft/skins.ts`).
    pub skin_id: String,
    /// Arm model: `classic` (4 px) or `slim` (3 px).
    pub skin_model: String,
    /// Local cape id.
    pub cape_id: String,
    /// Cosmetic ids; `none` disables the slot.
    pub accessory_id: String,
    pub head_id: String,
    pub bandana_id: String,
    pub wing_id: String,
    pub shield_id: String,
    /// Equipped catalog cosmetics as `TYPE:id` keys, one per Minecraft type.
    pub cosmetic_selection: Vec<String>,
    /// Custom skin PNG as data URL, loaded from a name, UUID or local file.
    /// Takes precedence over the Microsoft account skin in the preview.
    pub custom_skin_data_url: Option<String>,
    /// Skins loaded from a name, UUID or file, newest first.
    pub custom_skins: Vec<CustomSkin>,
}

/// One remembered skin in the launcher's history tiles.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomSkin {
    pub id: String,
    pub name: String,
    pub data_url: String,
    pub model: String,
    pub added_at: String,
}

impl Default for CustomSkin {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "Eigener Skin".into(),
            data_url: String::new(),
            model: "classic".into(),
            added_at: String::new(),
        }
    }
}

/// One saved setup: which Minecraft version to run with which mod profile.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub version: String,
    /// Loader: `vanilla`, `fabric` or `forge`.
    pub mod_profile: String,
    /// Favourites are offered in the Play screen's instance switcher.
    pub favorite: bool,
    /// Optional custom game directory. Empty = per-instance folder (or the
    /// global game directory for the migrated default instance).
    pub directory: Option<String>,
}

impl Default for Instance {
    fn default() -> Self {
        Self {
            id: "default".into(),
            name: "Vanilla 1.21.10".into(),
            version: "1.21.10".into(),
            mod_profile: "vanilla".into(),
            favorite: true,
            directory: None,
        }
    }
}

impl Default for ProfileSelection {
    fn default() -> Self {
        Self {
            version: "1.21.10".into(),
            mod_profile: "vanilla".into(),
            skin_id: "frost".into(),
            skin_model: "classic".into(),
            cape_id: "aurora".into(),
            accessory_id: "none".into(),
            head_id: "none".into(),
            bandana_id: "none".into(),
            wing_id: "none".into(),
            shield_id: "none".into(),
            cosmetic_selection: Vec::new(),
            custom_skin_data_url: None,
            custom_skins: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JavaSettings {
    pub path: Option<String>,
    pub min_ram_mb: u32,
    pub max_ram_mb: u32,
    pub extra_jvm_args: String,
}

impl Default for JavaSettings {
    fn default() -> Self {
        Self {
            path: None,
            min_ram_mb: 1024,
            max_ram_mb: 4096,
            extra_jvm_args: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GameSettings {
    pub directory: Option<String>,
    pub width: u32,
    pub height: u32,
    pub fullscreen: bool,
}

impl Default for GameSettings {
    fn default() -> Self {
        Self {
            directory: None,
            width: 1280,
            height: 720,
            fullscreen: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LaunchSettings {
    pub close_launcher: bool,
    pub keep_open_on_error: bool,
    pub show_console: bool,
    pub auto_update: bool,
}

impl Default for LaunchSettings {
    fn default() -> Self {
        Self {
            close_launcher: false,
            keep_open_on_error: true,
            show_console: false,
            auto_update: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DiscordSettings {
    pub enabled: bool,
    pub show_server: bool,
    /// Discord application id for Rich Presence; `None` disables the IPC.
    pub app_id: Option<String>,
}

impl Default for DiscordSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            show_server: true,
            app_id: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppearanceSettings {
    pub performance: PerformanceMode,
    pub reduce_motion: bool,
    pub show_particles: bool,
    pub accent: String,
    /// Global corner radius in px; 0 = square, 28 = very round.
    pub corner_radius: u32,
    /// Base colour behind the glass panels.
    pub background_color: String,
    pub background_mode: BackgroundMode,
    /// Locally stored background image as a data URL.
    pub background_image: Option<String>,
    /// Colour wash for every card/tile.
    pub tile_tint: String,
    /// Strength of the tile wash, 0-100.
    pub tile_opacity: u32,
    /// Text colour for titles, labels, hints and values.
    pub text_color: String,
    /// Font preset id (`standard`, `bahnschrift`, `georgia`, `mono`, `pixel`).
    pub font_family: String,
}

impl Default for AppearanceSettings {
    fn default() -> Self {
        Self {
            performance: PerformanceMode::Balanced,
            reduce_motion: false,
            show_particles: true,
            accent: "#6ee7f9".into(),
            corner_radius: 16,
            background_color: "#070d18".into(),
            background_mode: BackgroundMode::Stars,
            background_image: None,
            tile_tint: "#6ee7f9".into(),
            tile_opacity: 0,
            text_color: "#f3f8ff".into(),
            font_family: "standard".into(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BackgroundMode {
    Stars,
    Aurora,
    Solid,
    Image,
}

impl Default for BackgroundMode {
    fn default() -> Self {
        BackgroundMode::Stars
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PerformanceMode {
    High,
    Balanced,
    Low,
}

impl Default for PerformanceMode {
    fn default() -> Self {
        PerformanceMode::Balanced
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SystemSettings {
    pub start_minimized: bool,
    pub always_on_top: bool,
}

impl Default for SystemSettings {
    fn default() -> Self {
        Self {
            start_minimized: false,
            always_on_top: false,
        }
    }
}

/// Extension points for later backends. Empty values keep the launcher fully
/// local; fill them in to connect real services (see README).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct IntegrationSettings {
    /// Azure app (public client) id for Microsoft OAuth.
    pub ms_client_id: Option<String>,
    /// HTTPS URL returning the remote news feed (JSON).
    pub news_feed_url: Option<String>,
}

impl Default for IntegrationSettings {
    fn default() -> Self {
        Self {
            ms_client_id: None,
            news_feed_url: None,
        }
    }
}
