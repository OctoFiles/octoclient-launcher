import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { NEWS_ITEMS } from "../data/news";
import { BUNDLED_GAME_VERSIONS } from "../data/versions";
import {
  COSMETIC_IDS_BY_MODULE,
  COSMETIC_MODULE_NAMES,
  cosmeticItemById,
  normalizeCosmeticProfile,
  profilePatchForCosmetic,
  type CosmeticCategory,
} from "../features/play/minecraft/cosmetics";
import {
  errorCode,
  errorMessage,
  invoke,
  listenEvent,
  openExternal as openExternalUrl,
} from "../lib/bridge";
import { createDefaultConfig } from "../lib/defaults";
import { friendsApi } from "../lib/friends";
import { resolveFont } from "../lib/fonts";
import type {
  Account,
  AuthSnapshot,
  CustomSkin,
  GameVersion,
  InstallProgress,
  LauncherConfig,
  LaunchResult,
  NewsFeed,
  NewsItem,
  PendingLogin,
  SkinModel,
  SystemInfo,
  VersionCatalog,
} from "../lib/types";

export type SaveState = "idle" | "saving" | "saved" | "error";
export type ToastKind = "info" | "success" | "error";

export interface Toast {
  id: string;
  kind: ToastKind;
  message: string;
}

type SectionKey = Exclude<keyof LauncherConfig, "version">;

interface LauncherContextValue {
  ready: boolean;
  config: LauncherConfig;
  system: SystemInfo | null;
  account: Account | null;
  pending: PendingLogin | null;
  /** Every saved Microsoft account; switching needs no new login. */
  accounts: Account[];
  news: NewsItem[];
  newsSource: "bundled" | "remote";
  /** Minecraft versions from Mojang (live, cached or bundled fallback). */
  versions: GameVersion[];
  versionsSource: "bundled" | "live" | "cached";
  versionsLoading: boolean;
  /** `force` bypasses the Rust-side cache and asks Mojang again. */
  refreshVersions: (force?: boolean) => Promise<void>;
  /** Set while game files/Java are being downloaded before a launch. */
  installProgress: InstallProgress | null;
  saving: SaveState;
  launching: boolean;
  /** Covers install + the first seconds after the game process was spawned. */
  starting: boolean;
  toasts: Toast[];
  /** Messages waiting in friend chats (badge on the friends tab). */
  unreadMessages: number;
  updateConfig: (updater: (current: LauncherConfig) => LauncherConfig) => void;
  updateSection: <K extends SectionKey>(
    section: K,
    patch: Partial<LauncherConfig[K]>,
  ) => void;
  resetConfig: () => Promise<void>;
  refreshSystem: () => Promise<void>;
  signIn: () => Promise<void>;
  cancelSignIn: () => Promise<void>;
  signOut: () => Promise<void>;
  switchAccount: (uuid: string) => Promise<void>;
  removeAccount: (uuid: string) => Promise<void>;
  /** Opens the Microsoft device-code page in its own launcher window. */
  openAuthPopup: (url: string) => Promise<void>;
  /** Stores a loaded skin in the history tiles and makes it active. */
  rememberSkin: (name: string, dataUrl: string, model: SkinModel) => void;
  removeSkin: (id: string) => void;
  refreshNews: () => Promise<void>;
  /** Launches an instance; with `instanceId` it starts that saved instance. */
  launch: (options?: { instanceId?: string; config?: LauncherConfig }) => Promise<void>;
  /** Equips a catalog cosmetic in both the launcher and the game config. */
  equipCosmetic: (category: CosmeticCategory, id: string) => Promise<void>;
  /** Imports the cosmetics currently enabled in Minecraft's config. */
  syncCosmeticsFromGame: (announce?: boolean) => Promise<void>;
  cosmeticSyncing: boolean;
  openExternal: (url: string) => Promise<void>;
  pushToast: (kind: ToastKind, message: string) => void;
  dismissToast: (id: string) => void;
}

const LauncherContext = createContext<LauncherContextValue | null>(null);

/** Every module name the game can use for a cosmetic, for the config sync. */
const KNOWN_COSMETIC_MODULES = Array.from(new Set(COSMETIC_MODULE_NAMES.values()));

/** Launcher ids → the module names stored in the game's own config. */
function moduleNamesFor(selection: string[]): string[] {
  return selection
    .map((id) => COSMETIC_MODULE_NAMES.get(id))
    .filter((name): name is string => Boolean(name));
}

/** Picks black or white text for a hex accent colour. */
function readableTextOn(color: string): string {
  const hex = color.replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((part) => part + part)
          .join("")
      : hex;
  if (full.length !== 6) return "#06121a";
  const [r, g, b] = [0, 2, 4].map((index) => parseInt(full.slice(index, index + 2), 16) / 255);
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.2 ? "#06121a" : "#ffffff";
}

function mergeNews(remote: NewsItem[]): NewsItem[] {
  const seen = new Set(remote.map((item) => item.id));
  return [...remote, ...NEWS_ITEMS.filter((item) => !seen.has(item.id))];
}

export function LauncherProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<LauncherConfig>(createDefaultConfig);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [pending, setPending] = useState<PendingLogin | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [news, setNews] = useState<NewsItem[]>(NEWS_ITEMS);
  const [newsSource, setNewsSource] = useState<"bundled" | "remote">("bundled");
  const [versions, setVersions] = useState<GameVersion[]>(BUNDLED_GAME_VERSIONS);
  const [versionsSource, setVersionsSource] = useState<"bundled" | "live" | "cached">(
    "bundled",
  );
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null);
  const [saving, setSaving] = useState<SaveState>("idle");
  const [ready, setReady] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cosmeticSyncing, setCosmeticSyncing] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [unreadMessages, setUnreadMessages] = useState(0);

  const dirtyRef = useRef(false);
  const lastAccountRef = useRef<string | null>(null);
  /** Last unread counter per friend, so only new messages raise a toast. */
  const unreadRef = useRef<Record<string, number>>({});
  const groupUnreadRef = useRef<Record<number, number>>({});

  const pushToast = useCallback((kind: ToastKind, message: string) => {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((current) => [...current.slice(-3), { id, kind, message }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 5200);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const updateConfig = useCallback(
    (updater: (current: LauncherConfig) => LauncherConfig) => {
      dirtyRef.current = true;
      setConfig((current) => updater(current));
    },
    [],
  );

  function updateSection<K extends SectionKey>(
    section: K,
    patch: Partial<LauncherConfig[K]>,
  ) {
    updateConfig(
      (current) =>
        ({
          ...current,
          [section]: { ...(current[section] as object), ...patch },
        }) as LauncherConfig,
    );
  }

  const refreshVersions = useCallback(
    async (force = false) => {
      setVersionsLoading(true);
      try {
        const catalog = await invoke<VersionCatalog>(
          "list_minecraft_versions",
          force ? { force: true } : undefined,
        );
        if (catalog.versions.length > 0) {
          setVersions(catalog.versions);
          setVersionsSource(
            catalog.source === "live"
              ? "live"
              : catalog.source === "cache"
                ? "cached"
                : "bundled",
          );
        }
      } catch (error) {
        if (force) pushToast("error", errorMessage(error));
      } finally {
        setVersionsLoading(false);
      }
    },
    [pushToast],
  );

  // Keep the version list current: on start, then every 30 minutes. Rust asks
  // Mojang again at most once an hour, so this stays cheap.
  useEffect(() => {
    void refreshVersions();
    const timer = window.setInterval(() => {
      void refreshVersions();
    }, 30 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [refreshVersions]);

  // --- Initial load --------------------------------------------------------
  useEffect(() => {
    let active = true;

    (async () => {
      try {
        const [loadedConfig, info, auth] = await Promise.all([
          invoke<LauncherConfig>("get_config"),
          invoke<SystemInfo>("system_info"),
          invoke<AuthSnapshot>("auth_current"),
        ]);
        if (!active) return;

        setConfig({
          ...loadedConfig,
          profile: normalizeCosmeticProfile(loadedConfig.profile),
        });
        setSystem(info);
        setAccount(auth.account);
        setPending(auth.pending);
        setAccounts(auth.accounts ?? (auth.account ? [auth.account] : []));
        lastAccountRef.current = auth.account?.username ?? null;

        if (loadedConfig.integrations.newsFeedUrl) {
          void invoke<NewsFeed>("fetch_news")
            .then((feed) => {
              if (!active || feed.items.length === 0) return;
              setNews(mergeNews(feed.items));
              setNewsSource("remote");
            })
            .catch(() => {
              /* remote feed is optional */
            });
        }

        // Silently renew an expired Minecraft session on startup.
        if (auth.account && auth.account.expiresAt * 1000 < Date.now()) {
          void invoke<AuthSnapshot>("auth_refresh")
            .then((snapshot) => {
              if (active) {
                setAccount(snapshot.account);
                setAccounts(snapshot.accounts ?? []);
              }
            })
            .catch(() => {
              /* user can re-authenticate from the account menu */
            });
        }
      } catch (error) {
        pushToast("error", errorMessage(error));
      } finally {
        if (active) setReady(true);
      }
    })();

    return () => {
      active = false;
    };
  }, [pushToast]);

  // --- Debounced config autosave -----------------------------------------
  useEffect(() => {
    if (!ready || !dirtyRef.current) return;
    setSaving("saving");
    const timer = window.setTimeout(async () => {
      try {
        await invoke<LauncherConfig>("save_config", { config });
        setSaving("saved");
        window.setTimeout(() => {
          setSaving((current) => (current === "saved" ? "idle" : current));
        }, 1600);
      } catch (error) {
        setSaving("error");
        pushToast("error", errorMessage(error));
      }
    }, 650);

    return () => window.clearTimeout(timer);
  }, [config, ready, pushToast]);

  // Theme variables follow the appearance settings. Keeping them on :root
  // lets every feature CSS file use the same glass and radius tokens.
  useEffect(() => {
    const root = document.documentElement;
    const {
      accent,
      cornerRadius,
      backgroundColor,
      backgroundImage,
      tileTint,
      tileOpacity,
      textColor,
      fontFamily,
    } = config.appearance;
    const radius = Math.min(28, Math.max(0, Math.round(cornerRadius)));

    root.style.setProperty("--accent", accent);
    root.style.setProperty("--accent-contrast", readableTextOn(accent));
    root.style.setProperty("--radius", `${radius}px`);
    root.style.setProperty("--radius-sm", `${Math.round(radius * 0.55)}px`);
    root.style.setProperty("--radius-xs", `${Math.round(radius * 0.38)}px`);
    root.style.setProperty("--radius-lg", `${radius + 8}px`);
    root.style.setProperty("--bg-base", backgroundColor);
    root.style.setProperty("--tile-tint", tileTint);
    root.style.setProperty(
      "--tile-strength",
      String(Math.min(100, Math.max(0, tileOpacity)) / 100),
    );

    // Text colour: the muted tones are derived so the hierarchy survives any
    // pick. A missing value (config written before this setting existed) falls
    // back to the default ink instead of an empty custom property.
    const ink = textColor || "#f3f8ff";
    root.style.setProperty("--text", ink);
    root.style.setProperty("--muted", `color-mix(in srgb, ${ink} 78%, ${backgroundColor})`);
    root.style.setProperty("--muted-dim", `color-mix(in srgb, ${ink} 56%, ${backgroundColor})`);

    const font = resolveFont(fontFamily);
    root.style.setProperty("--font-ui", font.stack);
    root.style.setProperty("--font-display", font.display ?? font.stack);

    if (backgroundImage) {
      root.style.setProperty("--custom-bg-image", `url("${backgroundImage}")`);
    } else {
      root.style.removeProperty("--custom-bg-image");
    }
  }, [
    config.appearance.accent,
    config.appearance.cornerRadius,
    config.appearance.backgroundColor,
    config.appearance.backgroundImage,
    config.appearance.tileTint,
    config.appearance.tileOpacity,
    config.appearance.textColor,
    config.appearance.fontFamily,
  ]);

  // --- Unread messages ---------------------------------------------------
  // One quiet overview call every 20 s: it keeps the badges current and doubles
  // as the presence heartbeat, so friends see "online" without opening the tab.
  useEffect(() => {
    if (!account) {
      unreadRef.current = {};
      groupUnreadRef.current = {};
      setUnreadMessages(0);
      return;
    }
    let cancelled = false;

    const tick = async () => {
      try {
        const snapshot = await friendsApi.overview();
        if (cancelled) return;
        const counts = snapshot.unread ?? {};
        const previous = unreadRef.current;
        for (const friend of snapshot.friends) {
          const before = previous[friend.uuid] ?? 0;
          const current = counts[friend.uuid] ?? 0;
          if (current > before) {
            pushToast("info", `Neue Nachricht von ${friend.name}.`);
          }
        }
        // Group chats count towards the same sidebar badge.
        const groupCounts: Record<number, number> = {};
        for (const group of snapshot.groups ?? []) {
          const current = group.unread ?? 0;
          groupCounts[group.id] = current;
          if (current > (groupUnreadRef.current[group.id] ?? 0)) {
            pushToast("info", `Neue Nachricht in ${group.name}.`);
          }
        }
        groupUnreadRef.current = groupCounts;
        unreadRef.current = counts;
        setUnreadMessages(
          Object.values(counts).reduce((sum, value) => sum + value, 0) +
            Object.values(groupCounts).reduce((sum, value) => sum + value, 0),
        );
      } catch {
        /* offline or not registered yet — the tab shows the reason */
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [account, pushToast]);

  // Install progress from the automatic game downloader.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let active = true;

    listenEvent<InstallProgress>("install://progress", (progress) => {
      setInstallProgress(progress.stage === "done" ? null : progress);
    })
      .then((dispose) => {
        if (active) cleanup = dispose;
      })
      .catch(() => {
        /* events are only available in the desktop app */
      });

    return () => {
      active = false;
      cleanup?.();
    };
  }, []);

  // --- Auth events from Rust ---------------------------------------------
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let active = true;

    listenEvent<AuthSnapshot>("auth://changed", (snapshot) => {
      setAccount(snapshot.account);
      setPending(snapshot.pending);
      setAccounts(snapshot.accounts ?? (snapshot.account ? [snapshot.account] : []));
      const username = snapshot.account?.username ?? null;
      if (username && username !== lastAccountRef.current) {
        pushToast("success", `Angemeldet als ${username}.`);
      }
      lastAccountRef.current = username;
    })
      .then((dispose) => {
        if (active) cleanup = dispose;
      })
      .catch(() => {
        /* events are only available in the desktop app */
      });

    return () => {
      active = false;
      cleanup?.();
    };
  }, [pushToast]);

  const refreshSystem = useCallback(async () => {
    try {
      setSystem(await invoke<SystemInfo>("system_info"));
    } catch (error) {
      pushToast("error", errorMessage(error));
    }
  }, [pushToast]);

  const resetConfig = useCallback(async () => {
    try {
      const fresh = await invoke<LauncherConfig>("reset_config");
      dirtyRef.current = false;
      setConfig(fresh);
      setSaving("idle");
      setSystem(await invoke<SystemInfo>("system_info"));
      pushToast("info", "Einstellungen zurückgesetzt.");
    } catch (error) {
      pushToast("error", errorMessage(error));
    }
  }, [pushToast]);

  const signIn = useCallback(async () => {
    try {
      setPending(await invoke<PendingLogin>("auth_begin_login"));
    } catch (error) {
      pushToast("error", errorMessage(error));
    }
  }, [pushToast]);

  const cancelSignIn = useCallback(async () => {
    try {
      const snapshot = await invoke<AuthSnapshot>("auth_cancel_login");
      setPending(snapshot.pending);
    } catch (error) {
      pushToast("error", errorMessage(error));
    }
  }, [pushToast]);

  const signOut = useCallback(async () => {
    try {
      const snapshot = await invoke<AuthSnapshot>("auth_sign_out");
      setAccount(snapshot.account);
      setPending(snapshot.pending);
      setAccounts(snapshot.accounts ?? []);
      lastAccountRef.current = null;
      pushToast("info", "Microsoft-Konto abgemeldet.");
    } catch (error) {
      pushToast("error", errorMessage(error));
    }
  }, [pushToast]);

  const switchAccount = useCallback(
    async (uuid: string) => {
      try {
        const snapshot = await invoke<AuthSnapshot>("auth_switch", { uuid });
        setAccount(snapshot.account);
        setPending(snapshot.pending);
        setAccounts(snapshot.accounts);
        lastAccountRef.current = snapshot.account?.username ?? null;
        pushToast("success", `Konto gewechselt: ${snapshot.account?.username ?? "unbekannt"}.`);
      } catch (error) {
        pushToast("error", errorMessage(error));
      }
    },
    [pushToast],
  );

  const removeAccount = useCallback(
    async (uuid: string) => {
      try {
        const snapshot = await invoke<AuthSnapshot>("auth_remove", { uuid });
        setAccount(snapshot.account);
        setAccounts(snapshot.accounts);
        lastAccountRef.current = snapshot.account?.username ?? null;
        pushToast("info", "Konto entfernt.");
      } catch (error) {
        pushToast("error", errorMessage(error));
      }
    },
    [pushToast],
  );

  const openAuthPopup = useCallback(
    async (url: string) => {
      try {
        await invoke("open_auth_popup", { url });
      } catch (error) {
        pushToast("error", errorMessage(error));
      }
    },
    [pushToast],
  );

  const rememberSkin = useCallback(
    (name: string, dataUrl: string, model: SkinModel) => {
      const entry: CustomSkin = {
        id: `skin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name,
        dataUrl,
        model,
        addedAt: new Date().toISOString(),
      };
      updateConfig((current) => {
        const history = current.profile.customSkins.filter((skin) => skin.dataUrl !== dataUrl);
        return {
          ...current,
          profile: {
            ...current.profile,
            customSkinDataUrl: dataUrl,
            skinModel: model,
            customSkins: [entry, ...history].slice(0, 24),
          },
        };
      });
    },
    [updateConfig],
  );

  const removeSkin = useCallback(
    (id: string) => {
      updateConfig((current) => {
        const removed = current.profile.customSkins.find((skin) => skin.id === id);
        return {
          ...current,
          profile: {
            ...current.profile,
            customSkins: current.profile.customSkins.filter((skin) => skin.id !== id),
            customSkinDataUrl:
              removed && current.profile.customSkinDataUrl === removed.dataUrl
                ? null
                : current.profile.customSkinDataUrl,
          },
        };
      });
    },
    [updateConfig],
  );

  const refreshNews = useCallback(async () => {
    try {
      const feed = await invoke<NewsFeed>("fetch_news");
      if (feed.items.length > 0) {
        setNews(mergeNews(feed.items));
        setNewsSource("remote");
        pushToast("success", `${feed.items.length} Meldungen geladen.`);
      } else {
        pushToast("info", feed.message ?? "Kein Remote-Feed konfiguriert.");
      }
    } catch (error) {
      pushToast("error", errorMessage(error));
    }
  }, [pushToast]);

  const launch = useCallback(
    async (options?: { instanceId?: string; config?: LauncherConfig }) => {
      if (launching || starting) return;
      setLaunching(true);
      setStarting(true);
      try {
        // A direct instance start may follow an unsaved version/loader change;
        // persist it first so the Rust side resolves the same setup.
        if (options?.instanceId && options.config) {
          await invoke<LauncherConfig>("save_config", { config: options.config });
        }
        const result = await invoke<LaunchResult>(
          "launch_game",
          options?.instanceId ? { instanceId: options.instanceId } : undefined,
        );
        pushToast("success", `${result.version} gestartet.`);
        void refreshSystem();
        // Keep the button in its loading state until the game window is up.
        window.setTimeout(() => setStarting(false), 7000);
      } catch (error) {
        setStarting(false);
        const code = errorCode(error);
        pushToast(
          code === "version_missing" || code === "java_missing" ? "info" : "error",
          errorMessage(error),
        );
      } finally {
        setLaunching(false);
        setInstallProgress(null);
      }
    },
    [launching, starting, pushToast, refreshSystem],
  );

  const equipCosmetic = useCallback(
    async (category: CosmeticCategory, id: string) => {
      const updated = normalizeCosmeticProfile({
        ...config.profile,
        ...profilePatchForCosmetic(config.profile, category, id),
      });
      updateConfig((current) => ({ ...current, profile: updated }));
      try {
        // Written straight away: the loadout file plus the game's module flags,
        // so the cosmetic is worn on the next start without any extra click.
        await invoke("write_cosmetic_loadout", {
          selection: updated.cosmeticSelection,
          moduleNames: moduleNamesFor(updated.cosmeticSelection),
          knownModuleNames: KNOWN_COSMETIC_MODULES,
        });
        const label = cosmeticItemById(id)?.name ?? id;
        pushToast(
          "success",
          id === "none"
            ? `${category} geleert.`
            : `Cosmetic „${label}“ wird jetzt im Spiel getragen.`,
        );
      } catch (error) {
        pushToast("error", errorMessage(error));
      }
    },
    [config.profile, updateConfig, pushToast],
  );

  const syncCosmeticsFromGame = useCallback(
    async (announce = false) => {
      setCosmeticSyncing(true);
      try {
        // `null` means the game has never written a config; keep the launcher's
        // selection in that case instead of silently clearing it.
        const enabled = await invoke<string[] | null>("read_cosmetic_loadout", {
          moduleNames: Array.from(COSMETIC_MODULE_NAMES.values()),
        });
        if (enabled === null) {
          if (announce) pushToast("info", "Noch kein Cosmetic-Loadout im Spiel vorhanden.");
          return;
        }
        const selection = enabled
          .map((name) => COSMETIC_IDS_BY_MODULE.get(name))
          .filter((id): id is string => Boolean(id));
        updateConfig((current) => ({
          ...current,
          profile: normalizeCosmeticProfile({ ...current.profile, cosmeticSelection: selection }),
        }));
        // Keep the shared file in step with the game, otherwise the next start
        // would re-apply the older launcher loadout and undo in-game changes.
        await invoke("write_cosmetic_loadout", {
          selection,
          moduleNames: moduleNamesFor(selection),
          knownModuleNames: KNOWN_COSMETIC_MODULES,
        });
        if (announce) {
          pushToast("success", `${selection.length} Cosmetics aus Minecraft übernommen.`);
        }
      } catch (error) {
        if (announce) pushToast("error", errorMessage(error));
      } finally {
        setCosmeticSyncing(false);
      }
    },
    [updateConfig, pushToast],
  );

  // Import the loadout left by the game once on startup. No toast: this is a
  // background sync and must not interrupt whatever the user is doing.
  useEffect(() => {
    if (ready) void syncCosmeticsFromGame(false);
  }, [ready, syncCosmeticsFromGame]);

  const openExternal = useCallback(
    async (url: string) => {
      try {
        await openExternalUrl(url);
      } catch (error) {
        pushToast("error", errorMessage(error));
      }
    },
    [pushToast],
  );

  const value = useMemo<LauncherContextValue>(
    () => ({
      ready,
      config,
      system,
      account,
      pending,
      accounts,
      news,
      newsSource,
      versions,
      versionsSource,
      versionsLoading,
      refreshVersions,
      installProgress,
      saving,
      launching,
      starting,
      toasts,
      unreadMessages,
      updateConfig,
      updateSection,
      resetConfig,
      refreshSystem,
      signIn,
      cancelSignIn,
      signOut,
      switchAccount,
      removeAccount,
      openAuthPopup,
      rememberSkin,
      removeSkin,
      refreshNews,
      launch,
      equipCosmetic,
      syncCosmeticsFromGame,
      cosmeticSyncing,
      openExternal,
      pushToast,
      dismissToast,
    }),
    [
      ready,
      config,
      system,
      account,
      pending,
      accounts,
      news,
      newsSource,
      versions,
      versionsSource,
      versionsLoading,
      refreshVersions,
      installProgress,
      saving,
      launching,
      starting,
      toasts,
      unreadMessages,
      updateConfig,
      resetConfig,
      refreshSystem,
      signIn,
      cancelSignIn,
      signOut,
      switchAccount,
      removeAccount,
      openAuthPopup,
      rememberSkin,
      removeSkin,
      refreshNews,
      launch,
      equipCosmetic,
      syncCosmeticsFromGame,
      cosmeticSyncing,
      openExternal,
      pushToast,
      dismissToast,
    ],
  );

  return <LauncherContext.Provider value={value}>{children}</LauncherContext.Provider>;
}

export function useLauncher(): LauncherContextValue {
  const context = useContext(LauncherContext);
  if (!context) {
    throw new Error("useLauncher muss innerhalb von <LauncherProvider> verwendet werden.");
  }
  return context;
}
