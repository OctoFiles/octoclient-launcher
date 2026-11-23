import { Check, ChevronUp, Cpu, Layers, Palette, Play, Sparkles, Wifi } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SkinHead } from "../../components/ui/SkinHead";
import { findLoader } from "../../data/versions";
import { formatMemory, shortUuid } from "../../lib/format";
import { activateInstance, activeInstance, favoriteInstances } from "../../lib/instances";
import type { PageId } from "../../lib/types";
import { useLauncher } from "../../state/LauncherProvider";
import { PlayerStage } from "./PlayerStage";
import "./play.css";

interface PlayViewProps {
  onNavigate: (page: PageId) => void;
  onRequireAuth: () => void;
}

function installStageLabel(stage: string): string {
  switch (stage) {
    case "version":
      return "Version wird geladen";
    case "libraries":
      return "Bibliotheken";
    case "assets":
      return "Assets";
    case "fabric":
      return "Fabric-Loader";
    case "runtime":
      return "Java wird installiert";
    default:
      return "Installation";
  }
}

export function PlayView({ onNavigate, onRequireAuth }: PlayViewProps) {
  const {
    config,
    account,
    system,
    launching,
    starting,
    installProgress,
    launch,
    updateConfig,
  } = useLauncher();
  const [menuOpen, setMenuOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement>(null);

  const active = activeInstance(config);
  const favorites = favoriteInstances(config);
  const installed = new Set((system?.installedVersions ?? []).map((entry) => entry.id));
  const versionLabel = active.version;
  const loader = findLoader(active.modProfile);
  const versionDisplay = loader.id === "vanilla" ? versionLabel : `${loader.name} ${versionLabel}`;
  const skinDataUrl = config.profile.customSkinDataUrl ?? account?.skinDataUrl;
  const busy = launching || starting;
  const installPercent =
    installProgress && installProgress.total > 0
      ? Math.min(100, Math.round((installProgress.current / installProgress.total) * 100))
      : 0;

  // Close the instance menu on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!switcherRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [menuOpen]);

  const handlePlay = () => {
    if (!account) {
      onRequireAuth();
      return;
    }
    void launch();
  };

  const chooseInstance = (id: string) => {
    updateConfig((current) => activateInstance(current, id));
    setMenuOpen(false);
  };

  return (
    <div className="view play-view">
      <header className="play-head">
        <div className="play-head__copy">
          <span className="eyebrow">OctoClient · Launcher</span>
          <h1 className="view-title">
            {account ? `Bereit, ${account.username}?` : "Willkommen bei OctoClient"}
          </h1>
          <p className="view-sub">
            {active.name} · {loader.description}
          </p>
        </div>

        <button
          type="button"
          className="play-manage"
          onClick={() => onNavigate("instances")}
          title="Instanzen verwalten"
        >
          <Layers size={14} />
          Instanzen
        </button>
      </header>

      <div className="play-stage-wrap">
        <PlayerStage
          skinId={config.profile.skinId}
          skinModel={config.profile.skinModel}
          capeId={config.profile.capeId}
          accessoryId={config.profile.accessoryId}
          headId={config.profile.headId}
          bandanaId={config.profile.bandanaId}
          wingId={config.profile.wingId}
          shieldId={config.profile.shieldId}
          skinDataUrlSrc={skinDataUrl}
          name={account?.username ?? "OctoClient"}
          performance={config.appearance.performance}
          reduceMotion={config.appearance.reduceMotion}
        />

        <div className="stage-badges">
          <span className="stage-badge">
            <Cpu size={12} /> {formatMemory(config.java.maxRamMb)} RAM
          </span>
          <span className="stage-badge">
            <Wifi size={12} /> {versionDisplay}
            {installed.has(active.version) ? "" : " · fehlt"}
          </span>
          <span className="stage-badge">
            <Sparkles size={12} /> {loader.name}
          </span>
        </div>

        <button
          type="button"
          className="stage-edit"
          onClick={() => onNavigate("skins")}
          title="Skin und Cape ändern"
        >
          <Palette size={13} />
          Anpassen
        </button>
        <span className="stage-hint">Ziehen zum Drehen</span>
      </div>

      <div className="play-actions">
        <div className="play-instance" ref={switcherRef}>
          <button
            type="button"
            className={["play-instance__trigger", menuOpen ? "play-instance__trigger--open" : ""]
              .filter(Boolean)
              .join(" ")}
            onClick={() => setMenuOpen((current) => !current)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            title="Favorisierte Instanz wählen"
          >
            <Layers size={14} />
            <span className="play-instance__text">
              <strong>{active.name}</strong>
              <em>
                {versionLabel} · {loader.name}
              </em>
            </span>
            <ChevronUp
              size={15}
              className={["play-instance__chevron", menuOpen ? "play-instance__chevron--open" : ""]
                .filter(Boolean)
                .join(" ")}
            />
          </button>

          {menuOpen ? (
            <div className="instance-menu" role="menu" aria-label="Favorisierte Instanzen">
              <span className="instance-menu__title">Favorisierte Instanzen</span>
              {favorites.map((instance) => {
                const isActive = instance.id === active.id;
                const instanceLoader = findLoader(instance.modProfile);
                return (
                  <button
                    key={instance.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={isActive}
                    className={["instance-menu__item", isActive ? "instance-menu__item--active" : ""]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => chooseInstance(instance.id)}
                  >
                    <span className="instance-menu__text">
                      <strong>{instance.name}</strong>
                      <em>
                        {instance.version} · {instanceLoader.name}
                      </em>
                    </span>
                    {isActive ? <Check size={14} /> : null}
                  </button>
                );
              })}
              {favorites.length === 0 ? (
                <p className="instance-menu__empty">Noch keine Favoriten markiert.</p>
              ) : null}
              <button
                type="button"
                className="instance-menu__manage"
                onClick={() => {
                  setMenuOpen(false);
                  onNavigate("instances");
                }}
              >
                Instanzen verwalten
              </button>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          className={["play-button", busy ? "play-button--busy" : ""]
            .filter(Boolean)
            .join(" ")}
          onClick={handlePlay}
          disabled={busy}
          aria-busy={busy}
        >
          <span
            className={[
              "play-button__progress",
              installPercent > 0 ? "play-button__progress--determinate" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-hidden="true"
          >
            <span style={installPercent > 0 ? { width: `${installPercent}%` } : undefined} />
          </span>
          <span className="play-button__icon">
            {busy ? <span className="play-button__spinner" /> : <Play size={22} fill="currentColor" />}
          </span>
          <span className="play-button__label">
            {busy
              ? installPercent > 0
                ? `${installPercent}%`
                : "STARTET…"
              : "PLAY"}
          </span>
        </button>
        <p className="play-hint">
          {starting
            ? "Spielfenster öffnet sich…"
            : account
              ? `${versionDisplay} · ${loader.description}`
              : "Mit deinem Microsoft-Konto anmelden, um Minecraft zu starten."}
        </p>
        {installProgress ? (
          <div className="play-install" role="status" aria-live="polite">
            <div className="play-install__head">
              <span>
                {installStageLabel(installProgress.stage)}
                {installProgress.version ? ` · ${installProgress.version}` : ""}
              </span>
              {installProgress.total > 0 ? (
                <span>
                  {installProgress.current} / {installProgress.total}
                </span>
              ) : null}
            </div>
            {installProgress.total > 0 ? (
              <div className="play-install__bar">
                <span
                  style={{
                    width: `${Math.min(
                      100,
                      Math.round((installProgress.current / installProgress.total) * 100),
                    )}%`,
                  }}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <aside className="play-rail">
        <section className="card rail-card rail-account">
          <header className="rail-card__head">
            <h2>Dein Konto</h2>
          </header>
          <div className="rail-account__body">
            <SkinHead
              skinId={config.profile.skinId}
              skinDataUrlSrc={skinDataUrl}
              size={44}
            />
            <div>
              <span className="rail-account__name">{account?.username ?? "Nicht angemeldet"}</span>
              <span className="rail-account__meta">
                {account ? `UUID ${shortUuid(account.uuid)}…` : "Microsoft-Konto erforderlich"}
              </span>
            </div>
          </div>
          <dl className="rail-stats">
            <div>
              <dt>Instanz</dt>
              <dd>{active.name}</dd>
            </div>
            <div>
              <dt>Skin</dt>
              <dd>
                {config.profile.customSkinDataUrl
                  ? "Eigener Skin"
                  : account?.skinDataUrl
                    ? "Microsoft-Skin"
                    : config.profile.skinId}
              </dd>
            </div>
            <div>
              <dt>Java</dt>
              <dd>{system?.java?.version ?? "nicht erkannt"}</dd>
            </div>
          </dl>
        </section>
      </aside>
    </div>
  );
}
