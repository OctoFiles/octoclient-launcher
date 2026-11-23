/**
 * Local cosmetic skins, painted procedurally into a 64×64 Minecraft skin.
 *
 * Add a skin by appending a `SkinDefinition` — the painter handles all UV
 * regions through `PART_LAYOUT`, and the Play/Skins views pick it up
 * automatically.
 */

import { PART_LAYOUT, SKIN_TEXTURE_SIZE, SLIM_ARM_LAYOUT, type SkinRect } from "./skinLayout";
import { shade } from "./color";

export interface SkinPalette {
  skin: string;
  skinShade: string;
  hair: string;
  hairLight: string;
  eyes: string;
  shirt: string;
  shirtShade: string;
  accent: string;
  pants: string;
  shoes: string;
}

export interface SkinDefinition {
  id: string;
  name: string;
  tagline: string;
  /** Head overlay style (second skin layer). */
  hat: "headband" | "hood" | "none";
  palette: SkinPalette;
}

export const SKINS: SkinDefinition[] = [
  {
    id: "frost",
    name: "Frost",
    tagline: "Eisblau · Standard",
    hat: "headband",
    palette: {
      skin: "#e8b892",
      skinShade: "#c69473",
      hair: "#e8f6ff",
      hairLight: "#ffffff",
      eyes: "#1f7a8c",
      shirt: "#101b2b",
      shirtShade: "#0a1220",
      accent: "#6ee7f9",
      pants: "#1b2740",
      shoes: "#0b111c",
    },
  },
  {
    id: "glacier",
    name: "Glacier",
    tagline: "Tiefes Blau · Hoodie",
    hat: "hood",
    palette: {
      skin: "#d9a684",
      skinShade: "#b98565",
      hair: "#4f8fd6",
      hairLight: "#79b4ea",
      eyes: "#2f5f8f",
      shirt: "#2b5c8f",
      shirtShade: "#1d3f63",
      accent: "#bfe3ff",
      pants: "#1a2c44",
      shoes: "#0d1622",
    },
  },
  {
    id: "onyx",
    name: "Onyx",
    tagline: "Schwarz · Violett",
    hat: "hood",
    palette: {
      skin: "#c98f6a",
      skinShade: "#a06f50",
      hair: "#15161c",
      hairLight: "#2a2c38",
      eyes: "#8b7cf6",
      shirt: "#161821",
      shirtShade: "#0c0d13",
      accent: "#a78bfa",
      pants: "#101118",
      shoes: "#07080c",
    },
  },
  {
    id: "ember",
    name: "Ember",
    tagline: "Rot · Kupfer",
    hat: "headband",
    palette: {
      skin: "#f0c19c",
      skinShade: "#c99672",
      hair: "#b4452f",
      hairLight: "#d96a4a",
      eyes: "#7a3a1f",
      shirt: "#2a1714",
      shirtShade: "#1a0e0c",
      accent: "#fb923c",
      pants: "#241512",
      shoes: "#120a09",
    },
  },
  {
    id: "aurora",
    name: "Aurora",
    tagline: "Türkis · Magenta",
    hat: "none",
    palette: {
      skin: "#e5b48f",
      skinShade: "#bd8b68",
      hair: "#2fc4b2",
      hairLight: "#7ff0e0",
      eyes: "#1d6f7a",
      shirt: "#20203a",
      shirtShade: "#141426",
      accent: "#e879f9",
      pants: "#1a1a2e",
      shoes: "#0c0c16",
    },
  },
];

export function getSkin(id: string): SkinDefinition {
  return SKINS.find((skin) => skin.id === id) ?? SKINS[0];
}

function fill(ctx: CanvasRenderingContext2D, rect: SkinRect, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
}

function px(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
) {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, width, height);
}

const canvasCache = new Map<string, HTMLCanvasElement>();
const dataUrlCache = new Map<string, string>();

/** Paints a skin into a reusable 64×64 canvas. */
export function skinCanvas(skin: SkinDefinition): HTMLCanvasElement {
  const cached = canvasCache.get(skin.id);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = SKIN_TEXTURE_SIZE;
  canvas.height = SKIN_TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = false;
  paintSkin(ctx, skin);

  canvasCache.set(skin.id, canvas);
  return canvas;
}

export function skinDataUrl(skinId: string): string {
  const skin = getSkin(skinId);
  const cached = dataUrlCache.get(skin.id);
  if (cached) return cached;
  const url = skinCanvas(skin).toDataURL("image/png");
  dataUrlCache.set(skin.id, url);
  return url;
}

/**
 * Rebuilds any Minecraft skin PNG into the canonical 64x64 modern layout.
 *
 * Skins come in three shapes: modern 64x64, legacy 64x32 and HD multiples of
 * 64 (usually 128x128). Drawing those 1:1 into a 64x64 canvas shifts every UV
 * region, which makes the 3D preview look scrambled or upside down. HD skins
 * are downscaled; legacy skins get their missing left limbs mirrored in.
 */
export function canonicalSkinCanvas(
  image: HTMLImageElement | HTMLCanvasElement | ImageBitmap,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = SKIN_TEXTURE_SIZE;
  canvas.height = SKIN_TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  ctx.imageSmoothingEnabled = false;

  const width = image.width;
  const height = image.height;
  if (width === SKIN_TEXTURE_SIZE && height === SKIN_TEXTURE_SIZE / 2) {
    upgradeLegacySkin(ctx, image);
  } else if (width > 0 && height > 0) {
    ctx.drawImage(image, 0, 0, width, height, 0, 0, SKIN_TEXTURE_SIZE, SKIN_TEXTURE_SIZE);
  }
  return canvas;
}

/** Legacy 64x32 skins only contain the right arm and leg; mirror them left. */
function upgradeLegacySkin(ctx: CanvasRenderingContext2D, image: CanvasImageSource) {
  const base = document.createElement("canvas");
  base.width = SKIN_TEXTURE_SIZE;
  base.height = SKIN_TEXTURE_SIZE / 2;
  const baseCtx = base.getContext("2d");
  if (!baseCtx) return;
  baseCtx.imageSmoothingEnabled = false;
  baseCtx.drawImage(image, 0, 0, SKIN_TEXTURE_SIZE, SKIN_TEXTURE_SIZE / 2);
  ctx.drawImage(base, 0, 0);

  const mirror = (from: SkinRect, to: SkinRect) => {
    ctx.save();
    ctx.translate(to.x + to.w, to.y);
    ctx.scale(-1, 1);
    ctx.drawImage(base, from.x, from.y, from.w, from.h, 0, 0, to.w, to.h);
    ctx.restore();
  };

  for (const [right, left] of [
    [PART_LAYOUT.armRight, PART_LAYOUT.armLeft],
    [PART_LAYOUT.legRight, PART_LAYOUT.legLeft],
  ] as const) {
    mirror(right.top, left.top);
    mirror(right.bottom, left.bottom);
    mirror(right.front, left.front);
    mirror(right.back, left.back);
    mirror(right.left, left.right);
    mirror(right.right, left.left);
  }
}

const canonicalUrlCache = new Map<string, Promise<string>>();

/** Normalizes a skin data URL (or remote URL) for previews and <SkinHead>. */
export function canonicalSkinDataUrl(url: string): Promise<string> {
  const cached = canonicalUrlCache.get(url);
  if (cached) return cached;
  const job = new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(canonicalSkinCanvas(image).toDataURL("image/png"));
    image.onerror = () => reject(new Error("skin image could not be decoded"));
    image.src = url;
  });
  canonicalUrlCache.set(url, job);
  return job;
}

function paintSkin(ctx: CanvasRenderingContext2D, skin: SkinDefinition) {
  const p = skin.palette;
  const { head, hat, body, armRight, armLeft, legRight, legLeft } = PART_LAYOUT;

  // --- Head ---------------------------------------------------------------
  fill(ctx, head.top, p.hair);
  fill(ctx, head.bottom, p.skinShade);
  fill(ctx, head.front, p.skin);
  fill(ctx, head.back, p.hair);
  fill(ctx, head.left, p.skin);
  fill(ctx, head.right, p.skin);

  // Hair on sides / back.
  for (const side of [head.left, head.right]) {
    px(ctx, side.x, side.y, side.w, 2, p.hair);
    px(ctx, side.x, side.y + 2, side.w, 1, p.hairLight);
    px(ctx, side.x, side.y + 3, side.w, 1, shade(p.hair, -0.08));
  }
  px(ctx, head.back.x, head.back.y, head.back.w, 3, p.hair);
  px(ctx, head.back.x, head.back.y + 3, head.back.w, 1, p.hairLight);

  // Fringe + sideburns.
  px(ctx, 8, 8, 8, 2, p.hair);
  px(ctx, 8, 10, 8, 1, p.hairLight);
  px(ctx, 8, 11, 1, 2, p.hair);
  px(ctx, 15, 11, 1, 2, p.hair);

  // Face shading.
  px(ctx, 8, 11, 8, 5, p.skin);
  px(ctx, 8, 8, 1, 8, shade(p.skin, -0.1));
  px(ctx, 15, 8, 1, 8, shade(p.skin, -0.1));

  // Eyes (whites + pupils), brows, nose, mouth.
  px(ctx, 9, 12, 2, 1, "#f6fbff");
  px(ctx, 13, 12, 2, 1, "#f6fbff");
  px(ctx, 10, 12, 1, 1, p.eyes);
  px(ctx, 13, 12, 1, 1, p.eyes);
  px(ctx, 11, 13, 2, 1, p.skinShade);
  px(ctx, 10, 14, 4, 1, shade(p.skin, -0.34));
  px(ctx, 11, 14, 2, 1, shade(p.skin, -0.5));
  px(ctx, 11, 15, 2, 1, shade(p.skin, 0.08));

  // Ears.
  px(ctx, 2, 11, 2, 2, p.skinShade);
  px(ctx, 20, 11, 2, 2, p.skinShade);

  // --- Head overlay (hat layer) ------------------------------------------
  if (skin.hat === "headband") {
    // Rows 2–3 of the head overlay only: the eye row (4) must stay uncovered.
    const band = (rect: SkinRect) => {
      px(ctx, rect.x, rect.y + 2, rect.w, 1, shade(p.accent, 0.42));
      px(ctx, rect.x, rect.y + 3, rect.w, 1, p.accent);
    };
    band(hat.front);
    band(hat.back);
    band(hat.left);
    band(hat.right);
  } else if (skin.hat === "hood") {
    const hood = p.shirt;
    fill(ctx, hat.top, shade(hood, 0.1));
    fill(ctx, hat.back, hood);
    fill(ctx, hat.left, hood);
    fill(ctx, hat.right, hood);
    px(ctx, hat.front.x, hat.front.y, 8, 3, hood);
    px(ctx, hat.front.x, hat.front.y + 3, 8, 1, shade(p.accent, -0.1));
    px(ctx, 42, 9, 4, 1, shade(p.accent, 0.15));
    px(ctx, 32, 12, 2, 4, shade(hood, -0.2));
    px(ctx, 54, 12, 2, 4, shade(hood, -0.2));
  }

  // --- Torso --------------------------------------------------------------
  fill(ctx, body.front, p.shirt);
  fill(ctx, body.back, p.shirt);
  fill(ctx, body.left, p.shirtShade);
  fill(ctx, body.right, p.shirtShade);
  fill(ctx, body.top, p.shirtShade);
  fill(ctx, body.bottom, p.pants);

  // Jacket details: collar, zipper, hem, side shading.
  px(ctx, 20, 20, 8, 1, shade(p.shirt, -0.35));
  px(ctx, 20, 21, 1, 11, shade(p.shirt, -0.14));
  px(ctx, 27, 21, 1, 11, shade(p.shirt, -0.14));
  px(ctx, 23, 21, 2, 10, shade(p.shirt, -0.22));
  px(ctx, 23, 21, 1, 10, p.accent);
  px(ctx, 20, 31, 8, 1, shade(p.shirt, -0.3));
  px(ctx, 21, 24, 1, 2, shade(p.shirt, 0.08));
  px(ctx, 26, 24, 1, 2, shade(p.shirt, 0.08));

  // Chest badge (small frost cross on the right chest).
  px(ctx, 26, 26, 1, 3, p.accent);
  px(ctx, 25, 27, 3, 1, p.accent);

  // Back emblem.
  px(ctx, 35, 24, 1, 4, p.accent);
  px(ctx, 34, 25, 4, 1, p.accent);

  // --- Arms ---------------------------------------------------------------
  // Paint both the classic and slim UV regions, so switching the arm model
  // never leaves one of them empty.
  paintLimb(ctx, armRight, p.shirt, p.shirtShade, p.accent, p.skin, p.skinShade);
  paintLimb(ctx, armLeft, p.shirt, p.shirtShade, p.accent, p.skin, p.skinShade);
  paintLimb(ctx, SLIM_ARM_LAYOUT.armRight, p.shirt, p.shirtShade, p.accent, p.skin, p.skinShade);
  paintLimb(ctx, SLIM_ARM_LAYOUT.armLeft, p.shirt, p.shirtShade, p.accent, p.skin, p.skinShade);

  // --- Legs ---------------------------------------------------------------
  paintLeg(ctx, legRight, p.pants, p.shoes, p.accent);
  paintLeg(ctx, legLeft, p.pants, p.shoes, p.accent);
}

function paintLimb(
  ctx: CanvasRenderingContext2D,
  layout: (typeof PART_LAYOUT)["armRight"],
  sleeve: string,
  sleeveShade: string,
  accent: string,
  hand: string,
  handShade: string,
) {
  for (const face of [layout.front, layout.back, layout.left, layout.right]) {
    px(ctx, face.x, face.y, face.w, 9, face === layout.left || face === layout.right ? sleeveShade : sleeve);
    px(ctx, face.x, face.y + 9, face.w, 1, accent);
    px(ctx, face.x, face.y + 10, face.w, 2, hand);
  }
  fill(ctx, layout.top, sleeve);
  fill(ctx, layout.bottom, handShade);
  px(ctx, layout.front.x, layout.front.y, 1, 9, shade(sleeve, -0.15));
}

function paintLeg(
  ctx: CanvasRenderingContext2D,
  layout: (typeof PART_LAYOUT)["legRight"],
  pants: string,
  shoes: string,
  accent: string,
) {
  for (const face of [layout.front, layout.back, layout.left, layout.right]) {
    px(ctx, face.x, face.y, face.w, 10, face === layout.left || face === layout.right ? shade(pants, -0.12) : pants);
    px(ctx, face.x, face.y + 10, face.w, 2, shoes);
  }
  fill(ctx, layout.top, shade(pants, -0.1));
  fill(ctx, layout.bottom, shoes);
  px(ctx, layout.front.x, layout.front.y, 1, 10, shade(pants, -0.18));
  px(ctx, layout.front.x + 3, layout.front.y + 1, 1, 2, shade(accent, -0.45));
}
