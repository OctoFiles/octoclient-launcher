/**
 * Cape cosmetics. Each cape is painted into a 10×16 texture which maps 1:1 onto
 * the cape plane, so UVs stay trivial and pixels stay square.
 */

import generated from "../../../data/generated-cosmetics.json";
import { mixHex, shade } from "./color";

export interface CapeDefinition {
  id: string;
  name: string;
  description: string;
  top: string;
  bottom: string;
  emblem: string;
  trim: string;
}

const CATALOG_CAPES: CapeDefinition[] = (generated.items as Array<{
  id: string;
  type: string;
  name: string;
  description: string;
  primary: string;
  secondary: string;
  accent: string;
}>)
  .filter((item) => item.type === "CAPE" || item.type === "CUSTOM_CAPE")
  .map((item) => ({
    id: item.id,
    name: item.name,
    description: item.description,
    top: item.primary,
    bottom: item.secondary,
    emblem: item.accent,
    trim: item.accent,
  }));

export const NO_CAPE: CapeDefinition = {
  id: "none",
  name: "Kein Cape",
  description: "Slot leer",
  top: "#2b3445",
  bottom: "#141a26",
  emblem: "#475569",
  trim: "#475569",
};

export function getCape(id: string): CapeDefinition {
  return CATALOG_CAPES.find((cape) => cape.id === id) ?? NO_CAPE;
}

const capeCache = new Map<string, HTMLCanvasElement>();

export function capeCanvas(cape: CapeDefinition): HTMLCanvasElement {
  const cached = capeCache.get(cape.id);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = 10;
  canvas.height = 16;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  paintCape(ctx, cape);
  capeCache.set(cape.id, canvas);
  return canvas;
}

function paintCape(ctx: CanvasRenderingContext2D, cape: CapeDefinition) {
  for (let y = 0; y < 16; y += 1) {
    const t = y / 15;
    const base = mixHex(cape.top, cape.bottom, t);
    for (let x = 0; x < 10; x += 1) {
      let color = base;
      if (x === 0 || x === 9) color = shade(base, -0.22);
      else if (x === 1 || x === 8) color = shade(base, -0.1);
      else if (x === 4 || x === 5) color = shade(base, 0.06);
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 1, 1);
    }
  }

  // Attachment row and hem.
  ctx.fillStyle = shade(cape.bottom, -0.35);
  ctx.fillRect(0, 0, 10, 1);
  ctx.fillStyle = cape.trim;
  ctx.fillRect(0, 14, 10, 1);
  ctx.fillStyle = shade(cape.trim, -0.4);
  ctx.fillRect(0, 15, 10, 1);

  // Emblem: a clean six-pixel-high crystal diamond (reads at small sizes).
  const emblem: Array<[number, number]> = [
    [4, 4], [5, 4],
    [3, 5], [4, 5], [5, 5], [6, 5],
    [2, 6], [3, 6], [4, 6], [5, 6], [6, 6], [7, 6],
    [2, 7], [3, 7], [4, 7], [5, 7], [6, 7], [7, 7],
    [3, 8], [4, 8], [5, 8], [6, 8],
    [4, 9], [5, 9],
  ];
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = cape.emblem;
  for (const [x, y] of emblem) ctx.fillRect(x, y, 1, 1);
  ctx.globalAlpha = 1;
}
