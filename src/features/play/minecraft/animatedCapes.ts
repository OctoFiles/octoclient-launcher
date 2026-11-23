/**
 * Animated capes.
 *
 * Five capes are hand-written mod modules (`new Cape(name, "….gif")`) instead of
 * catalogue entries, so the compact pack from `build-cosmetic-assets.py` has no
 * entry for them. `scripts/build-animated-capes.py` bakes each GIF into one
 * vertical WebP frame strip plus a manifest, and this module loads those strips
 * and plays them on the launcher's cape cloth exactly like the game's
 * `AnimatedCapeTextures` does.
 */

import * as THREE from "three";

export interface AnimatedCapeDefinition {
  /** Exact mod module name, which is also what the game stores in its config. */
  module: string;
  /** Launcher id, following the `BUILTIN:<group>:<module>` convention. */
  id: string;
  primary: string;
  secondary: string;
  accent: string;
}

export const ANIMATED_CAPES: AnimatedCapeDefinition[] = [
  { module: "Cloud", id: "BUILTIN:CAPE:Cloud", primary: "#4a86c8", secondary: "#cfe6ff", accent: "#eaf6ff" },
  { module: "Galaxy", id: "BUILTIN:CAPE:Galaxy", primary: "#7a2c4a", secondary: "#180a1e", accent: "#f4c2d0" },
  { module: "Shadow", id: "BUILTIN:CAPE:Shadow", primary: "#0a0a0c", secondary: "#1c1c22", accent: "#5b5b6b" },
  { module: "Lightning", id: "BUILTIN:CAPE:Lightning", primary: "#101014", secondary: "#2a2a33", accent: "#e8edf5" },
  { module: "Orbit", id: "BUILTIN:CAPE:Orbit", primary: "#0d1117", secondary: "#1b2330", accent: "#dfe8ff" },
];

/**
 * The outer face of an animated cape, matching `Cape.STANDARD_TEXTURE_*` in the
 * mod; the rest of the GIF is the render sheet around it.
 */
export const ANIMATED_CAPE_UV = { u0: 0.06, v0: 0.08, u1: 0.49, v1: 0.96 };

interface RawAnimatedCape {
  frames: number;
  delayMs: number;
  file: string;
  thumb: string;
  width: number;
  height: number;
}

export interface AnimatedCapeTexture {
  texture: THREE.Texture;
  frames: number;
  delayMs: number;
}

const ROOT = "cosmetics/capes-anim/";

function assetUrl(path: string): string {
  return new URL(ROOT + path, document.baseURI).href;
}

/** Baked first frame for the cosmetics grid, cropped to the cape face. */
export function animatedCapeThumbUrl(module: string): string {
  return assetUrl(`${module.toLowerCase()}-thumb.webp`);
}

let manifestPromise: Promise<Record<string, RawAnimatedCape>> | null = null;

function loadManifest(): Promise<Record<string, RawAnimatedCape>> {
  manifestPromise ??= fetch(assetUrl("manifest.json"))
    .then((response) =>
      response.ok ? (response.json() as Promise<Record<string, RawAnimatedCape>>) : {},
    )
    .catch(() => ({}));
  return manifestPromise;
}

const textureCache = new Map<string, Promise<AnimatedCapeTexture | null>>();

export function loadAnimatedCape(module: string): Promise<AnimatedCapeTexture | null> {
  const cached = textureCache.get(module);
  if (cached) return cached;
  const promise = (async () => {
    const manifest = await loadManifest();
    const entry = manifest[module];
    if (!entry) return null;
    const texture = await new THREE.TextureLoader().loadAsync(assetUrl(entry.file));
    // Minecraft textures have their first row at v = 0.
    texture.flipY = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    // The strips are scaled up from small GIF frames, so smooth sampling reads
    // better than nearest here (unlike the pixel-art catalogue textures).
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return {
      texture,
      frames: Math.max(1, entry.frames),
      delayMs: Math.max(20, entry.delayMs),
    };
  })();
  textureCache.set(module, promise);
  void promise.then((value) => {
    if (!value) textureCache.delete(module);
  });
  return promise;
}
