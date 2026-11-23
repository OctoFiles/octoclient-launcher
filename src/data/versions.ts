import type { GameVersion } from "../lib/types";

/** Bundled Minecraft versions shown before the live catalog responds. */
export interface MinecraftVersion {
  id: string;
  label: string;
  type: "release" | "snapshot";
  released: string;
  note?: string;
  recommended?: boolean;
}

export const MINECRAFT_VERSIONS: MinecraftVersion[] = [
  {
    id: "1.21.10",
    label: "1.21.10",
    type: "release",
    released: "2026-09-30",
    note: "Aktuellste Version · empfohlen",
    recommended: true,
  },
  {
    id: "1.21.8",
    label: "1.21.8",
    type: "release",
    released: "2026-07-15",
    note: "Stabil für Modpacks",
  },
  {
    id: "1.21.5",
    label: "1.21.5",
    type: "release",
    released: "2026-03-25",
    note: "Beliebt auf Survival-Servern",
  },
  {
    id: "1.21.4",
    label: "1.21.4",
    type: "release",
    released: "2025-12-03",
  },
  {
    id: "1.20.6",
    label: "1.20.6",
    type: "release",
    released: "2025-04-29",
  },
  {
    id: "1.8.9",
    label: "1.8.9",
    type: "release",
    released: "2015-12-09",
    note: "PvP-Klassiker",
  },
];

export interface ModLoader {
  id: "vanilla" | "fabric" | "forge";
  name: string;
  description: string;
}

/** Only these three loaders exist in the config (`modProfile`). */
export const MOD_LOADERS: ModLoader[] = [
  {
    id: "vanilla",
    name: "Vanilla",
    description: "Unverändertes Minecraft – ohne Mods",
  },
  {
    id: "fabric",
    name: "Fabric",
    description: "Leichtgewichtig, ideal für Mods und Performance",
  },
  {
    id: "forge",
    name: "Forge",
    description: "Klassisch für große Modpacks und Forge-Mods",
  },
];

export function findLoader(id: string): ModLoader {
  return MOD_LOADERS.find((loader) => loader.id === id) ?? MOD_LOADERS[0];
}

/** Fallback list before the live Mojang catalog has loaded. */
export const BUNDLED_GAME_VERSIONS: GameVersion[] = MINECRAFT_VERSIONS.map((version) => ({
  id: version.id,
  kind: version.type,
  released: version.released,
}));

export function findVersion(id: string): MinecraftVersion | undefined {
  return MINECRAFT_VERSIONS.find((version) => version.id === id);
}
