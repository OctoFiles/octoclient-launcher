import {
  Boxes,
  Check,
  ChevronDown,
  FolderOpen,
  Image,
  LayoutGrid,
  Package,
  Play,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useState, type DragEvent } from "react";

import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Select } from "../../components/ui/Select";
import { MOD_LOADERS, findLoader } from "../../data/versions";
import { errorMessage, invoke, isDesktop } from "../../lib/bridge";
import {
  activateInstance,
  activeInstance,
  listInstances,
  updateInstance,
} from "../../lib/instances";
import type {
  ContentEntry,
  ContentSnapshot,
  InstanceImportOutcome,
  InstanceInfo,
  InstalledPack,
  ModrinthHit,
  ModrinthSearch,
  ModpackResult,
} from "../../lib/types";
import { useLauncher } from "../../state/LauncherProvider";

type TabId = "overview" | "mods" | "resourcepacks" | "shader" | "modpacks";

const TABS: Array<{ id: TabId; label: string; icon: typeof Package }> = [
  { id: "overview", label: "Übersicht", icon: LayoutGrid },
  { id: "mods", label: "Mods", icon: Package },
  { id: "resourcepacks", label: "Resource Packs", icon: Image },
  { id: "shader", label: "Shader", icon: Sparkles },
  { id: "modpacks", label: "Modpacks", icon: Boxes },
];

const KIND_BY_TAB: Record<
  Exclude<TabId, "overview">,
  "mod" | "resourcepack" | "shader" | "modpack"
> = {
  mods: "mod",
  resourcepacks: "resourcepack",
  shader: "shader",
  modpacks: "modpack",
};

const SEARCH_TITLE: Record<Exclude<TabId, "overview">, string> = {
  mods: "Mods auf Modrinth",
  resourcepacks: "Resource Packs auf Modrinth",
  shader: "Shader auf Modrinth",
  modpacks: "Modpacks auf Modrinth",
};

const DROP_HINT: Record<Exclude<TabId, "overview">, string> = {
  mods: "Mods (.jar) hierher ziehen",
  resourcepacks: "Resource Packs (.zip) hierher ziehen",
  shader: "Shader (.zip) hierher ziehen",
  modpacks: "Modpacks installierst du über Modrinth",
};

const downloads = new Intl.NumberFormat("de-DE", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatBytes(bytes: number): string {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function Thumb({ iconUrl }: { iconUrl: string | null }) {
  if (iconUrl) {
    return <img className="content-thumb" src={iconUrl} alt="" loading="lazy" />;
  }
  return (
    <span className="content-thumb content-thumb--fallback">
      <Package size={15} />
    </span>
  );
}

export function InstanceDetail({
  instanceId,
  onClose,
}: {
  instanceId: string;
  onClose: () => void;
}) {
  const {
    config,
    versions,
    launching,
    updateConfig,
    launch,
    pushToast,
  } = useLauncher();
  const instance = listInstances(config).find((entry) => entry.id === instanceId);
  const active = activeInstance(config);

  const [tab, setTab] = useState<TabId>("overview");
  const [info, setInfo] = useState<InstanceInfo | null>(null);
  const [snapshot, setSnapshot] = useState<ContentSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ModrinthSearch | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [searchNonce, setSearchNonce] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  // The installed list is long with a big modpack; it can be folded away.
  const [installedOpen, setInstalledOpen] = useState(true);

  const refreshInfo = useCallback(async () => {
    try {
      setInfo(await invoke<InstanceInfo>("instance_info", { instanceId }));
    } catch {
      /* counts are cosmetic; the content list below still works */
    }
  }, [instanceId]);

  const loadContent = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [information, content] = await Promise.all([
        invoke<InstanceInfo>("instance_info", { instanceId }),
        invoke<ContentSnapshot>("list_instance_content", { instanceId }),
      ]);
      setInfo(information);
      setSnapshot(content);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [instanceId]);

  useEffect(() => {
    void loadContent();
  }, [loadContent]);

  const kind = tab === "overview" ? null : KIND_BY_TAB[tab];
  const loader = findLoader(instance?.modProfile ?? "vanilla");
  const modsBlocked = kind === "mod" && loader.id === "vanilla";
  const searchEnabled = Boolean(kind) && isDesktop && !modsBlocked;

  // Reset the query when switching category tabs.
  useEffect(() => {
    setQuery("");
    setResults(null);
    setSearchError(null);
  }, [tab]);

  useEffect(() => {
    if (!kind || !instance || !searchEnabled) {
      setResults(null);
      setSearching(false);
      return;
    }
    let current = true;
    setSearching(true);
    setSearchError(null);
    const timer = window.setTimeout(async () => {
      try {
        const search = await invoke<ModrinthSearch>("search_modrinth", {
          query: query.trim(),
          kind,
          loader: kind === "mod" ? instance.modProfile : null,
          gameVersion: kind === "mod" || kind === "modpack" ? instance.version : null,
        });
        if (current) setResults(search);
      } catch (error) {
        if (current) {
          setSearchError(errorMessage(error));
          setResults(null);
        }
      } finally {
        if (current) setSearching(false);
      }
    }, query ? 320 : 0);

    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [kind, query, searchEnabled, searchNonce, instance?.modProfile, instance?.version]);

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      if (kind === "modpack") {
        pushToast("info", "Modpacks werden über die Modrinth-Suche installiert.");
        return;
      }
      setBusy("import");
      try {
        const outcome = await invoke<InstanceImportOutcome>("import_instance_files", {
          instanceId,
          paths,
          kind,
        });
        setSnapshot(outcome.snapshot);
        if (outcome.imported > 0) {
          pushToast(
            "success",
            `${outcome.imported} Datei${outcome.imported === 1 ? "" : "en"} hinzugefügt.`,
          );
        }
        if (outcome.skipped.length > 0) {
          pushToast(
            "info",
            `Nicht übernommen: ${outcome.skipped.slice(0, 3).join(", ")}${
              outcome.skipped.length > 3 ? "…" : ""
            }`,
          );
        }
        if (outcome.imported === 0 && outcome.skipped.length === 0) {
          pushToast("info", "Es wurden keine passenden Dateien gefunden.");
        }
        void refreshInfo();
      } catch (error) {
        pushToast("error", errorMessage(error));
      } finally {
        setBusy(null);
      }
    },
    [instanceId, kind, pushToast, refreshInfo],
  );

  // The native Tauri drag-drop event carries absolute paths, which are needed
  // to copy dropped files into the instance folder.
  useEffect(() => {
    if (!isDesktop) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const { getCurrentWebview } = await import("@tauri-apps/api/webview");
        const stop = await getCurrentWebview().onDragDropEvent((event) => {
          if (disposed) return;
          if (event.payload.type === "enter" || event.payload.type === "over") {
            setDragActive(true);
          } else if (event.payload.type === "leave") {
            setDragActive(false);
          } else if (event.payload.type === "drop") {
            setDragActive(false);
            void importPaths(event.payload.paths);
          }
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch {
        /* browser preview: HTML5 drag and drop below */
      }
    })();

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [importPaths]);

  if (!instance) return null;

  const installedEntries =
    snapshot?.entries.filter((entry) => entry.kind === kind) ?? [];

  const install = async (hit: ModrinthHit) => {
    if (!kind) return;
    setBusy(hit.projectId);
    try {
      if (kind === "modpack") {
        const outcome = await invoke<ModpackResult>("install_modrinth_modpack", {
          instanceId,
          projectId: hit.projectId,
        });
        setSnapshot(outcome.snapshot);
        updateConfig(() => outcome.config);
        setInfo(await invoke<InstanceInfo>("instance_info", { instanceId }));
        pushToast(
          "success",
          `„${outcome.pack.title}“ installiert · ${outcome.pack.gameVersion ?? instance.version} · ${
            outcome.pack.loader ? findLoader(outcome.pack.loader).name : loader.name
          }`,
        );
      } else {
        const content = await invoke<ContentSnapshot>("install_modrinth_content", {
          instanceId,
          projectId: hit.projectId,
          kind,
        });
        setSnapshot(content);
        pushToast("success", `„${hit.title}“ installiert.`);
        void refreshInfo();
      }
    } catch (error) {
      pushToast("error", errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const removeEntry = async (entry: ContentEntry) => {
    setBusy(`remove:${entry.path}`);
    try {
      const content = await invoke<ContentSnapshot>("remove_instance_content", {
        instanceId,
        kind: entry.kind,
        path: entry.path,
      });
      setSnapshot(content);
      pushToast("info", `„${entry.title}“ entfernt.`);
      void refreshInfo();
    } catch (error) {
      pushToast("error", errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const removePack = async (pack: InstalledPack) => {
    setBusy(`pack:${pack.projectId}`);
    try {
      const content = await invoke<ContentSnapshot>("remove_instance_modpack", {
        instanceId,
        projectId: pack.projectId,
      });
      setSnapshot(content);
      pushToast("info", `Modpack „${pack.title}“ entfernt.`);
      void refreshInfo();
    } catch (error) {
      pushToast("error", errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const openFolder = async () => {
    try {
      await invoke<string>("open_instance_folder", { instanceId });
    } catch (error) {
      pushToast("error", errorMessage(error));
    }
  };

  const changeLoader = (next: string) => {
    updateConfig((current) =>
      updateInstance(current, instanceId, { modProfile: next }),
    );
  };

  const changeVersion = (next: string) => {
    updateConfig((current) => updateInstance(current, instanceId, { version: next }));
  };

  const startInstance = () => {
    const next = activateInstance(config, instanceId);
    updateConfig(() => next);
    void launch({ instanceId, config: next });
  };

  const onHtmlDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragActive(false);
    if (!isDesktop) {
      pushToast(
        "info",
        "Drag & Drop benötigt die Desktop-App. In der Browser-Vorschau wird nichts kopiert.",
      );
    }
  };

  const kindCount = (entryId: TabId) => {
    if (!info) return null;
    switch (entryId) {
      case "mods":
        return info.mods;
      case "resourcepacks":
        return info.resourcepacks;
      case "shader":
        return info.shaderpacks;
      case "modpacks":
        return info.packs;
      default:
        return null;
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={instance.name}
      subtitle={`${instance.version} · ${loader.name}`}
      size="lg"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Schließen
        </Button>
      }
    >
      <div
        className="instance-detail"
        onDragOver={(event) => {
          event.preventDefault();
          if (!isDesktop) setDragActive(true);
        }}
        onDragLeave={() => {
          if (!isDesktop) setDragActive(false);
        }}
        onDrop={onHtmlDrop}
      >
        <nav className="detail-nav" aria-label="Instanz-Inhalte">
          <div className="detail-nav__items">
            {TABS.map((entry) => {
              const Icon = entry.icon;
              const count = kindCount(entry.id);
              return (
                <button
                  key={entry.id}
                  type="button"
                  className={["detail-nav__item", tab === entry.id ? "detail-nav__item--active" : ""]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => setTab(entry.id)}
                  aria-current={tab === entry.id ? "page" : undefined}
                >
                  <Icon size={16} strokeWidth={1.9} />
                  <span>{entry.label}</span>
                  {count ? <em className="detail-nav__count">{count}</em> : null}
                </button>
              );
            })}
          </div>

          <div className="detail-nav__foot">
            <Button
              variant="primary"
              icon={<Play size={14} fill="currentColor" />}
              loading={launching}
              onClick={startInstance}
              className="detail-start"
            >
              Starten
            </Button>
            <span className="detail-nav__meta">
              {instance.id === active.id ? (
                <span className="detail-nav__active">
                  <Check size={11} /> Aktive Instanz
                </span>
              ) : (
                "Start aktiviert diese Instanz"
              )}
            </span>
            <button type="button" className="detail-nav__link" onClick={() => void openFolder()}>
              <FolderOpen size={13} />
              Ordner öffnen
            </button>
          </div>
        </nav>

        <div className="detail-main">
          {tab === "overview" ? (
            <div className="instance-detail__overview">
              {loading ? (
                <div className="detail-loading">
                  <RefreshCw size={16} className="instance-spin" />
                  <span>Instanz wird geladen…</span>
                </div>
              ) : loadError ? (
                <div className="detail-error">
                  <p>{loadError}</p>
                  <Button size="sm" onClick={() => void loadContent()}>
                    Erneut versuchen
                  </Button>
                </div>
              ) : (
                <>
                  <div className="detail-grid">
                    <div className="detail-control">
                      <span>Minecraft-Version</span>
                      <Select
                        aria-label="Minecraft-Version"
                        value={instance.version}
                        options={versions.map((entry) => ({
                          value: entry.id,
                          label: entry.kind === "release" ? entry.id : `${entry.id} · Snapshot`,
                        }))}
                        onChange={(event) => changeVersion(event.target.value)}
                      />
                    </div>
                    <div className="detail-control">
                      <span>Loader</span>
                      <Select
                        aria-label="Loader"
                        value={instance.modProfile}
                        options={MOD_LOADERS.map((entry) => ({
                          value: entry.id,
                          label: entry.name,
                        }))}
                        onChange={(event) => changeLoader(event.target.value)}
                      />
                    </div>
                  </div>

                  <dl className="detail-facts">
                    <div>
                      <dt>Ordner</dt>
                      <dd>
                        <code>{info?.directory ?? "…"}</code>
                      </dd>
                    </div>
                    <div>
                      <dt>Installierte Versionen</dt>
                      <dd>
                        {info?.installedVersions.length
                          ? info.installedVersions.join(", ")
                          : "noch keine"}
                      </dd>
                    </div>
                    <div>
                      <dt>Inhalte</dt>
                      <dd>
                        {info
                          ? `${info.mods} Mods · ${info.resourcepacks} Packs · ${info.shaderpacks} Shader · ${info.packs} Modpacks`
                          : "…"}
                      </dd>
                    </div>
                  </dl>

                  <div className="detail-actions">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<FolderOpen size={14} />}
                      onClick={() => void openFolder()}
                    >
                      Ordner öffnen
                    </Button>
                    {instance.id !== active.id ? (
                      <Button
                        size="sm"
                        icon={<Check size={14} />}
                        onClick={() =>
                          updateConfig((current) => activateInstance(current, instanceId))
                        }
                      >
                        Als aktive Instanz
                      </Button>
                    ) : (
                      <span className="detail-active">
                        <Check size={13} /> Aktive Instanz
                      </span>
                    )}
                  </div>

                  <p className="detail-note">
                    Änderungen an Version und Loader gelten beim nächsten Start. Mods
                    brauchen Fabric oder Forge; Resource Packs und Shader funktionieren
                    auch mit Vanilla. Dateien kannst du direkt in die Mods-, Resource-
                    Pack- oder Shader-Ansicht ziehen.
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="instance-detail__content">
              <div className="detail-dropzone">
                <Upload size={13} />
                <span>{DROP_HINT[tab as Exclude<TabId, "overview">]}</span>
              </div>

              {modsBlocked ? (
                <div className="detail-note detail-note--warn">
                  <p>
                    Vanilla lädt keine Mods. Stelle die Instanz auf Fabric oder Forge, um
                    Mods von Modrinth zu installieren.
                  </p>
                  <div className="detail-note__actions">
                    <Button size="sm" onClick={() => changeLoader("fabric")}>
                      Auf Fabric stellen
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => changeLoader("forge")}>
                      Auf Forge stellen
                    </Button>
                  </div>
                </div>
              ) : null}

              {installedEntries.length > 0 ? (
                <section className="detail-section">
                  <h3 className="detail-section__title">
                    <button
                      type="button"
                      className="detail-section__toggle"
                      onClick={() => setInstalledOpen((open) => !open)}
                      aria-expanded={installedOpen}
                      title={installedOpen ? "Liste einklappen" : "Liste ausklappen"}
                    >
                      <ChevronDown
                        size={14}
                        className={`detail-section__chev${installedOpen ? "" : " detail-section__chev--closed"}`}
                      />
                      Installiert
                    </button>
                    <span className="detail-section__count">{installedEntries.length}</span>
                  </h3>
                  <ul className="content-grid" hidden={!installedOpen}>
                    {installedEntries.map((entry) => (
                      <li key={entry.path} className="content-card">
                        <div className="content-card__head">
                          <Thumb iconUrl={entry.iconUrl} />
                          <span className="content-card__title" title={entry.title}>
                            {entry.title}
                          </span>
                        </div>
                        <span className="content-card__meta">
                          {[entry.versionNumber, formatBytes(entry.size)]
                            .filter(Boolean)
                            .join(" · ") || "Lokale Datei"}
                        </span>
                        <span className="content-card__path" title={entry.path}>
                          {entry.path}
                        </span>
                        <div className="content-card__foot">
                          <button
                            type="button"
                            className="content-card__action"
                            onClick={() => void removeEntry(entry)}
                            disabled={busy === `remove:${entry.path}`}
                          >
                            <Trash2 size={13} />
                            Entfernen
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {tab === "modpacks" && snapshot?.packs.length ? (
                <section className="detail-section">
                  <h3 className="detail-section__title">Installierte Modpacks</h3>
                  <ul className="content-grid">
                    {snapshot.packs.map((pack) => (
                      <li key={pack.projectId} className="content-card">
                        <div className="content-card__head">
                          <Thumb iconUrl={pack.iconUrl} />
                          <span className="content-card__title" title={pack.title}>
                            {pack.title}
                          </span>
                        </div>
                        <span className="content-card__meta">
                          {[pack.versionNumber, pack.gameVersion, pack.loader
                            ? findLoader(pack.loader).name
                            : null]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                        <span className="content-card__path">{pack.files.length} Dateien</span>
                        <div className="content-card__foot">
                          <button
                            type="button"
                            className="content-card__action"
                            onClick={() => void removePack(pack)}
                            disabled={busy === `pack:${pack.projectId}`}
                          >
                            <Trash2 size={13} />
                            Entfernen
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              {!isDesktop ? (
                <div className="detail-note">
                  Die Modrinth-Suche und Downloads laufen über das Rust-Backend und sind
                  nur in der Desktop-App verfügbar.
                </div>
              ) : null}

              {searchEnabled ? (
                <div className="detail-search">
                  <Search size={14} />
                  <input
                    aria-label={`${SEARCH_TITLE[tab as Exclude<TabId, "overview">]} durchsuchen`}
                    placeholder={
                      tab === "modpacks"
                        ? "Modpacks durchsuchen…"
                        : tab === "mods"
                          ? "Mods durchsuchen…"
                          : tab === "resourcepacks"
                            ? "Resource Packs durchsuchen…"
                            : "Shader durchsuchen…"
                    }
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                  {searching ? <RefreshCw size={13} className="instance-spin" /> : null}
                </div>
              ) : null}

              {searchEnabled ? (
                <section className="detail-section">
                  <h3 className="detail-section__title">
                    {SEARCH_TITLE[tab as Exclude<TabId, "overview">]}
                    {results ? ` · ${results.total}` : ""}
                  </h3>
                  {searchError ? (
                    <div className="detail-error">
                      <p>{searchError}</p>
                      <Button size="sm" onClick={() => setSearchNonce((value) => value + 1)}>
                        Erneut versuchen
                      </Button>
                    </div>
                  ) : searching && !results ? (
                    <div className="detail-loading">
                      <RefreshCw size={15} className="instance-spin" />
                      <span>Modrinth wird durchsucht…</span>
                    </div>
                  ) : results && results.hits.length > 0 ? (
                    <ul className="content-grid">
                      {results.hits.map((hit) => (
                        <li key={hit.projectId} className="content-card content-card--hit">
                          <div className="content-card__head">
                            <Thumb iconUrl={hit.iconUrl} />
                            <span className="content-card__title" title={hit.title}>
                              {hit.title}
                            </span>
                          </div>
                          <span className="content-card__meta">
                            {downloads.format(hit.downloads)} Downloads
                          </span>
                          <span className="content-card__tags">
                            {hit.categories.slice(0, 2).join(", ") || hit.projectType}
                          </span>
                          <p className="content-card__description">{hit.description}</p>
                          <div className="content-card__foot">
                            <Button
                              size="sm"
                              variant="primary"
                              icon={<Plus size={13} />}
                              loading={busy === hit.projectId}
                              onClick={() => void install(hit)}
                              className="content-card__download"
                            >
                              Installieren
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="detail-empty">
                      {searching ? "Suche läuft…" : "Keine passenden Einträge gefunden."}
                    </p>
                  )}
                </section>
              ) : null}

              {tab === "modpacks" ? (
                <p className="detail-note">
                  Ein Modpack lädt seine Dateien herunter und setzt Minecraft-Version und
                  Loader der Instanz. Das kann einige Minuten dauern.
                </p>
              ) : null}
            </div>
          )}
        </div>

        {dragActive ? (
          <div className="detail-drop-overlay" aria-hidden="true">
            <Upload size={26} />
            <strong>Dateien hier ablegen</strong>
            <span>
              {tab === "mods"
                ? "Mods (.jar)"
                : tab === "resourcepacks"
                  ? "Resource Packs (.zip)"
                  : tab === "shader"
                    ? "Shader (.zip)"
                    : ".jar für Mods · .zip für Packs"}
            </span>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
