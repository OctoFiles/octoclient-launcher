import { Check, Download, Layers, Pencil, Play, Plus, RefreshCw, Star, Trash2, Upload } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";

import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Select } from "../../components/ui/Select";
import { MOD_LOADERS, findLoader } from "../../data/versions";
import { errorMessage, invoke, isDesktop } from "../../lib/bridge";
import {
  activateInstance,
  activeInstance,
  createInstance,
  favoriteInstances,
  listInstances,
  nextInstanceName,
  removeInstance,
  toggleInstanceFavorite,
  updateInstance,
  type InstanceDraft,
} from "../../lib/instances";
import type { Instance } from "../../lib/types";
import { useLauncher } from "../../state/LauncherProvider";
import { InstanceDetail } from "./InstanceDetail";
import "./instances.css";

type Editor =
  | { mode: "create" }
  | { mode: "edit"; instance: Instance };

export function InstancesView() {
  const {
    config,
    system,
    versions,
    versionsSource,
    versionsLoading,
    refreshVersions,
    updateConfig,
    launch,
    launching,
    pushToast,
  } = useLauncher();
  const [editor, setEditor] = useState<Editor | null>(null);
  const [draft, setDraft] = useState<InstanceDraft>({
    name: "",
    version: versions[0]?.id ?? "1.21.10",
    modProfile: "vanilla",
  });
  const [pendingDelete, setPendingDelete] = useState<Instance | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [packBusy, setPackBusy] = useState(false);
  const packRef = useRef<HTMLInputElement>(null);

  const instances = listInstances(config);
  const active = activeInstance(config);
  const favorites = favoriteInstances(config);
  const installed = new Set((system?.installedVersions ?? []).map((entry) => entry.id));

  const versionOptions = (current: string) => {
    const options = versions.map((entry) => ({
      value: entry.id,
      label: entry.kind === "release" ? entry.id : `${entry.id} · Snapshot`,
    }));
    if (!options.some((option) => option.value === current)) {
      options.unshift({ value: current, label: `${current} · eigene` });
    }
    return options;
  };

  const startInstance = (instance: Instance) => {
    const next = activateInstance(config, instance.id);
    updateConfig(() => next);
    void launch({ instanceId: instance.id, config: next });
  };

  const openCreate = () => {
    setDraft({
      name: nextInstanceName(config),
      version: versions[0]?.id ?? active.version,
      modProfile: active.modProfile,
    });
    setEditor({ mode: "create" });
    void refreshVersions();
  };

  const openEdit = (instance: Instance) => {
    setDraft({
      name: instance.name,
      version: instance.version,
      modProfile: instance.modProfile,
    });
    setEditor({ mode: "edit", instance });
  };

  const save = () => {
    if (!editor) return;
    const clean: InstanceDraft = {
      name: draft.name.trim() || "Instanz",
      version: draft.version,
      modProfile: draft.modProfile,
    };
    updateConfig((current) =>
      editor.mode === "create"
        ? createInstance(current, clean)
        : updateInstance(current, editor.instance.id, clean),
    );
    setEditor(null);
  };

  const importPack = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!isDesktop) {
      pushToast("info", "Pakete lassen sich nur in der Desktop-App importieren.");
      return;
    }
    setPackBusy(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Die Datei konnte nicht gelesen werden."));
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
      });
      const outcome = await invoke<{ imported: number; skipped: string[] }>(
        "import_pack_file",
        { name: file.name, data },
      );
      pushToast(
        "success",
        `${file.name}: ${outcome.imported} Dateien importiert${outcome.skipped.length ? `, ${outcome.skipped.length} übersprungen` : ""}.`,
      );
    } catch (error) {
      pushToast("error", errorMessage(error));
    } finally {
      setPackBusy(false);
    }
  };

  const exportPack = async () => {
    if (!isDesktop) {
      pushToast("info", "Pakete lassen sich nur in der Desktop-App exportieren.");
      return;
    }
    setPackBusy(true);
    try {
      const result = await invoke<{ path: string; entries: number }>(
        "export_instance_pack",
        { instanceId: active.id },
      );
      pushToast("success", `${result.entries} Dateien gespeichert: ${result.path}`);
    } catch (error) {
      pushToast("error", errorMessage(error));
    } finally {
      setPackBusy(false);
    }
  };

  return (
    <div className="view instances-view">
      <header className="view-head">
        <div>
          <span className="eyebrow">Spielprofile</span>
          <h1 className="view-title">Instanzen</h1>
          <p className="view-sub">
            Minecraft-Version und Loader als eigenes Setup. Klicke eine Instanz an, um
            Mods, Resource Packs, Shader und Modpacks über Modrinth zu verwalten.
          </p>
        </div>
        <div className="instance-head-actions">
          <input
            ref={packRef}
            type="file"
            accept=".mrpack,.noriskpack,.octopack,.zip"
            hidden
            onChange={(event) => void importPack(event)}
          />
          <Button
            variant="secondary"
            icon={<Upload size={14} />}
            loading={packBusy}
            onClick={() => packRef.current?.click()}
          >
            Pack importieren
          </Button>
          <Button
            variant="secondary"
            icon={<Download size={14} />}
            loading={packBusy}
            onClick={() => void exportPack()}
          >
            Export
          </Button>
          <Button variant="primary" icon={<Plus size={15} />} onClick={openCreate}>
            Neue Instanz
          </Button>
        </div>
      </header>

      <div className="instance-grid">
        {instances.map((instance) => {
          const isActive = instance.id === active.id;
          const loader = findLoader(instance.modProfile);
          const isInstalled = installed.has(instance.version);

          return (
            <article
              key={instance.id}
              className={["instance-card", isActive ? "instance-card--active" : ""]
                .filter(Boolean)
                .join(" ")}
              role="button"
              tabIndex={0}
              onClick={() => setDetailId(instance.id)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setDetailId(instance.id);
                }
              }}
              title="Öffnen: Mods, Resource Packs, Shader, Modpacks"
            >
              <header className="instance-card__head">
                <span className="instance-card__version">
                  <Layers size={12} /> {instance.version}
                </span>
                <button
                  type="button"
                  className={["instance-star", instance.favorite ? "instance-star--on" : ""]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={(event) => {
                    event.stopPropagation();
                    updateConfig((current) => toggleInstanceFavorite(current, instance.id));
                  }}
                  aria-pressed={instance.favorite}
                  disabled={isActive}
                  title={
                    isActive
                      ? "Die aktive Instanz bleibt Favorit"
                      : instance.favorite
                        ? "Aus Favoriten entfernen"
                        : "Zu Favoriten hinzufügen"
                  }
                >
                  <Star size={15} fill={instance.favorite ? "currentColor" : "none"} />
                </button>
              </header>

              <h2 className="instance-card__name">{instance.name}</h2>
              <p className="instance-card__meta">
                {loader.name} · {loader.description}
              </p>

              <div className="instance-card__tags">
                <span
                  className={["instance-tag", isInstalled ? "instance-tag--ok" : ""]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {isInstalled ? "installiert" : "nicht installiert"}
                </span>
                {instance.favorite ? (
                  <span className="instance-tag instance-tag--fav">Favorit</span>
                ) : null}
              </div>

              <footer
                className="instance-card__foot"
                onClick={(event) => event.stopPropagation()}
              >
                {isActive ? (
                  <span className="instance-active">
                    <Check size={13} /> Aktiv
                  </span>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      updateConfig((current) => activateInstance(current, instance.id))
                    }
                  >
                    Aktivieren
                  </Button>
                )}
                <div className="instance-card__actions">
                  <button
                    type="button"
                    className="icon-btn instance-play"
                    onClick={() => startInstance(instance)}
                    disabled={launching}
                    aria-label={`${instance.name} starten`}
                    title="Diese Instanz starten"
                  >
                    <Play size={14} fill="currentColor" />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => openEdit(instance)}
                    aria-label={`${instance.name} bearbeiten`}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={() => setPendingDelete(instance)}
                    disabled={instances.length <= 1}
                    aria-label={`${instance.name} löschen`}
                    title={
                      instances.length <= 1
                        ? "Mindestens eine Instanz behalten"
                        : "Löschen"
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </footer>
            </article>
          );
        })}
      </div>

      <p className="instances-note">
        Jede Instanz lässt sich direkt über das Play-Symbol starten; sie wird dabei
        zur aktiven Instanz. {favorites.length} Favorit
        {favorites.length === 1 ? "" : "en"} erscheinen im Play-Switcher. Skin und Cape
        gelten launcherweit und bleiben im Tab „Skins“.
      </p>

      <Modal
        open={editor !== null}
        onClose={() => setEditor(null)}
        title={editor?.mode === "edit" ? "Instanz bearbeiten" : "Neue Instanz"}
        subtitle="Minecraft-Version und Loader"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditor(null)}>
              Abbrechen
            </Button>
            <Button variant="primary" onClick={save}>
              Speichern
            </Button>
          </>
        }
      >
        <div className="instance-form">
          <label className="instance-field">
            <span>Name</span>
            <input
              className="text-input"
              value={draft.name}
              maxLength={48}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
            />
          </label>

          <div className="instance-field">
            <div className="instance-field__head">
              <span>Minecraft-Version</span>
              <button
                type="button"
                className="link-btn instance-refresh"
                onClick={() => void refreshVersions(true)}
                disabled={versionsLoading}
              >
                <RefreshCw size={11} className={versionsLoading ? "instance-spin" : ""} />
                Neu laden
              </button>
            </div>
            <Select
              aria-label="Minecraft-Version"
              value={draft.version}
              options={versionOptions(draft.version)}
              onChange={(event) => setDraft({ ...draft, version: event.target.value })}
            />
            <span className="instance-field__hint">
              {versionsSource === "live"
                ? "Live von Mojang"
                : versionsSource === "cached"
                  ? "Mojang-Cache"
                  : "Browser-Vorschau"}{" "}
              · neueste Release: {versions[0]?.id ?? "—"}
            </span>
          </div>

          <label className="instance-field">
            <span>Mod-Profil</span>
            <Select
              aria-label="Mod-Profil"
              value={draft.modProfile}
              options={MOD_LOADERS.map((entry) => ({
                value: entry.id,
                label: entry.name,
              }))}
              onChange={(event) => setDraft({ ...draft, modProfile: event.target.value })}
            />
            <span className="instance-field__hint">
              {findLoader(draft.modProfile).description}
            </span>
          </label>
        </div>
      </Modal>

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title="Instanz löschen?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPendingDelete(null)}>
              Abbrechen
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (pendingDelete) {
                  if (detailId === pendingDelete.id) setDetailId(null);
                  updateConfig((current) => removeInstance(current, pendingDelete.id));
                }
                setPendingDelete(null);
              }}
            >
              Löschen
            </Button>
          </>
        }
      >
        <p className="modal-text">
          „{pendingDelete?.name}“ wird entfernt. Falls sie aktiv war, übernimmt die erste
          verbleibende Instanz. Skin, Cape und Einstellungen bleiben unverändert.
        </p>
      </Modal>

      {detailId ? (
        <InstanceDetail instanceId={detailId} onClose={() => setDetailId(null)} />
      ) : null}
    </div>
  );
}
