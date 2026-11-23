/**
 * Real cosmetic assets (models + textures) exported from the mod.
 *
 * `scripts/build-cosmetic-assets.py` bakes the in-game OBJ/MD5 meshes into the
 * compact binaries under `public/cosmetics/mesh` and re-encodes their
 * textures as WebP. This module loads them lazily and caches the results, so
 * the preview can show exactly what Minecraft renders instead of stand-in
 * shapes.
 */

import * as THREE from "three";

export interface CosmeticAssetEntry {
  /** Texture file name inside `public/cosmetics/tex`. */
  t: string;
  /** Mesh file name inside `public/cosmetics/mesh`, if the item has one. */
  m: string | null;
  scale: number;
  x: number;
  y: number;
  z: number;
  flipUVs: boolean;
  /** In-game cosmetic type (HAT, WINGS, CAPE, ...). */
  type: string;
  /** First model path, used for the few hand-tuned special cases. */
  path: string | null;
}

interface RawEntry {
  t: string;
  m: string | null;
  s: number;
  x: number;
  y: number;
  z: number;
  f: boolean;
  d: string;
  p: string | null;
}

export interface CosmeticMesh {
  geometry: THREE.BufferGeometry;
  maxY: number;
  width: number;
  height: number;
}

export interface CosmeticAsset extends CosmeticMesh {
  entry: CosmeticAssetEntry;
  texture: THREE.Texture;
}

const ROOT = "cosmetics/";
const MESH_MAGIC = 0x3143454f;

function assetUrl(path: string): string {
  return new URL(ROOT + path, document.baseURI).href;
}

const toEntry = (raw: RawEntry): CosmeticAssetEntry => ({
  t: raw.t,
  m: raw.m,
  scale: raw.s,
  x: raw.x,
  y: raw.y,
  z: raw.z,
  flipUVs: raw.f,
  type: raw.d,
  path: raw.p,
});

let manifestPromise: Promise<Record<string, CosmeticAssetEntry>> | null = null;

/** Loads the baked asset manifest once; empty when no pack was built. */
export function loadCosmeticManifest(): Promise<Record<string, CosmeticAssetEntry>> {
  manifestPromise ??= fetch(assetUrl("manifest.json"))
    .then((response) => (response.ok ? response.json() : { items: {} }))
    .then((data: { items?: Record<string, RawEntry> }) => {
      const entries: Record<string, CosmeticAssetEntry> = {};
      for (const [id, raw] of Object.entries(data.items ?? {})) entries[id] = toEntry(raw);
      return entries;
    })
    .catch(() => ({}));
  return manifestPromise;
}

export async function cosmeticEntry(id: string): Promise<CosmeticAssetEntry | null> {
  const items = await loadCosmeticManifest();
  return items[id] ?? null;
}

export function cosmeticTextureUrl(entry: CosmeticAssetEntry): string {
  return assetUrl(`tex/${entry.t}`);
}

const meshCache = new Map<string, Promise<CosmeticMesh>>();

function loadMesh(file: string): Promise<CosmeticMesh> {
  const cached = meshCache.get(file);
  if (cached) return cached;
  const promise = (async () => {
    const response = await fetch(assetUrl(`mesh/${file}`));
    if (!response.ok) throw new Error(`Cosmetic mesh ${file} fehlt`);
    const buffer = await response.arrayBuffer();
    const header = new DataView(buffer);
    if (buffer.byteLength < 16 || header.getUint32(0, true) !== MESH_MAGIC) {
      throw new Error(`Cosmetic mesh ${file} ist ungültig`);
    }
    const vertexCount = header.getUint32(8, true);
    const indexCount = header.getUint32(12, true);
    const positions = new Float32Array(buffer, 16, vertexCount * 3);
    const uvs = new Float32Array(buffer, 16 + vertexCount * 12, vertexCount * 2);
    const indices = new Uint32Array(buffer, 16 + vertexCount * 20, indexCount);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    return {
      geometry,
      maxY: bounds ? bounds.max.y : 0,
      width: bounds ? bounds.max.x - bounds.min.x : 1,
      height: bounds ? bounds.max.y - bounds.min.y : 1,
    };
  })();
  meshCache.set(file, promise);
  promise.catch(() => meshCache.delete(file));
  return promise;
}

const textureCache = new Map<string, Promise<THREE.Texture>>();

function loadTexture(file: string): Promise<THREE.Texture> {
  const cached = textureCache.get(file);
  if (cached) return cached;
  const promise = new THREE.TextureLoader()
    .loadAsync(assetUrl(`tex/${file}`))
    .then((texture) => {
      // Minecraft textures have their first row at v = 0.
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = 4;
      texture.needsUpdate = true;
      return texture;
    });
  textureCache.set(file, promise);
  promise.catch(() => textureCache.delete(file));
  return promise;
}

/**
 * Some packs paint their capes and wings on a flat green screen instead of
 * using alpha, which the game keys out while drawing. The baked WebP keeps that
 * background opaque, so the launcher has to do the same thing or cosmetics show
 * up framed in green (the cape of `CAPE:696` carries a wide green band, which is
 * why dots of it kept peeking out at the hem).
 *
 * Only the backdrop is removed: the key colour is flood filled in from the image
 * border, so artwork that happens to contain green survives, and the pixels
 * touching a removed one are cleaned up so WebP ringing cannot leave a green
 * fringe. Returns null when the texture already has transparency, has no clear
 * green backdrop, or nothing was keyed out.
 */
function keyOutGreenScreen(image: HTMLImageElement): HTMLCanvasElement | null {
  if (!image.width || !image.height) return null;
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(image, 0, 0);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;

  const counts = new Map<number, number>();
  let opaque = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < 250) continue;
    opaque += 1;
    const key = (data[index] << 16) | (data[index + 1] << 8) | data[index + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  // An alpha cut-out needs no keying.
  if (opaque < (data.length / 4) * 0.5) return null;
  let bestKey = -1;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      bestKey = key;
    }
  }
  // A backdrop can be a minority of the sheet (a cape that only pads its hem),
  // so the bar is low; the border flood fill below is what keeps artwork safe.
  if (bestKey < 0 || bestCount / opaque < 0.05) return null;

  const red = (bestKey >> 16) & 0xff;
  const green = (bestKey >> 8) & 0xff;
  const blue = bestKey & 0xff;
  // Only a real green screen: clearly green and bright enough to not be artwork.
  if (green < 60 || green - red < 25 || green - blue < 25) return null;

  const isKey = (index: number) => {
    const offset = index * 4;
    const dr = data[offset] - red;
    const dg = data[offset + 1] - green;
    const db = data[offset + 2] - blue;
    return dr * dr + dg * dg + db * db <= 40 * 40;
  };

  const width = canvas.width;
  const height = canvas.height;
  const removed = new Uint8Array(width * height);
  const stack: number[] = [];
  const seed = (index: number) => {
    if (index < 0 || index >= removed.length || removed[index]) return;
    if (!isKey(index)) return;
    removed[index] = 1;
    stack.push(index);
  };
  for (let x = 0; x < width; x += 1) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y += 1) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (stack.length > 0) {
    const index = stack.pop() as number;
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) seed(index - 1);
    if (x < width - 1) seed(index + 1);
    if (y > 0) seed(index - width);
    if (y < height - 1) seed(index + width);
  }

  // WebP ringing leaves half-green pixels along the keyed edge; clear the ones
  // that touch the backdrop so the art is not outlined in green.
  const before = Uint8Array.from(removed);
  const isFringe = (index: number) => {
    if (before[index]) return false;
    const offset = index * 4;
    if (data[offset + 3] < 8) return false;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    return g > 50 && g - r >= 10 && g - b >= 10;
  };
  let cleared = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (before[index]) {
        cleared += 1;
        continue;
      }
      if (!isFringe(index)) continue;
      const touchesBackdrop =
        (x > 0 && before[index - 1] === 1) ||
        (x < width - 1 && before[index + 1] === 1) ||
        (y > 0 && before[index - width] === 1) ||
        (y < height - 1 && before[index + width] === 1);
      if (touchesBackdrop) {
        removed[index] = 1;
        cleared += 1;
      }
    }
  }
  if (cleared === 0) return null;

  for (let index = 0; index < removed.length; index += 1) {
    if (removed[index]) data[index * 4 + 3] = 0;
  }
  context.putImageData(pixels, 0, 0);
  return canvas;
}

const preparedCache = new Map<string, Promise<THREE.Texture>>();

/**
 * Texture as the game shows it: nearest filtering without mipmaps so atlas
 * neighbours cannot bleed in, and green-screen backgrounds keyed out.
 */
function prepareTexture(file: string): Promise<THREE.Texture> {
  const cached = preparedCache.get(file);
  if (cached) return cached;
  const promise = loadTexture(file).then((texture) => {
    const image = texture.image as HTMLImageElement | undefined;
    const keyed = image ? keyOutGreenScreen(image) : null;
    if (!keyed) {
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
      return texture;
    }
    const canvasTexture = new THREE.CanvasTexture(keyed);
    canvasTexture.flipY = false;
    canvasTexture.colorSpace = THREE.SRGBColorSpace;
    canvasTexture.magFilter = THREE.NearestFilter;
    canvasTexture.minFilter = THREE.NearestFilter;
    canvasTexture.generateMipmaps = false;
    canvasTexture.wrapS = THREE.ClampToEdgeWrapping;
    canvasTexture.wrapT = THREE.ClampToEdgeWrapping;
    canvasTexture.needsUpdate = true;
    return canvasTexture;
  });
  preparedCache.set(file, promise);
  promise.catch(() => preparedCache.delete(file));
  return promise;
}

const assetCache = new Map<string, Promise<CosmeticAsset | null>>();

/** Full asset (mesh + texture) for a catalogue id, or null for built-ins. */
export function loadCosmeticAsset(id: string): Promise<CosmeticAsset | null> {
  const cached = assetCache.get(id);
  if (cached) return cached;
  const promise = (async () => {
    const entry = await cosmeticEntry(id);
    if (!entry) return null;
    const texture = await prepareTexture(entry.t);
    const mesh = entry.m ? await loadMesh(entry.m).catch(() => null) : null;
    if (!mesh) {
      return {
        entry,
        texture,
        geometry: new THREE.BufferGeometry(),
        maxY: 0,
        width: 1,
        height: 1,
      };
    }
    return { entry, texture, ...mesh };
  })();
  assetCache.set(id, promise);
  promise.catch(() => assetCache.delete(id));
  return promise;
}

/**
 * Cape texture for the cloth plane.
 *
 * The packs export each cape as its own canvas (the artwork fills the whole
 * image), so the texture maps 1:1 onto the 10×16 plane. Cropping a "left half"
 * only exists in vanilla atlases and cut these designs in half; the caller
 * mirrors the texture for the cloth's back side.
 */
export async function loadCapeTexture(
  id: string,
): Promise<{ texture: THREE.Texture; aspect: number } | null> {
  const entry = await cosmeticEntry(id);
  if (!entry) return null;
  const base = await prepareTexture(entry.t);
  const image = base.image as { width?: number; height?: number } | undefined;
  const width = image?.width ?? 1;
  const height = image?.height ?? 1;
  // Never mutate the shared cache entry: the preview sets repeat/offset on it.
  const texture = base.clone();
  texture.needsUpdate = true;
  return { texture, aspect: width / Math.max(1, height) };
}
