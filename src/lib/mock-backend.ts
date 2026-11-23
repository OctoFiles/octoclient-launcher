/**
 * Browser-only mock of the Rust backend, used by `npm run dev`.
 *
 * It mirrors the command names and payload shapes of `src-tauri`. Data lives in
 * localStorage. There is no pre-signed-in account — Microsoft login genuinely
 * requires the desktop app.
 */

import {
  BridgeError,
  type AuthSnapshot,
  type LauncherConfig,
  type PendingLogin,
  type PendingStatus,
  type SystemInfo,
} from "./bridge-types";
import { BUNDLED_GAME_VERSIONS } from "../data/versions";
import { createDefaultConfig } from "./defaults";

const CONFIG_KEY = "frost.mock.config";

function defaultConfig(): LauncherConfig {
  return createDefaultConfig();
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable — mock state stays in memory */
  }
}

const storedConfig = read<Partial<LauncherConfig>>(CONFIG_KEY, {});
const baseConfig = defaultConfig();
let config: LauncherConfig = {
  ...baseConfig,
  ...storedConfig,
  profile: { ...baseConfig.profile, ...(storedConfig.profile ?? {}) },
  java: { ...baseConfig.java, ...(storedConfig.java ?? {}) },
  game: { ...baseConfig.game, ...(storedConfig.game ?? {}) },
  launch: { ...baseConfig.launch, ...(storedConfig.launch ?? {}) },
  discord: { ...baseConfig.discord, ...(storedConfig.discord ?? {}) },
  appearance: { ...baseConfig.appearance, ...(storedConfig.appearance ?? {}) },
  system: { ...baseConfig.system, ...(storedConfig.system ?? {}) },
  integrations: { ...baseConfig.integrations, ...(storedConfig.integrations ?? {}) },
};

let pending: PendingLogin | null = null;
let pendingTimer: number | undefined;

function authSnapshot(): AuthSnapshot {
  return { account: null, pending, accounts: [] };
}

function setPending(status: PendingStatus, error: string | null) {
  if (!pending) return;
  pending = { ...pending, status, error };
}

function clearPendingTimer() {
  if (pendingTimer) window.clearTimeout(pendingTimer);
  pendingTimer = undefined;
}

function randomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
    if (index === 3) code += "-";
  }
  return code;
}

function mockFriendsSnapshot() {
  return {
    me: {
      uuid: "00000000-0000-0000-0000-000000000000",
      name: "Browser-Vorschau",
      status: "online",
      detail: null,
      lastSeen: null,
      unread: 0,
    },
    friends: [],
    incoming: [],
    outgoing: [],
    unread: {},
    server: "https://octoclient.pythonanywhere.com",
  };
}

export async function mockInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  switch (command) {
    case "get_config":
      return structuredClone(config) as T;

    case "save_config": {
      config = structuredClone(args?.config as LauncherConfig);
      write(CONFIG_KEY, config);
      return structuredClone(config) as T;
    }

    case "reset_config": {
      config = defaultConfig();
      write(CONFIG_KEY, config);
      return structuredClone(config) as T;
    }

    case "system_info": {
      const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
      const info: SystemInfo = {
        os: navigator.platform || "Browser",
        arch: "web",
        appVersion: "0.1.0 (Browser-Vorschau)",
        totalMemoryMb: memory ? memory * 1024 : 8192,
        configDir: "localStorage",
        dataDir: "localStorage",
        configFile: CONFIG_KEY,
        defaultGameDir: "%APPDATA%/.minecraft",
        gameDir: config.game.directory ?? "%APPDATA%/.minecraft",
        java: null,
        installedVersions: [],
      };
      return info as T;
    }

    case "detect_java":
      return null as T;

    case "open_external":
      window.open(String(args?.url), "_blank", "noopener,noreferrer");
      return undefined as T;

    case "auth_current":
      return authSnapshot() as T;

    case "auth_begin_login": {
      clearPendingTimer();
      pending = {
        userCode: randomCode(),
        verificationUri: "https://microsoft.com/link",
        message:
          "Öffne microsoft.com/link und gib den Code ein. In der Browser-Vorschau ist keine echte Anmeldung möglich.",
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        intervalSecs: 5,
        status: "pending",
        error: null,
      };
      // The mock cannot complete OAuth; report a clear state instead of faking one.
      pendingTimer = window.setTimeout(() => {
        setPending(
          "error",
          "Microsoft-Login benötigt die Desktop-App. Starte sie mit „npm run tauri dev“.",
        );
      }, 12_000);
      return pending as T;
    }

    case "auth_cancel_login": {
      clearPendingTimer();
      pending = null;
      return authSnapshot() as T;
    }

    case "auth_sign_out": {
      clearPendingTimer();
      pending = null;
      return authSnapshot() as T;
    }

    case "auth_switch":
    case "auth_remove":
    case "open_auth_popup":
    case "apply_minecraft_skin":
      throw new BridgeError(
        "auth",
        "Sitzungen lassen sich nur in der Desktop-App erneuern.",
      );

    case "list_minecraft_versions":
      return {
        latestRelease: BUNDLED_GAME_VERSIONS[0]?.id ?? "1.21.10",
        latestSnapshot: "",
        fetchedAt: Math.floor(Date.now() / 1000),
        source: "bundled",
        versions: BUNDLED_GAME_VERSIONS,
      } as T;

    case "instance_info": {
      const instance =
        config.instances.find((entry) => entry.id === String(args?.instanceId)) ??
        createDefaultConfig().instances[0];
      return {
        id: instance.id,
        name: instance.name,
        version: instance.version,
        loader: instance.modProfile,
        directory: `%APPDATA%\\.frost\\instances\\${instance.id}`,
        installedVersions: [],
        mods: 0,
        resourcepacks: 0,
        shaderpacks: 0,
        packs: 0,
      } as T;
    }

    case "list_instance_content":
      return {
        directory: "%APPDATA%\\.frost\\instances",
        entries: [],
        packs: [],
      } as T;

    case "search_modrinth":
    case "install_modrinth_content":
    case "install_modrinth_modpack":
    case "remove_instance_content":
    case "remove_instance_modpack":
      throw new BridgeError(
        "desktop_only",
        "Modrinth-Suche und Downloads benötigen die Desktop-App. In der Browser-Vorschau wird nichts heruntergeladen.",
      );

    case "resolve_minecraft_skin":
      throw new BridgeError(
        "desktop_only",
        "Skins von Mojang lassen sich nur in der Desktop-App laden. Eine PNG-Datei funktioniert auch in der Browser-Vorschau.",
      );

    case "import_pack_file":
    case "export_instance_pack":
      throw new BridgeError(
        "desktop_only",
        "Drag & Drop schreibt Dateien nur in der Desktop-App auf die Festplatte.",
      );

    case "open_instance_folder":
      throw new BridgeError(
        "desktop_only",
        "Ordner lassen sich nur in der Desktop-App öffnen.",
      );

    case "list_versions":
      return [] as T;

    case "build_launch_preview":
      return null as T;

    case "launch_game":
      throw new BridgeError(
        "desktop_only",
        "Das Spiel kann nur aus der Desktop-App gestartet werden.",
      );

    case "write_cosmetic_loadout":
      return null as T;

    case "read_cosmetic_loadout":
      // The browser preview has no Minecraft config directory.
      return null as T;

    case "fetch_news":
      return {
        source: "unavailable",
        items: [],
        message: "Remote-News sind nur in der Desktop-App verfügbar.",
      } as T;

    case "friends_overview":
      return mockFriendsSnapshot() as T;

    case "friends_request":
    case "friends_accept":
    case "friends_remove":
    case "friends_send":
    case "friends_messages":
      throw new BridgeError(
        "desktop_only",
        "Freunde und Chat verbinden sich nur aus der Desktop-App mit dem Server.",
      );

    default:
      throw new BridgeError("unknown_command", `Unbekannter Befehl: ${command}`);
  }
}
