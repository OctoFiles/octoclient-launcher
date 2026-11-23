import {
  CheckCircle2,
  FolderSearch,
  ImagePlus,
  RotateCcw,
  ScanSearch,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState, type ChangeEvent } from "react";

import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import { Segmented } from "../../components/ui/Segmented";
import { SettingRow } from "../../components/ui/SettingRow";
import { Toggle } from "../../components/ui/Toggle";
import { readBackgroundImage } from "../../lib/background";
import { errorMessage, invoke } from "../../lib/bridge";
import { FONTS } from "../../lib/fonts";
import { formatMemory } from "../../lib/format";
import type { BackgroundMode, JavaInfo, PerformanceMode } from "../../lib/types";
import { useLauncher } from "../../state/LauncherProvider";
import "./settings.css";

type Tab = "java" | "game" | "behavior" | "appearance" | "system";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "java", label: "Java & RAM" },
  { id: "game", label: "Spiel" },
  { id: "behavior", label: "Verhalten" },
  { id: "appearance", label: "Darstellung" },
  { id: "system", label: "System & Integrationen" },
];

const ACCENT_PRESETS = ["#6ee7f9", "#a78bfa", "#4ade80", "#fb923c", "#f472b6"];
const BACKGROUND_PRESETS = ["#070d18", "#0b1424", "#101b2e", "#1a1230", "#06282b"];
const TEXT_PRESETS = ["#f3f8ff", "#ffffff", "#c9d7e8", "#ffe6b8"];

export function SettingsView() {
  const {
    config,
    system,
    saving,
    updateSection,
    resetConfig,
    refreshSystem,
    pushToast,
  } = useLauncher();
  const [tab, setTab] = useState<Tab>("java");
  const [detecting, setDetecting] = useState(false);
  const [autoDetected, setAutoDetected] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [bgBusy, setBgBusy] = useState(false);

  const memoryCap = useMemo(
    () => Math.max(4096, Math.min(65536, system?.totalMemoryMb ?? 8192)),
    [system?.totalMemoryMb],
  );

  const detectJava = async () => {
    setDetecting(true);
    try {
      // No path argument: the backend scans JAVA_HOME, PATH and the usual
      // install locations on its own.
      const info = await invoke<JavaInfo | null>("detect_java");
      if (info) {
        updateSection("java", { path: info.path });
        await refreshSystem();
        pushToast("success", `Java ${info.version ?? ""} automatisch erkannt (${info.source}).`);
      } else {
        pushToast(
          "info",
          "Keine Java-Installation gefunden. Beim Spielstart lädt der Launcher Mojangs Runtime.",
        );
      }
    } catch (error) {
      pushToast("error", errorMessage(error));
    } finally {
      setDetecting(false);
    }
  };

  // Detect automatically once the system scan has finished without a result.
  useEffect(() => {
    if (!system || system.java || autoDetected) return;
    setAutoDetected(true);
    void detectJava();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [system, autoDetected]);

  const setIntegration = (key: keyof typeof config.integrations, value: string) => {
    updateSection("integrations", { [key]: value.trim() ? value.trim() : null });
  };

  const handleBackgroundFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBgBusy(true);
    try {
      const dataUrl = await readBackgroundImage(file);
      updateSection("appearance", { backgroundImage: dataUrl, backgroundMode: "image" });
      pushToast("success", "Hintergrundbild gespeichert.");
    } catch (error) {
      pushToast("error", errorMessage(error));
    } finally {
      setBgBusy(false);
    }
  };

  const clearBackgroundImage = () => {
    updateSection("appearance", {
      backgroundImage: null,
      backgroundMode:
        config.appearance.backgroundMode === "image"
          ? "stars"
          : config.appearance.backgroundMode,
    });
  };

  return (
    <div className="view settings-view">
      <header className="view-head">
        <div>
          <span className="eyebrow">Konfiguration</span>
          <h1 className="view-title">Einstellungen</h1>
          <p className="view-sub">
            Änderungen werden automatisch gespeichert
            {saving === "saving"
              ? " …"
              : saving === "error"
                ? " — letzter Speichervorgang fehlgeschlagen."
                : "."}
          </p>
        </div>
        <div className="save-indicator">
          <CheckCircle2 size={14} />
          <span>{saving === "saving" ? "Speichert…" : "Autosave aktiv"}</span>
        </div>
      </header>

      <div className="settings-tabs" role="tablist" aria-label="Einstellungsbereiche">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={tab === entry.id}
            className={["settings-tab", tab === entry.id ? "settings-tab--active" : ""].filter(Boolean).join(" ")}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "java" ? (
        <section className="card settings-section">
          <header className="panel-head">
            <h2>Java & Arbeitsspeicher</h2>
            <span className="panel-hint">Startparameter</span>
          </header>

          <SettingRow
            label="Java automatisch"
            description="Der Launcher sucht JAVA_HOME, PATH und die üblichen Installationsordner. Fehlt eine passende Version, lädt er beim Start Mojangs Runtime – eine manuelle Pfadeingabe ist nicht nötig."
            stacked
          >
            <div className="java-auto">
              <div className="java-auto__status">
                <ScanSearch size={14} />
                <span>
                  {system?.java
                    ? "Java gefunden"
                    : detecting
                      ? "Suche läuft…"
                      : "Noch nicht gefunden"}
                </span>
                {system?.java?.version ? (
                  <em className="java-auto__version">Java {system.java.version}</em>
                ) : null}
              </div>
              <code className="java-auto__path">
                {system?.java?.path ?? "Automatische Suche aktiv"}
              </code>
              <div className="java-auto__foot">
                <span>
                  {system?.java
                    ? `${system.java.vendor ?? "Java"} · Quelle: ${system.java.source}`
                    : "Wird beim Start und auf Wunsch erneut gesucht."}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<ScanSearch size={14} />}
                  loading={detecting}
                  onClick={() => void detectJava()}
                >
                  Automatisch suchen
                </Button>
              </div>
            </div>
          </SettingRow>

          <SettingRow
            label="Maximaler RAM"
            description={`Empfohlen: 4–8 GB. System: ${formatMemory(system?.totalMemoryMb ?? 0)}.`}
          >
            <div className="ram-control">
              <input
                type="range"
                min={1024}
                max={memoryCap}
                step={512}
                value={config.java.maxRamMb}
                onChange={(event) =>
                  updateSection("java", { maxRamMb: Number(event.target.value) })
                }
                aria-label="Maximaler Arbeitsspeicher"
              />
              <span className="ram-value">{formatMemory(config.java.maxRamMb)}</span>
            </div>
          </SettingRow>

          <SettingRow label="Start-RAM" description="Wird als -Xms verwendet.">
            <div className="ram-control ram-control--short">
              <input
                type="number"
                className="text-input text-input--number"
                min={512}
                max={config.java.maxRamMb}
                step={256}
                value={config.java.minRamMb}
                onChange={(event) =>
                  updateSection("java", { minRamMb: Number(event.target.value) || 512 })
                }
                aria-label="Start-RAM in MB"
              />
              <span className="unit">MB</span>
            </div>
          </SettingRow>

          <SettingRow
            label="Zusätzliche JVM-Argumente"
            description="Durch Leerzeichen getrennt, z. B. -XX:+UseG1GC"
            stacked
          >
            <input
              className="text-input"
              value={config.java.extraJvmArgs}
              placeholder="-XX:+UseG1GC -XX:+UnlockExperimentalVMOptions"
              onChange={(event) =>
                updateSection("java", { extraJvmArgs: event.target.value })
              }
              spellCheck={false}
            />
          </SettingRow>
        </section>
      ) : null}

      {tab === "game" ? (
        <section className="card settings-section">
          <header className="panel-head">
            <h2>Spiel</h2>
            <span className="panel-hint">Fenster & Verzeichnis</span>
          </header>

          <p className="panel-note">
            Minecraft-Version und Mod-Profil wählst du im Tab „Instanzen“ und auf
            „Spielen“ über den Pfeil über dem PLAY-Button.
          </p>

          <SettingRow label="Auflösung" description="Fenstergröße des Spiels.">
            <div className="resolution">
              <input
                type="number"
                className="text-input text-input--number"
                value={config.game.width}
                min={320}
                max={7680}
                onChange={(event) =>
                  updateSection("game", { width: Number(event.target.value) || 1280 })
                }
                aria-label="Breite"
              />
              <span className="unit">×</span>
              <input
                type="number"
                className="text-input text-input--number"
                value={config.game.height}
                min={240}
                max={4320}
                onChange={(event) =>
                  updateSection("game", { height: Number(event.target.value) || 720 })
                }
                aria-label="Höhe"
              />
            </div>
          </SettingRow>

          <SettingRow label="Vollbild" description="Startet Minecraft im Vollbildmodus.">
            <Toggle
              label="Vollbild"
              checked={config.game.fullscreen}
              onChange={(next) => updateSection("game", { fullscreen: next })}
            />
          </SettingRow>

          <SettingRow
            label="Spielverzeichnis"
            description={`Basisordner für Installationen. Leer = Standardordner (${system?.defaultGameDir ?? "~/.minecraft"}). Eigene Instanzen erhalten dort einen Unterordner.`}
            stacked
          >
            <div className="inline-controls">
              <FolderSearch size={15} className="inline-icon" />
              <input
                className="text-input"
                value={config.game.directory ?? ""}
                placeholder={system?.defaultGameDir ?? "%APPDATA%\\.minecraft"}
                onChange={(event) =>
                  updateSection("game", { directory: event.target.value || null })
                }
                spellCheck={false}
              />
            </div>
          </SettingRow>
        </section>
      ) : null}

      {tab === "behavior" ? (
        <>
          <section className="card settings-section">
            <header className="panel-head">
              <h2>Beim Starten</h2>
            </header>
            <SettingRow label="Launcher schließen" description="Beendet den Launcher nach dem Spielstart.">
              <Toggle
                label="Launcher schließen"
                checked={config.launch.closeLauncher}
                onChange={(next) => updateSection("launch", { closeLauncher: next })}
              />
            </SettingRow>
            <SettingRow label="Bei Fehlern geöffnet bleiben" description="Zeigt die Fehlermeldung im Launcher.">
              <Toggle
                label="Bei Fehlern geöffnet bleiben"
                checked={config.launch.keepOpenOnError}
                onChange={(next) => updateSection("launch", { keepOpenOnError: next })}
              />
            </SettingRow>
            <SettingRow label="Konsolenfenster anzeigen" description="Startet Java mit sichtbarer Konsole.">
              <Toggle
                label="Konsolenfenster"
                checked={config.launch.showConsole}
                onChange={(next) => updateSection("launch", { showConsole: next })}
              />
            </SettingRow>
            <SettingRow label="Automatisch aktualisieren" description="Prüft beim Start auf Launcher-Updates.">
              <Toggle
                label="Automatische Updates"
                checked={config.launch.autoUpdate}
                onChange={(next) => updateSection("launch", { autoUpdate: next })}
              />
            </SettingRow>
          </section>

          <section className="card settings-section">
            <header className="panel-head">
              <h2>Discord RPC</h2>
              <span className="panel-hint">Discord IPC</span>
            </header>
            <SettingRow
              label="Discord App-ID"
              description="Application-ID deiner Discord-App (Developer Portal → Applications). Ohne ID bleibt die Presence aus."
              stacked
            >
              <input
                className="text-input"
                value={config.discord.appId ?? ""}
                placeholder="123456789012345678"
                onChange={(event) =>
                  updateSection("discord", {
                    appId: event.target.value.trim() || null,
                  })
                }
                spellCheck={false}
              />
            </SettingRow>
            <SettingRow label="Rich Presence" description="Zeigt den Launcher-Status in Discord.">
              <Toggle
                label="Discord Rich Presence"
                checked={config.discord.enabled}
                onChange={(next) => updateSection("discord", { enabled: next })}
              />
            </SettingRow>
            <SettingRow label="Server anzeigen" description="Teilt den aktuellen Server in der Presence.">
              <Toggle
                label="Server anzeigen"
                checked={config.discord.showServer}
                disabled={!config.discord.enabled}
                onChange={(next) => updateSection("discord", { showServer: next })}
              />
            </SettingRow>
            <p className="panel-note">
              Der Launcher verbindet sich direkt per Discord-IPC und zeigt Instanz,
              Minecraft-Version und Spielzeit an. Trage im Developer Portal unter
              Rich Presence die Asset-Namen „octo“ und „minecraft“ an, damit die
              Bilder erscheinen.
            </p>
          </section>
        </>
      ) : null}

      {tab === "appearance" ? (
        <>
          <section className="card settings-section">
            <header className="panel-head">
              <h2>Liquid Glass</h2>
              <span className="panel-hint">Theme anpassen</span>
            </header>

            <SettingRow
              label="Eckenradius"
              description="0 px = eckig, 28 px = stark gerundet. Gilt für Panels, Buttons und Eingaben."
            >
              <div className="radius-control">
                <span className="radius-control__edge">Eckig</span>
                <input
                  type="range"
                  min={0}
                  max={28}
                  step={1}
                  value={config.appearance.cornerRadius}
                  onChange={(event) =>
                    updateSection("appearance", { cornerRadius: Number(event.target.value) })
                  }
                  aria-label="Eckenradius in Pixeln"
                />
                <span className="radius-value">{config.appearance.cornerRadius} px</span>
              </div>
            </SettingRow>

            <SettingRow
              label="Mainfarbe"
              description="Akzent für Buttons, Fokus, Highlights und den Aurora-Hintergrund."
            >
              <div className="accent-picker">
                {ACCENT_PRESETS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={["accent-swatch", config.appearance.accent === color ? "accent-swatch--active" : ""].filter(Boolean).join(" ")}
                    style={{ background: color }}
                    onClick={() => updateSection("appearance", { accent: color })}
                    aria-label={`Akzent ${color}`}
                  />
                ))}
                <input
                  type="color"
                  value={config.appearance.accent}
                  onChange={(event) =>
                    updateSection("appearance", { accent: event.target.value })
                  }
                  className="accent-input"
                  aria-label="Eigene Akzentfarbe"
                />
              </div>
            </SettingRow>

            <SettingRow
              label="Hintergrundfarbe"
              description="Grundton hinter den Glasflächen und im Sternenhimmel."
            >
              <div className="accent-picker">
                {BACKGROUND_PRESETS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={["accent-swatch", config.appearance.backgroundColor === color ? "accent-swatch--active" : ""].filter(Boolean).join(" ")}
                    style={{ background: color }}
                    onClick={() => updateSection("appearance", { backgroundColor: color })}
                    aria-label={`Hintergrund ${color}`}
                  />
                ))}
                <input
                  type="color"
                  value={config.appearance.backgroundColor}
                  onChange={(event) =>
                    updateSection("appearance", { backgroundColor: event.target.value })
                  }
                  aria-label="Eigene Hintergrundfarbe"
                />
              </div>
            </SettingRow>

            <SettingRow
              label="Kachel-Farbe"
              description="Färbt alle Karten, Instanz-Kacheln, Skins und Cosmetics auf einmal."
            >
              <div className="accent-picker">
                {ACCENT_PRESETS.map((color) => (
                  <button
                    key={`tile-${color}`}
                    type="button"
                    className={[
                      "accent-swatch",
                      config.appearance.tileTint === color ? "accent-swatch--active" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{ background: color }}
                    onClick={() => updateSection("appearance", { tileTint: color })}
                    aria-label={`Kachelfarbe ${color}`}
                  />
                ))}
                <input
                  type="color"
                  value={config.appearance.tileTint}
                  onChange={(event) =>
                    updateSection("appearance", { tileTint: event.target.value })
                  }
                  className="accent-input"
                  aria-label="Eigene Kachelfarbe"
                />
              </div>
            </SettingRow>

            <SettingRow
              label="Kachel-Deckkraft"
              description="0 % = Kacheln verschwinden komplett, 100 % = volle Deckkraft und Farbe."
            >
              <div className="radius-control">
                <span className="radius-control__edge">Aus</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={config.appearance.tileOpacity}
                  onChange={(event) =>
                    updateSection("appearance", { tileOpacity: Number(event.target.value) })
                  }
                  aria-label="Kachel-Deckkraft in Prozent"
                />
                <span className="radius-value">{config.appearance.tileOpacity} %</span>
              </div>
            </SettingRow>

            <SettingRow
              label="Schriftfarbe"
              description="Gilt für Titel, Beschriftungen, Hinweise, Werte und Eingaben im ganzen Launcher."
            >
              <div className="accent-picker">
                {TEXT_PRESETS.map((color) => (
                  <button
                    key={`text-${color}`}
                    type="button"
                    className={[
                      "accent-swatch",
                      config.appearance.textColor === color ? "accent-swatch--active" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{ background: color }}
                    onClick={() => updateSection("appearance", { textColor: color })}
                    aria-label={`Schriftfarbe ${color}`}
                  />
                ))}
                <input
                  type="color"
                  value={config.appearance.textColor ?? "#f3f8ff"}
                  onChange={(event) =>
                    updateSection("appearance", { textColor: event.target.value })
                  }
                  className="accent-input"
                  aria-label="Eigene Schriftfarbe"
                />
              </div>
            </SettingRow>

            <SettingRow
              label="Schrift"
              description="Schriftart für Titel, Beschriftungen und alle Eingaben."
            >
              <div className="font-picker">
                {FONTS.map((font) => (
                  <button
                    key={font.id}
                    type="button"
                    className={[
                      "font-option",
                      config.appearance.fontFamily === font.id ? "font-option--active" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={{ fontFamily: font.stack }}
                    onClick={() => updateSection("appearance", { fontFamily: font.id })}
                    aria-pressed={config.appearance.fontFamily === font.id}
                  >
                    {font.label}
                  </button>
                ))}
              </div>
            </SettingRow>
          </section>

          <section className="card settings-section">
            <header className="panel-head">
              <h2>Hintergrund</h2>
              <span className="panel-hint">Sternenhimmel, Aurora oder eigenes Bild</span>
            </header>

            <SettingRow label="Hintergrundart" description="Was hinter den Glasflächen liegt.">
              <Segmented<BackgroundMode>
                ariaLabel="Hintergrundart"
                value={config.appearance.backgroundMode}
                options={[
                  { value: "stars", label: "Sterne" },
                  { value: "aurora", label: "Aurora" },
                  { value: "solid", label: "Einfarbig" },
                  { value: "image", label: "Bild" },
                ]}
                onChange={(value) => {
                  if (value === "image" && !config.appearance.backgroundImage) {
                    pushToast("info", "Wähle zuerst ein Hintergrundbild aus.");
                    return;
                  }
                  updateSection("appearance", { backgroundMode: value });
                }}
              />
            </SettingRow>

            <SettingRow
              label="Eigenes Hintergrundbild"
              description="PNG, JPG, WebP oder GIF. Bilder werden verkleinert, animierte GIFs bleiben animiert (max. 4 MB)."
            >
              <div className="bg-controls">
                <label className="btn btn--sm btn--secondary bg-upload">
                  <ImagePlus size={14} />
                  {bgBusy ? "Wird geladen…" : "Bild wählen"}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/gif"
                    hidden
                    disabled={bgBusy}
                    onChange={handleBackgroundFile}
                  />
                </label>
                {config.appearance.backgroundImage ? (
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost"
                    onClick={clearBackgroundImage}
                  >
                    <Trash2 size={13} /> Entfernen
                  </button>
                ) : null}
              </div>
            </SettingRow>

            {config.appearance.backgroundImage ? (
              <div
                className="bg-preview"
                style={{ backgroundImage: `url(${config.appearance.backgroundImage})` }}
              >
                <span className="bg-preview__tag">Eigenes Bild</span>
              </div>
            ) : null}

            <p className="panel-note">
              Sterne nutzt den animierten Sternenhimmel. Aurora erzeugt weiche Farbwolken aus
              Main- und Hintergrundfarbe, Einfarbig nur den Grundton. Eigene Bilder werden
              maximal 1920 px groß gespeichert und mit den Glasflächen abgedunkelt.
            </p>
          </section>

          <section className="card settings-section">
            <header className="panel-head">
              <h2>Performance</h2>
              <span className="panel-hint">Galaxy & 3D</span>
            </header>

            <SettingRow label="Animationen" description="Steuert Sterne, Sternschnuppen und Parallaxe.">
              <Segmented<PerformanceMode>
                ariaLabel="Performance-Stufe"
                value={config.appearance.performance}
                options={[
                  { value: "high", label: "Hoch" },
                  { value: "balanced", label: "Ausgewogen" },
                  { value: "low", label: "Niedrig" },
                ]}
                onChange={(value) => updateSection("appearance", { performance: value })}
              />
            </SettingRow>

            <SettingRow label="Bewegung reduzieren" description="Statischer Hintergrund, keine Idle-Animation.">
              <Toggle
                label="Bewegung reduzieren"
                checked={config.appearance.reduceMotion}
                onChange={(next) => updateSection("appearance", { reduceMotion: next })}
              />
            </SettingRow>

            <SettingRow label="Partikel" description="Sternschnuppen und Funkeln.">
              <Toggle
                label="Partikel"
                checked={config.appearance.showParticles}
                disabled={config.appearance.reduceMotion}
                onChange={(next) => updateSection("appearance", { showParticles: next })}
              />
            </SettingRow>

            <p className="panel-note">
              Niedrig = statisches Bild, 1× Pixelverhältnis und 30 FPS für die 3D-Bühne.
              Ideal für schwächere Systeme oder Akkubetrieb.
            </p>
          </section>
        </>
      ) : null}

      {tab === "system" ? (
        <>
          <section className="card settings-section">
            <header className="panel-head">
              <h2>Fenster & System</h2>
            </header>
            <SettingRow label="Minimiert starten" description="Startet nur im Taskleisten-Bereich.">
              <Toggle
                label="Minimiert starten"
                checked={config.system.startMinimized}
                onChange={(next) => updateSection("system", { startMinimized: next })}
              />
            </SettingRow>
            <SettingRow label="Immer im Vordergrund" description="Fenster bleibt über anderen Anwendungen.">
              <Toggle
                label="Immer im Vordergrund"
                checked={config.system.alwaysOnTop}
                onChange={(next) => updateSection("system", { alwaysOnTop: next })}
              />
            </SettingRow>
            <SettingRow label="Konfigurationsdatei" description="Wird beim Start geladen." stacked>
              <code className="path-box">{system?.configFile ?? "…"}</code>
            </SettingRow>
          </section>

          <section className="card settings-section">
            <header className="panel-head">
              <h2>Integrationen</h2>
              <span className="panel-hint">Platzhalter für eigene Backends</span>
            </header>

            <SettingRow
              label="Microsoft Client-ID"
              description="Optional: eigene Azure-App (Public Client, Device Code aktiviert)."
              stacked
            >
              <input
                className="text-input"
                value={config.integrations.msClientId ?? ""}
                placeholder="00000000-0000-0000-0000-000000000000"
                onChange={(event) => setIntegration("msClientId", event.target.value)}
                spellCheck={false}
              />
            </SettingRow>

            <SettingRow
              label="News-Feed-URL"
              description="HTTPS-Endpoint, der News-Items als JSON liefert (siehe news.rs)."
              stacked
            >
              <input
                className="text-input"
                value={config.integrations.newsFeedUrl ?? ""}
                placeholder="https://api.example.com/v1/news"
                onChange={(event) => setIntegration("newsFeedUrl", event.target.value)}
                spellCheck={false}
              />
            </SettingRow>

          </section>

          <section className="card settings-section">
            <header className="panel-head">
              <h2>System</h2>
            </header>
            <dl className="system-grid">
              <div>
                <dt>Betriebssystem</dt>
                <dd>{system ? `${system.os} · ${system.arch}` : "…"}</dd>
              </div>
              <div>
                <dt>Arbeitsspeicher</dt>
                <dd>{formatMemory(system?.totalMemoryMb ?? 0)}</dd>
              </div>
              <div>
                <dt>Java</dt>
                <dd>{system?.java ? `${system.java.version} (${system.java.vendor})` : "nicht erkannt"}</dd>
              </div>
              <div>
                <dt>Installierte Versionen</dt>
                <dd>{system?.installedVersions.length ?? 0}</dd>
              </div>
              <div>
                <dt>Spielverzeichnis</dt>
                <dd className="mono">{system?.gameDir ?? "…"}</dd>
              </div>
              <div>
                <dt>Launcher</dt>
                <dd>OctoClient {system?.appVersion ?? "0.1.0"}</dd>
              </div>
            </dl>

            <div className="danger-zone">
              <div>
                <span className="danger-zone__title">Konfiguration zurücksetzen</span>
                <span className="danger-zone__hint">
                  Setzt alle Einstellungen auf Standardwerte. Freunde und Konto bleiben erhalten.
                </span>
              </div>
              <Button
                variant="danger"
                icon={<RotateCcw size={14} />}
                onClick={() => setConfirmReset(true)}
              >
                Zurücksetzen
              </Button>
            </div>
          </section>
        </>
      ) : null}

      <Modal
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        title="Einstellungen zurücksetzen?"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmReset(false)}>
              Abbrechen
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmReset(false);
                void resetConfig();
              }}
            >
              Zurücksetzen
            </Button>
          </>
        }
      >
        <p className="modal-text">
          Java-Pfad, RAM, Auflösung, Startverhalten und Darstellung werden auf die
          Standardwerte gesetzt. Deine Freundesliste und die Microsoft-Sitzung bleiben
          unberührt.
        </p>
      </Modal>
    </div>
  );
}
