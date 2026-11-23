import {
  Backpack,
  Check,
  Crown,
  Ribbon,
  RotateCcw,
  Search,
  Shield,
  Shirt,
  Sparkles,
  Trash2,
  Upload,
  Wind,
  Gamepad2,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useRef, useState, type ChangeEvent } from "react";

import { Button } from "../../components/ui/Button";
import { Segmented } from "../../components/ui/Segmented";
import { SkinHead } from "../../components/ui/SkinHead";
import { errorMessage, invoke, isDesktop } from "../../lib/bridge";
import type { ResolvedSkin, SkinModel } from "../../lib/types";
import { useLauncher } from "../../state/LauncherProvider";
import {
  COSMETIC_CATEGORIES,
  getCosmeticItem,
  selectedCosmeticId,
  type CosmeticCategory,
} from "../play/minecraft/cosmetics";
import {
  getSkin,
  SKINS,
  skinDataUrl as skinPngDataUrl,
} from "../play/minecraft/skin";
import { PlayerStage } from "../play/PlayerStage";
import { CosmeticsModal } from "./CosmeticsModal";
import "./skins.css";

const CATEGORY_ICONS: Record<CosmeticCategory, LucideIcon> = {
  capes: Shirt,
  accessories: Backpack,
  heads: Crown,
  bandanas: Ribbon,
  wings: Wind,
  shields: Shield,
};

/** Reads a skin PNG from disk and checks the Minecraft skin dimensions. */
function readSkinPng(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.name.toLowerCase().endsWith(".png") && !file.type.includes("png")) {
      reject(new Error("Skins müssen PNG-Dateien sein."));
      return;
    }
    if (file.size > 2_000_000) {
      reject(new Error("Die Skin-Datei ist zu groß (maximal 2 MB)."));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Die Datei konnte nicht gelesen werden."));
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const image = new Image();
      image.onerror = () => reject(new Error("Die Datei ist kein gültiges PNG."));
      image.onload = () => {
        if (image.width !== 64 || (image.height !== 64 && image.height !== 32)) {
          reject(
            new Error(
              `Skins müssen 64×64 oder 64×32 Pixel groß sein (dieses Bild: ${image.width}×${image.height}).`,
            ),
          );
          return;
        }
        resolve(dataUrl);
      };
      image.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });
}

export function SkinsView() {
  const { config, account, updateSection, rememberSkin, removeSkin, pushToast } = useLauncher();
  const skin = getSkin(config.profile.skinId);
  const customSkin = config.profile.customSkinDataUrl;
  const skinDataUrl = customSkin ?? account?.skinDataUrl ?? null;
  const skinModel = config.profile.skinModel;

  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [customName, setCustomName] = useState<string | null>(null);
  const [cosmeticsOpen, setCosmeticsOpen] = useState(false);
  const [cosmeticCategory, setCosmeticCategory] = useState<CosmeticCategory>("capes");
  const fileRef = useRef<HTMLInputElement>(null);

  const activeHistory = config.profile.customSkins.find(
    (entry) => entry.dataUrl === customSkin,
  );
  const skinLabel = customSkin
    ? (activeHistory?.name ?? customName ?? "Eigener Skin")
    : account?.skinDataUrl
      ? "Microsoft-Skin"
      : skin.name;
  const modelLabel = skinModel === "slim" ? "Slim" : "Classic";
  const capeItem = getCosmeticItem("capes", config.profile.capeId);

  const openCosmetics = (category: CosmeticCategory) => {
    setCosmeticCategory(category);
    setCosmeticsOpen(true);
  };

  const lastApplied = useRef<string | null>(null);

  /**
   * Uploads a skin to the Minecraft account as soon as it is picked, so the
   * skin in the launcher is the skin in the game without an extra click.
   * Repeat picks of the same skin are ignored instead of re-uploading.
   */
  const applySkin = useCallback(
    async (dataUrl: string, model: SkinModel, label: string) => {
      if (!isDesktop || !account) return;
      const key = `${model}:${dataUrl.length}:${dataUrl.slice(-48)}`;
      if (lastApplied.current === key) return;
      lastApplied.current = key;
      try {
        await invoke("apply_minecraft_skin", { dataUrl, model });
        pushToast("success", `Skin „${label}“ ist jetzt in Minecraft aktiv.`);
      } catch (error) {
        lastApplied.current = null;
        pushToast(
          "error",
          `Skin konnte nicht übernommen werden: ${errorMessage(error)}`,
        );
      }
    },
    [account, pushToast],
  );

  const loadByName = async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      pushToast("info", "Gib einen Minecraft-Namen oder eine UUID ein.");
      return;
    }
    if (!isDesktop) {
      pushToast(
        "info",
        "Skins von Mojang lassen sich nur in der Desktop-App laden. Eine PNG-Datei funktioniert auch hier.",
      );
      return;
    }
    setBusy(true);
    try {
      const resolved = await invoke<ResolvedSkin>("resolve_minecraft_skin", {
        query: trimmed,
      });
      const model: SkinModel = resolved.model === "slim" ? "slim" : "classic";
      rememberSkin(resolved.name, resolved.skinDataUrl, model);
      setCustomName(resolved.name);
      setQuery("");
      pushToast(
        "success",
        `Skin von ${resolved.name} geladen (${resolved.model === "slim" ? "Slim" : "Classic"}).`,
      );
      void applySkin(resolved.skinDataUrl, model, resolved.name);
    } catch (error) {
      pushToast("error", errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const loadFromFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      const dataUrl = await readSkinPng(file);
      const name = file.name.replace(/\.png$/i, "");
      rememberSkin(name, dataUrl, skinModel);
      setCustomName(name);
      pushToast("success", "Skin-Datei geladen.");
      void applySkin(dataUrl, skinModel, name);
    } catch (error) {
      pushToast("error", errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const resetSkin = () => {
    updateSection("profile", { customSkinDataUrl: null });
    setCustomName(null);
    pushToast("info", "Eigener Skin entfernt – es gilt wieder der Konto-Skin.");
  };

  return (
    <div className="view skins-view">
      <header className="view-head">
        <div>
          <span className="eyebrow">Kosmetik</span>
          <h1 className="view-title">Skins & Cosmetics</h1>
          <p className="view-sub">
            Skin, Modell und alle Cosmetics auf einer Seite – ohne Scrollen.
          </p>
        </div>
        <div className="skin-summary">
          <SkinHead skinId={skin.id} skinDataUrlSrc={skinDataUrl} size={40} />
          <div>
            <span>{skinLabel}</span>
            <small>
              {modelLabel} · {capeItem.name} Cape
            </small>
          </div>
        </div>
      </header>

      <div className="skins-layout">
        <section className="skins-preview card">
          <PlayerStage
            skinId={skin.id}
            skinModel={skinModel}
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
            showNameTag={false}
          />
          <div className="skins-preview__caption">
            <span>{customSkin ? "Eigener Skin" : skin.tagline}</span>
            <span className="dot-sep" />
            <span>
              {modelLabel} · {capeItem.name}
            </span>
          </div>
        </section>

        <div className="skins-panels">
          <section className="card skin-panel skin-panel--compact">
            <header className="panel-head">
              <h2>Skin</h2>
              <span className="panel-hint">{skinLabel}</span>
            </header>

            <div className="skin-model-row">
              <span>Arm-Modell</span>
              <Segmented<SkinModel>
                ariaLabel="Skin-Modell"
                value={skinModel}
                options={[
                  { value: "classic", label: "Classic" },
                  { value: "slim", label: "Slim" },
                ]}
                onChange={(value) => updateSection("profile", { skinModel: value })}
              />
            </div>

            <div className="skin-source">
              <div className="skin-source__row">
                <span className="skin-source__input">
                  <Search size={13} />
                  <input
                    aria-label="Minecraft-Name oder UUID"
                    value={query}
                    placeholder="Name oder UUID"
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void loadByName();
                      }
                    }}
                  />
                </span>
                <Button
                  size="sm"
                  variant="primary"
                  loading={busy}
                  onClick={() => void loadByName()}
                >
                  Laden
                </Button>
              </div>

              <div className="skin-source__row">
                <button
                  type="button"
                  className="skin-file-btn"
                  onClick={() => fileRef.current?.click()}
                  disabled={busy}
                >
                  <Upload size={13} />
                  PNG-Datei
                </button>
                {customSkin ? (
                  <button type="button" className="skin-reset" onClick={resetSkin}>
                    <RotateCcw size={12} />
                    Zurücksetzen
                  </button>
                ) : null}
                <input
                  ref={fileRef}
                  className="skin-file-input"
                  type="file"
                  accept="image/png,.png"
                  onChange={(event) => void loadFromFile(event)}
                />
              </div>

              <div className="skin-source__row">
                <span className="skin-apply-hint">
                  <Gamepad2 size={13} />
                  {!account
                    ? "Melde dich an, dann wird der Skin automatisch übernommen."
                    : isDesktop
                      ? `Wird automatisch übernommen · ${modelLabel}`
                      : "Automatisch übernehmen geht nur in der Desktop-App."}
                </span>
              </div>
            </div>

            <div className="skin-grid skin-grid--compact">
              {SKINS.map((entry) => {
                const active = entry.id === config.profile.skinId && !customSkin;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={[
                      "skin-option",
                      "skin-option--compact",
                      active ? "skin-option--active" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => {
                      updateSection("profile", {
                        skinId: entry.id,
                        customSkinDataUrl: null,
                      });
                      setCustomName(null);
                      void applySkin(skinPngDataUrl(entry.id), skinModel, entry.name);
                    }}
                    aria-pressed={active}
                    title={entry.tagline}
                  >
                    <SkinHead skinId={entry.id} size={34} />
                    <span className="skin-option__name">{entry.name}</span>
                    {active ? <Check size={11} className="skin-option__check" /> : null}
                  </button>
                );
              })}

              {config.profile.customSkins.map((entry) => {
                const active = entry.dataUrl === customSkin;
                return (
                  <div
                    key={entry.id}
                    className={[
                      "skin-option",
                      "skin-option--compact",
                      "skin-option--history",
                      active ? "skin-option--active" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    title={`${entry.name} · ${entry.model === "slim" ? "Slim" : "Classic"}`}
                  >
                    <button
                      type="button"
                      className="skin-option__hit"
                      onClick={() => {
                        updateSection("profile", {
                          customSkinDataUrl: entry.dataUrl,
                          skinModel: entry.model,
                        });
                        void applySkin(entry.dataUrl, entry.model, entry.name);
                      }}
                      aria-pressed={active}
                    >
                      <SkinHead skinId="frost" skinDataUrlSrc={entry.dataUrl} size={34} />
                      <span className="skin-option__name">{entry.name}</span>
                      {active ? <Check size={11} className="skin-option__check" /> : null}
                    </button>
                    <button
                      type="button"
                      className="skin-option__remove"
                      aria-label={`${entry.name} aus dem Verlauf entfernen`}
                      onClick={() => removeSkin(entry.id)}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>

      <section className="cosmetics-strip card">
        <header className="cosmetics-strip__head">
          <div>
            <h2>Capes & Cosmetics</h2>
            <span>Klicke eine Kachel, um alle Varianten zu öffnen.</span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            icon={<Sparkles size={13} />}
            onClick={() => openCosmetics("capes")}
          >
            Alle ansehen
          </Button>
        </header>

        <div className="cosmetic-tiles">
          {COSMETIC_CATEGORIES.map((entry) => {
            const Icon = CATEGORY_ICONS[entry.id];
            const item = getCosmeticItem(
              entry.id,
              selectedCosmeticId(config.profile, entry.id),
            );
            const empty = item.id === "none";
            return (
              <button
                key={entry.id}
                type="button"
                className="cosmetic-tile"
                onClick={() => openCosmetics(entry.id)}
                title={`${entry.label}: ${empty ? "Keine" : item.name}`}
              >
                <span
                  className="cosmetic-tile__art"
                  style={
                    empty
                      ? undefined
                      : {
                          background: `linear-gradient(150deg, ${item.primary}, ${item.secondary})`,
                          borderColor: item.accent,
                        }
                  }
                >
                  {entry.id === "capes" && !empty ? (
                    <span
                      className="cosmetic-tile__cape"
                      style={{
                        background: `linear-gradient(to bottom, ${item.primary}, ${item.secondary})`,
                        borderColor: item.accent,
                      }}
                    >
                      <span
                        className="cosmetic-tile__emblem"
                        style={{ background: item.accent }}
                      />
                    </span>
                  ) : (
                    <Icon size={14} style={{ color: empty ? "#64748b" : item.accent }} />
                  )}
                </span>
                <span className="cosmetic-tile__text">
                  <strong>{entry.label}</strong>
                  <em>{empty ? "Keine" : item.name}</em>
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {cosmeticsOpen ? (
        <CosmeticsModal
          initialCategory={cosmeticCategory}
          onClose={() => setCosmeticsOpen(false)}
        />
      ) : null}
    </div>
  );
}
