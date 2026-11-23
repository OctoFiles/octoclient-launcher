import {
  Backpack,
  Check,
  CircleDashed,
  Crown,
  Dog,
  Glasses,
  GraduationCap,
  HardHat,
  Rabbit,
  RefreshCw,
  Ribbon,
  Search,
  Shield,
  Shirt,
  Sparkles,
  VenetianMask,
  Wind,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "../../components/ui/Button";
import { Modal } from "../../components/ui/Modal";
import {
  COSMETIC_CATEGORIES,
  COSMETIC_COUNT,
  cosmeticItems,
  cosmeticPreviewShape,
  selectedCosmeticId,
  type CosmeticCategory,
  type CosmeticItem,
  type CosmeticPreviewShape,
} from "../play/minecraft/cosmetics";
import { useLauncher } from "../../state/LauncherProvider";
import { ANIMATED_CAPES, animatedCapeThumbUrl } from "../play/minecraft/animatedCapes";
import {
  cosmeticTextureUrl,
  loadCosmeticManifest,
} from "../play/minecraft/cosmeticAssets";

const CATEGORY_ICONS: Record<CosmeticCategory, LucideIcon> = {
  capes: Shirt,
  accessories: Backpack,
  heads: Crown,
  bandanas: Ribbon,
  wings: Wind,
  shields: Shield,
};

/** One glyph per preview shape, so hats, masks, glasses and pets differ. */
const SHAPE_ICONS: Partial<Record<CosmeticPreviewShape, LucideIcon>> = {
  halo: CircleDashed,
  crown: Crown,
  beanie: HardHat,
  tophat: GraduationCap,
  mask: VenetianMask,
  glasses: Glasses,
  ears: Rabbit,
  pet: Dog,
  band: Ribbon,
  wrap: Ribbon,
  scarf: Shirt,
  backpack: Backpack,
  feather: Wind,
  crystal: Sparkles,
  round: Shield,
  kite: Shield,
};

function CosmeticArt({
  item,
  textureUrl,
}: {
  item: CosmeticItem;
  /** Baked in-game texture of this cosmetic, when the pack has one. */
  textureUrl?: string;
}) {
  const Icon =
    SHAPE_ICONS[cosmeticPreviewShape(item)] ?? CATEGORY_ICONS[item.category];
  const empty = item.id === "none";
  if (textureUrl) {
    return (
      <span className="cosmetic-art cosmetic-art--textured">
        <img
          className="cosmetic-art__texture"
          src={textureUrl}
          alt=""
          loading="lazy"
          draggable={false}
        />
      </span>
    );
  }
  return (
    <span
      className={[
        "cosmetic-art",
        `cosmetic-art--${item.category}`,
        empty ? "cosmetic-art--none" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        empty
          ? undefined
          : {
              background: `linear-gradient(150deg, ${item.primary}, ${item.secondary})`,
              borderColor: item.accent,
            }
      }
    >
      {item.category === "capes" && !empty ? (
        <>
          <span
            className="cosmetic-art__cape"
            style={{ borderColor: item.accent, background: item.primary }}
          />
          <span
            className="cosmetic-art__emblem"
            style={{ background: item.accent }}
          />
        </>
      ) : (
        <Icon size={22} style={{ color: empty ? "#64748b" : item.accent }} />
      )}
    </span>
  );
}

export function CosmeticsModal({
  initialCategory,
  onClose,
}: {
  initialCategory: CosmeticCategory;
  onClose: () => void;
}) {
  const { config, equipCosmetic, syncCosmeticsFromGame, cosmeticSyncing } = useLauncher();
  const [category, setCategory] = useState<CosmeticCategory>(initialCategory);
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(120);
  const [textureUrls, setTextureUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void loadCosmeticManifest().then((entries) => {
      if (cancelled) return;
      const urls: Record<string, string> = {};
      for (const [id, entry] of Object.entries(entries)) {
        urls[id] = cosmeticTextureUrl(entry);
      }
      // GIF capes live outside the catalogue pack; their tiles show the baked
      // first frame cropped to the cape face.
      for (const cape of ANIMATED_CAPES) {
        urls[cape.id] = animatedCapeThumbUrl(cape.module);
      }
      setTextureUrls(urls);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const allItems = cosmeticItems(category);
  const query = search.trim().toLowerCase();
  const items = useMemo(
    () => (query
      ? allItems.filter((item) =>
          `${item.name} ${item.type} ${item.id} ${item.description}`
            .toLowerCase()
            .includes(query),
        )
      : allItems),
    [allItems, query],
  );
  useEffect(() => setVisibleCount(120), [category, search]);
  const visibleItems = items.slice(0, visibleCount);
  const selectedId = selectedCosmeticId(config.profile, category);
  const categoryMeta = COSMETIC_CATEGORIES.find((entry) => entry.id === category);
  const ActiveIcon = CATEGORY_ICONS[category];

  const select = (item: CosmeticItem) => {
    void equipCosmetic(category, item.id);
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Cosmetics"
      subtitle={`${COSMETIC_COUNT} Cosmetics aus Minecraft – direkt aus dem Launcher equippen`}
      size="lg"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Schließen
        </Button>
      }
    >
      <div className="cosmetics-layout">
        <nav className="cosmetics-nav" aria-label="Cosmetic-Kategorien">
          {COSMETIC_CATEGORIES.map((entry) => {
            const Icon = CATEGORY_ICONS[entry.id];
            const count = cosmeticItems(entry.id).filter(
              (item) => item.id !== "none",
            ).length;
            return (
              <button
                key={entry.id}
                type="button"
                className={[
                  "cosmetics-nav__item",
                  category === entry.id ? "cosmetics-nav__item--active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => setCategory(entry.id)}
                aria-current={category === entry.id ? "page" : undefined}
              >
                <Icon size={15} />
                <span>{entry.label}</span>
                <em>{count}</em>
              </button>
            );
          })}
        </nav>

        <section className="cosmetics-main">
          <header className="cosmetics-main__head">
            <div>
              <h3>
                <ActiveIcon size={15} /> {categoryMeta?.label}
              </h3>
              <p>{categoryMeta?.hint}</p>
            </div>
            <span className="panel-hint">{items.length} Einträge</span>
          </header>

          <div className="cosmetics-toolbar">
            <label className="cosmetics-search">
              <Search size={14} />
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Cosmetic suchen (Name, Typ oder ID)"
                aria-label="Cosmetic suchen"
              />
            </label>
            <button
              type="button"
              className="cosmetics-sync"
              onClick={() => void syncCosmeticsFromGame(true)}
              disabled={cosmeticSyncing}
              title="Aus der Minecraft-Konfiguration laden"
            >
              <RefreshCw size={14} className={cosmeticSyncing ? "is-spinning" : ""} />
              Aus Spiel laden
            </button>
          </div>

          <div className="cosmetics-grid">
            {visibleItems.map((item) => {
              const active = item.id === selectedId;
              return (
                <button
                  key={item.id}
                  type="button"
                  className={[
                    "cosmetic-card",
                    active ? "cosmetic-card--active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  onClick={() => select(item)}
                  aria-pressed={active}
                >
                  <CosmeticArt item={item} textureUrl={textureUrls[item.id]} />
                  <span className="cosmetic-card__name">
                    {item.name}
                    {active ? <Check size={13} /> : null}
                  </span>
                  <span className="cosmetic-card__desc">{item.description}</span>
                  {active ? (
                    <span className="cosmetic-card__badge">
                      <Sparkles size={10} /> Aktiv
                    </span>
                  ) : null}
                </button>
              );
            })}
            {items.length === 0 ? (
              <p className="cosmetics-empty">Kein Cosmetic gefunden.</p>
            ) : null}
            {visibleItems.length < items.length ? (
              <button
                type="button"
                className="cosmetics-more"
                onClick={() => setVisibleCount((count) => count + 240)}
              >
                Mehr anzeigen ({visibleItems.length} von {items.length})
              </button>
            ) : null}
          </div>
        </section>
      </div>
    </Modal>
  );
}
