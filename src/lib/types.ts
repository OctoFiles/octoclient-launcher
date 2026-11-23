/**
 * IPC contract.
 *
 * These types mirror the `#[serde(rename_all = "camelCase")]` structs in
 * `src-tauri/src/*`. Keep both sides in sync when extending the launcher.
 */

export type PerformanceMode = "high" | "balanced" | "low";
export type SkinModel = "classic" | "slim";
export type BackgroundMode = "stars" | "aurora" | "solid" | "image";
export type FontId = "standard" | "bahnschrift" | "georgia" | "mono" | "pixel";

export interface ProfileSelection {
  version: string;
  modProfile: string;
  skinId: string;
  /** Arm width model: classic (4 px) or slim (3 px). */
  skinModel: SkinModel;
  capeId: string;
  /** Preview slots; `none` disables the slot. The game uses `cosmeticSelection`. */
  accessoryId: string;
  headId: string;
  bandanaId: string;
  wingId: string;
  shieldId: string;
  /** Equipped catalog cosmetics as `TYPE:id` keys, one per Minecraft type. */
  cosmeticSelection: string[];
  /** Custom skin PNG as data URL; wins over the Microsoft account skin. */
  customSkinDataUrl: string | null;
  /** Every skin loaded from a file, name or UUID, newest first. */
  customSkins: CustomSkin[];
}

/** One remembered skin in the launcher's skin history. */
export interface CustomSkin {
  id: string;
  name: string;
  dataUrl: string;
  model: SkinModel;
  addedAt: string;
}

export interface Instance {
  id: string;
  name: string;
  version: string;
  /** Loader: `vanilla`, `fabric` or `forge`. */
  modProfile: string;
  /** Favourites appear in the Play screen's instance switcher. */
  favorite: boolean;
  /** Custom game directory; empty = per-instance folder. */
  directory: string | null;
}

export interface JavaSettings {
  path: string | null;
  minRamMb: number;
  maxRamMb: number;
  extraJvmArgs: string;
}

export interface GameSettings {
  directory: string | null;
  width: number;
  height: number;
  fullscreen: boolean;
}

export interface LaunchSettings {
  closeLauncher: boolean;
  keepOpenOnError: boolean;
  showConsole: boolean;
  autoUpdate: boolean;
}

export interface DiscordSettings {
  enabled: boolean;
  showServer: boolean;
  /** Discord application id that owns the Rich Presence assets. */
  appId: string | null;
}

export interface AppearanceSettings {
  performance: PerformanceMode;
  reduceMotion: boolean;
  showParticles: boolean;
  accent: string;
  /** Global corner radius in px; 0 = square, 28 = very round. */
  cornerRadius: number;
  /** Base colour behind the glass panels. */
  backgroundColor: string;
  backgroundMode: BackgroundMode;
  /** Locally stored background image as a data URL. */
  backgroundImage: string | null;
  /** Colour wash applied to every card/tile. */
  tileTint: string;
  /** Tile opacity, 0–100; 0 hides the tile background completely. */
  tileOpacity: number;
  /** Global text colour for titles, labels, hints, values and inputs. */
  textColor: string;
  /** Font preset for the whole UI; see `lib/fonts.ts`. */
  fontFamily: FontId;
}

export interface SystemSettings {
  startMinimized: boolean;
  alwaysOnTop: boolean;
}

export interface IntegrationSettings {
  /** Azure public client id for Microsoft OAuth (optional). */
  msClientId: string | null;
  /** Remote news feed URL (optional placeholder). */
  newsFeedUrl: string | null;
}

export interface LauncherConfig {
  version: number;
  profile: ProfileSelection;
  instances: Instance[];
  activeInstanceId: string;
  java: JavaSettings;
  game: GameSettings;
  launch: LaunchSettings;
  discord: DiscordSettings;
  appearance: AppearanceSettings;
  system: SystemSettings;
  integrations: IntegrationSettings;
}

export interface Account {
  username: string;
  uuid: string;
  skinDataUrl: string | null;
  signedInAt: string;
  expiresAt: number;
}

export type PendingStatus = "pending" | "complete" | "expired" | "error";

export interface PendingLogin {
  userCode: string;
  verificationUri: string;
  message: string;
  expiresAt: number;
  intervalSecs: number;
  status: PendingStatus;
  error: string | null;
}

export interface AuthSnapshot {
  account: Account | null;
  pending: PendingLogin | null;
  /** All saved Microsoft accounts; switching does not require a new login. */
  accounts: Account[];
}

export type NewsCategory = "patch" | "update" | "info";

export interface NewsItem {
  id: string;
  title: string;
  category: NewsCategory;
  version: string;
  date: string;
  summary: string;
  body: string[];
  tags: string[];
  url?: string | null;
}

export interface NewsFeed {
  source: "remote" | "unavailable";
  items: NewsItem[];
  message: string | null;
}

export interface JavaInfo {
  path: string;
  version: string | null;
  vendor: string | null;
  source: string;
}

export interface InstalledVersion {
  id: string;
  type: string;
  released: string | null;
}

export interface SystemInfo {
  os: string;
  arch: string;
  appVersion: string;
  totalMemoryMb: number;
  configDir: string;
  dataDir: string;
  configFile: string;
  defaultGameDir: string;
  gameDir: string;
  java: JavaInfo | null;
  installedVersions: InstalledVersion[];
}

export interface LaunchResult {
  version: string;
  java: string;
  args: string[];
  note: string;
  pid: number;
}

export interface LaunchPlan {
  version: string;
  mainClass: string;
  java: string;
  args: string[];
  note: string;
}

/** One entry of Mojang's live version manifest. */
export interface GameVersion {
  id: string;
  /** `release`, `snapshot`, `old_beta`, `old_alpha` */
  kind: string;
  released: string;
}

export interface VersionCatalog {
  latestRelease: string;
  latestSnapshot: string;
  fetchedAt: number;
  /** `live` (fetched now) or `cache` (served from disk). */
  source: string;
  versions: GameVersion[];
}

export interface ModrinthHit {
  projectId: string;
  slug: string;
  title: string;
  description: string;
  iconUrl: string | null;
  downloads: number;
  projectType: string;
  categories: string[];
}

export interface ModrinthSearch {
  hits: ModrinthHit[];
  total: number;
  offset: number;
}

export interface ContentEntry {
  /** Path relative to the instance directory, using `/`. */
  path: string;
  /** `mod`, `resourcepack` or `shader`. */
  kind: string;
  projectId: string | null;
  title: string;
  iconUrl: string | null;
  versionNumber: string | null;
  size: number;
}

export interface InstalledPack {
  projectId: string;
  title: string;
  iconUrl: string | null;
  versionNumber: string;
  installedAt: string;
  loader: string | null;
  gameVersion: string | null;
  files: string[];
}

export interface ContentSnapshot {
  directory: string;
  entries: ContentEntry[];
  packs: InstalledPack[];
}

export interface InstanceInfo {
  id: string;
  name: string;
  version: string;
  loader: string;
  directory: string;
  installedVersions: string[];
  mods: number;
  resourcepacks: number;
  shaderpacks: number;
  packs: number;
}

export interface ModpackResult {
  config: LauncherConfig;
  snapshot: ContentSnapshot;
  pack: InstalledPack;
}

/** Result of a file drop onto the instance window. */
export interface InstanceImportOutcome {
  imported: number;
  skipped: string[];
  snapshot: ContentSnapshot;
}

/** A skin resolved from a Minecraft name or UUID. */
export interface ResolvedSkin {
  name: string;
  uuid: string;
  skinDataUrl: string;
  model: string;
  source: string;
}

/** Progress event emitted while the launcher installs game files or Java. */
export interface InstallProgress {
  version: string;
  /** `version`, `libraries`, `assets`, `runtime` or `done`. */
  stage: string;
  current: number;
  total: number;
}

export type PageId = "play" | "friends" | "instances" | "news" | "skins" | "settings";
