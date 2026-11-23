/**
 * Cosmetic catalogue shared with the game.
 *
 * The entries are generated from the mod's bundled `catalog.json` and its
 * hand-written cosmetic modules by `tools/generate-launcher-cosmetics.mjs`.
 * Catalog ids are the mod's own `TYPE:id` keys; built-in modules use
 * `BUILTIN:<group>:<module name>`. "none" is not a cosmetic; it only clears a
 * preview slot.
 */

import generated from "../../../data/generated-cosmetics.json";
import type { ProfileSelection } from "../../../lib/types";
import { ANIMATED_CAPES } from "./animatedCapes";

export type CosmeticCategory =
  | "capes"
  | "accessories"
  | "heads"
  | "bandanas"
  | "wings"
  | "shields";

export type CosmeticStyle =
  | "none"
  | "backpack"
  | "scarf"
  | "tophat"
  | "crown"
  | "beanie"
  | "halo"
  | "band"
  | "wrap"
  | "feather"
  | "crystal"
  | "round"
  | "kite";

/** Shape used by the 3D preview. Extends the stored style with shapes the
 *  generated catalog data does not distinguish (masks, glasses, ears, pets). */
export type CosmeticPreviewShape =
  | CosmeticStyle
  | "mask"
  | "glasses"
  | "ears"
  | "pet";

export interface CosmeticItem {
  id: string;
  category: CosmeticCategory;
  type: string;
  /** Game-side mutual-exclusion group (catalog type or built-in cosmetic class). */
  group: string;
  /** `animated` capes are the mod's GIF modules, drawn from a baked frame strip. */
  kind: "catalog" | "builtin" | "animated";
  moduleName: string;
  name: string;
  description: string;
  primary: string;
  secondary: string;
  accent: string;
  style: CosmeticStyle;
}

export const COSMETIC_CATEGORIES: Array<{
  id: CosmeticCategory;
  label: string;
  hint: string;
}> = [
  { id: "capes", label: "Capes", hint: "Am Rücken" },
  { id: "accessories", label: "Accessories", hint: "Rucksäcke, Pets, Effekte & mehr" },
  { id: "heads", label: "Heads", hint: "Hüte, Masken & Gesicht" },
  { id: "bandanas", label: "Bandanas", hint: "Stirnbänder" },
  { id: "wings", label: "Wings", hint: "Flügel" },
  { id: "shields", label: "Schilde", hint: "Am Arm" },
];

const slotOf = (value: string): CosmeticCategory =>
  COSMETIC_CATEGORIES.find((category) => category.id === value)?.id ?? "accessories";

// Built-in module cosmetics (`BUILTIN:…`) are drawn procedurally by the mod and
// have neither a catalogue mesh nor a texture, so the launcher could only show
// a placeholder for them. They are left out instead of looking broken.
// The GIF capes are hand-written mod modules without a catalogue entry, so the
// generated data never contained them and the preview used to have no animated
// cape at all. Their frames come from `build-animated-capes.py`.
const ANIMATED_ITEMS: CosmeticItem[] = ANIMATED_CAPES.map((cape) => ({
  id: cape.id,
  category: "capes",
  type: "CAPE",
  group: "CAPE",
  kind: "animated",
  moduleName: cape.module,
  name: cape.module,
  description: "Animiertes Cape",
  primary: cape.primary,
  secondary: cape.secondary,
  accent: cape.accent,
  style: "kite",
}));

const ALL_ITEMS: CosmeticItem[] = generated.items
  .filter((item) => item.kind !== "builtin")
  .map((item) => ({
  id: item.id,
  category: slotOf(item.slot),
  type: item.type,
  group: item.group,
  kind: item.kind as CosmeticItem["kind"],
  moduleName: item.moduleName,
  name: item.name,
  description: item.description,
  primary: item.primary,
  secondary: item.secondary,
  accent: item.accent,
  style: item.style as CosmeticStyle,
}))
  .concat(ANIMATED_ITEMS);

const none = (category: CosmeticCategory): CosmeticItem => ({
  id: "none",
  category,
  type: "NONE",
  group: "NONE",
  kind: "catalog",
  moduleName: "",
  name: "Keine",
  description: "Slot bleibt leer",
  primary: "#475569",
  secondary: "#1e293b",
  accent: "#94a3b8",
  style: "none",
});

const CATALOGUE: Record<CosmeticCategory, CosmeticItem[]> = {
  // The animated capes sit right after the empty slot so they are not buried
  // under the 1456 catalogue entries.
  capes: [
    none("capes"),
    ...ANIMATED_ITEMS,
    ...ALL_ITEMS.filter((item) => item.category === "capes" && item.kind !== "animated"),
  ],
  accessories: [none("accessories"), ...ALL_ITEMS.filter((item) => item.category === "accessories")],
  heads: [none("heads"), ...ALL_ITEMS.filter((item) => item.category === "heads")],
  bandanas: [none("bandanas"), ...ALL_ITEMS.filter((item) => item.category === "bandanas")],
  wings: [none("wings"), ...ALL_ITEMS.filter((item) => item.category === "wings")],
  shields: [none("shields"), ...ALL_ITEMS.filter((item) => item.category === "shields")],
};

/** Every catalogue id, used to migrate old launcher-only selections. */
export const COSMETIC_IDS = new Set(ALL_ITEMS.map((item) => item.id));
/** Launcher id -> the exact module name stored in the game's config. */
export const COSMETIC_MODULE_NAMES = new Map(
  ALL_ITEMS.map((item) => [item.id, item.moduleName]),
);
/**
 * Inverse map for cosmetics equipped inside Minecraft. The mod has one name
 * collision (`Halo` is both a module and a legacy aura shape); the hand-written
 * module is registered first and wins here, matching `ModuleManager.byName`.
 */
export const COSMETIC_IDS_BY_MODULE = new Map<string, string>();
for (const item of ALL_ITEMS) {
  const previous = COSMETIC_IDS_BY_MODULE.get(item.moduleName);
  if (!previous) {
    COSMETIC_IDS_BY_MODULE.set(item.moduleName, item.id);
    continue;
  }
  // ModuleManager registers the stand-alone Halo before the legacy Aura shape
  // named "Halo", so byName("Halo") resolves to the stand-alone module too.
  if (item.moduleName === "Halo" && item.group === "HALO") {
    COSMETIC_IDS_BY_MODULE.set(item.moduleName, item.id);
  }
}
/** Number of real cosmetics (excluding the six empty slots). */
export const COSMETIC_COUNT = ALL_ITEMS.length;

export function cosmeticItems(category: CosmeticCategory): CosmeticItem[] {
  return CATALOGUE[category];
}

export function getCosmeticItem(
  category: CosmeticCategory,
  id: string,
): CosmeticItem {
  const items = CATALOGUE[category];
  return items.find((item) => item.id === id) ?? items[0];
}

export function cosmeticItemById(id: string): CosmeticItem | undefined {
  return ALL_ITEMS.find((item) => item.id === id);
}

/**
 * Preview shape for an item, derived from its type and name.
 *
 * The bundled catalog styles are unreliable for a few families ("Angel Halo"
 * is stored as a beanie, bunny ears as a top hat), so name/type rules win.
 */
export function cosmeticPreviewShape(item: CosmeticItem): CosmeticPreviewShape {
  if (item.category === "capes") return item.style;
  const name = item.name.toLowerCase();
  if (name.includes("halo") || item.type === "CUSTOM_HALO") return "halo";
  if (name.includes("crown") || name.includes("tiara")) return "crown";
  if (
    item.type === "EARS" ||
    name.includes("ears") ||
    name.includes("antler") ||
    name.includes("horns")
  ) {
    return "ears";
  }
  if (item.type === "EYES" || /glass|goggle|scouter|visor|monocle/.test(name)) {
    return "glasses";
  }
  if (
    item.type === "MASK" ||
    item.type === "MOUTH" ||
    item.type === "NOSE" ||
    name.includes("mask") ||
    name.includes("muzzle")
  ) {
    return "mask";
  }
  if (
    (item.type === "PET" || item.type === "PLAYER_PET") &&
    /pet|plush|capy|cat|dog|bird|frog/.test(name)
  ) {
    return "pet";
  }
  return item.style;
}

/**
 * Drops launcher-only cosmetics from an older config and rebuilds the preview
 * slots from the equipped catalog/built-in items. "none" stays a valid slot.
 */
export function normalizeCosmeticProfile(profile: ProfileSelection): ProfileSelection {
  const seenGroups = new Set<string>();
  const cosmeticSelection = profile.cosmeticSelection.filter((id) => {
    const item = cosmeticItemById(id);
    if (!item || seenGroups.has(item.group)) return false;
    seenGroups.add(item.group);
    return true;
  });
  const preview = { ...profile, cosmeticSelection };
  for (const category of COSMETIC_CATEGORIES) {
    const field = COSMETIC_FIELD[category.id];
    const current = profile[field];
    if (current === "none" && !cosmeticSelection.some((id) => cosmeticItemById(id)?.category === category.id)) {
      continue;
    }
    // Keep the slot the user picked most recently. Several types share one
    // preview slot (a hat and glasses are both "heads"), so always taking the
    // first match would jump back to the older cosmetic.
    const currentItem = cosmeticItemById(current);
    if (currentItem && currentItem.category === category.id && cosmeticSelection.includes(current)) {
      preview[field] = current;
      continue;
    }
    const valid = cosmeticSelection.find((id) => cosmeticItemById(id)?.category === category.id);
    preview[field] = valid ?? "none";
  }
  // A slot can be equipped without its id reaching `cosmeticSelection` (an id
  // that was unknown when it was picked, an older config, a hand-edited
  // profile). The equipped slot is what the user sees, and it is also what the
  // game has to receive: without this the loadout file omitted the cape, so
  // Minecraft kept wearing the previously synced one.
  for (const category of COSMETIC_CATEGORIES) {
    const id = preview[COSMETIC_FIELD[category.id]];
    const item = id && id !== "none" ? cosmeticItemById(id) : undefined;
    if (!item) continue;
    if (cosmeticSelection.some((entry) => cosmeticItemById(entry)?.group === item.group)) continue;
    cosmeticSelection.push(item.id);
  }
  return { ...preview, cosmeticSelection };
}

export const COSMETIC_FIELD = {
  capes: "capeId",
  accessories: "accessoryId",
  heads: "headId",
  bandanas: "bandanaId",
  wings: "wingId",
  shields: "shieldId",
} as const;

export function selectedCosmeticId(
  profile: ProfileSelection,
  category: CosmeticCategory,
): string {
  return profile[COSMETIC_FIELD[category]];
}

/**
 * The launcher keeps one visible id per preview slot; the full selection
 * (one item per Minecraft cosmetic type) lives in `profile.cosmeticSelection`.
 * Both are updated together when a cosmetic is equipped.
 */
export function profilePatchForCosmetic(
  profile: ProfileSelection,
  category: CosmeticCategory,
  id: string,
): Partial<ProfileSelection> {
  const patch: Partial<ProfileSelection> = { [COSMETIC_FIELD[category]]: id };
  const selected = id === "none" ? undefined : cosmeticItemById(id);
  const removedGroups = new Set(
    selected
      ? [selected.group]
      : ALL_ITEMS.filter((item) => item.category === category).map((item) => item.group),
  );
  const selection = profile.cosmeticSelection.filter((entry) => {
    const item = cosmeticItemById(entry);
    return item ? !removedGroups.has(item.group) : false;
  });
  if (selected) selection.push(selected.id);
  return { ...patch, cosmeticSelection: selection };
}
