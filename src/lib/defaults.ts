import type { LauncherConfig } from "./types";

/**
 * Fresh-install configuration. Mirrors `LauncherConfig::default()` in
 * `src-tauri/src/config.rs`; the backend stays authoritative and normalizes it.
 */
export function createDefaultConfig(): LauncherConfig {
  return {
    version: 3,
    profile: {
      version: "1.21.10",
      modProfile: "vanilla",
      skinId: "frost",
      skinModel: "classic",
      capeId: "none",
      accessoryId: "none",
      headId: "none",
      bandanaId: "none",
      wingId: "none",
      shieldId: "none",
      cosmeticSelection: [],
      customSkinDataUrl: null,
      customSkins: [],
    },
    instances: [
      {
        id: "default",
        name: "Vanilla 1.21.10",
        version: "1.21.10",
        modProfile: "vanilla",
        favorite: true,
        directory: null,
      },
    ],
    activeInstanceId: "default",
    java: { path: null, minRamMb: 1024, maxRamMb: 4096, extraJvmArgs: "" },
    game: { directory: null, width: 1280, height: 720, fullscreen: false },
    launch: {
      closeLauncher: false,
      keepOpenOnError: true,
      showConsole: false,
      autoUpdate: true,
    },
    discord: { enabled: true, showServer: true, appId: null },
    appearance: {
      performance: "balanced",
      reduceMotion: false,
      showParticles: true,
      accent: "#6ee7f9",
      cornerRadius: 16,
      backgroundColor: "#070d18",
      backgroundMode: "stars",
      backgroundImage: null,
      tileTint: "#6ee7f9",
      tileOpacity: 50,
      textColor: "#f3f8ff",
      fontFamily: "standard",
    },
    system: { startMinimized: false, alwaysOnTop: false },
    integrations: {
      msClientId: null,
      newsFeedUrl: null,
    },
  };
}
