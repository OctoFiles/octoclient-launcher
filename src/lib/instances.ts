/**
 * Instance helpers.
 *
 * An instance is a saved Minecraft version + mod-profile pair. The active
 * instance is mirrored into `config.profile` so the existing launch command and
 * older configs keep working — every mutation here goes through `withInstances`.
 */

import type { Instance, LauncherConfig } from "./types";

const FALLBACK_INSTANCE: Instance = {
  id: "default",
  name: "Vanilla 1.21.10",
  version: "1.21.10",
  modProfile: "vanilla",
  favorite: true,
  directory: null,
};

export type InstanceDraft = Pick<Instance, "name" | "version" | "modProfile">;

/** Instances of a config, with a safe fallback for configs written before v2. */
export function listInstances(config: LauncherConfig): Instance[] {
  return config.instances?.length ? config.instances : [{ ...FALLBACK_INSTANCE }];
}

export function activeInstance(config: LauncherConfig): Instance {
  const instances = listInstances(config);
  return (
    instances.find((entry) => entry.id === config.activeInstanceId) ?? instances[0]
  );
}

/** Instances offered in the Play screen switcher, in saved order. */
export function favoriteInstances(config: LauncherConfig): Instance[] {
  return listInstances(config).filter((entry) => entry.favorite);
}

/** Applies the instance list and mirrors the active one into `profile`. */
function withInstances(
  config: LauncherConfig,
  instances: Instance[],
  activeId: string,
): LauncherConfig {
  const active = instances.find((entry) => entry.id === activeId) ?? instances[0];
  return {
    ...config,
    instances,
    activeInstanceId: active.id,
    profile: {
      ...config.profile,
      version: active.version,
      modProfile: active.modProfile,
    },
  };
}

export function activateInstance(config: LauncherConfig, id: string): LauncherConfig {
  return withInstances(config, listInstances(config), id);
}

/** Creates an instance and makes it the active one. */
export function createInstance(config: LauncherConfig, draft: InstanceDraft): LauncherConfig {
  const instance: Instance = {
    id: newInstanceId(),
    name: draft.name.trim() || "Neue Instanz",
    version: draft.version,
    modProfile: draft.modProfile,
    favorite: true,
    directory: null,
  };
  return withInstances(
    config,
    [...listInstances(config), instance],
    instance.id,
  );
}

export function updateInstance(
  config: LauncherConfig,
  id: string,
  patch: Partial<InstanceDraft>,
): LauncherConfig {
  const instances = listInstances(config).map((entry) =>
    entry.id === id ? { ...entry, ...patch } : entry,
  );
  return withInstances(config, instances, config.activeInstanceId);
}

export function removeInstance(config: LauncherConfig, id: string): LauncherConfig {
  const instances = listInstances(config);
  if (instances.length <= 1) return config;
  const remaining = instances.filter((entry) => entry.id !== id);
  const activeId =
    config.activeInstanceId === id ? remaining[0].id : config.activeInstanceId;
  return withInstances(config, remaining, activeId);
}

/** The active instance always stays a favourite so PLAY is reachable. */
export function toggleInstanceFavorite(
  config: LauncherConfig,
  id: string,
): LauncherConfig {
  if (activeInstance(config).id === id) return config;
  return {
    ...config,
    instances: listInstances(config).map((entry) =>
      entry.id === id ? { ...entry, favorite: !entry.favorite } : entry,
    ),
  };
}

export function nextInstanceName(config: LauncherConfig): string {
  const instances = listInstances(config);
  const names = new Set(instances.map((entry) => entry.name));
  let index = instances.length + 1;
  while (names.has(`Instanz ${index}`)) index += 1;
  return `Instanz ${index}`;
}

function newInstanceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `instance-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
