/**
 * Canonical Minecraft skin layout (64×64, modern format).
 *
 * Both the texture painter and the 3D box UVs read from this single table, so a
 * head/overlay/limb can never drift out of alignment again.
 *
 * Face order matches three.js `BoxGeometry`: +x, -x, +y, -y, +z, -z.
 * In game space the character faces +z, so +x is its left side and -x its right.
 */

export interface SkinRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PartLayout {
  top: SkinRect;
  bottom: SkinRect;
  left: SkinRect;
  right: SkinRect;
  front: SkinRect;
  back: SkinRect;
  /** Size in skin pixels (1 px = 1/16 block). */
  size: { w: number; h: number; d: number };
}

const rect = (x: number, y: number, w: number, h: number): SkinRect => ({
  x,
  y,
  w,
  h,
});

const head: PartLayout = {
  top: rect(8, 0, 8, 8),
  bottom: rect(16, 0, 8, 8),
  right: rect(0, 8, 8, 8),
  front: rect(8, 8, 8, 8),
  left: rect(16, 8, 8, 8),
  back: rect(24, 8, 8, 8),
  size: { w: 8, h: 8, d: 8 },
};

const hat: PartLayout = {
  top: rect(40, 0, 8, 8),
  bottom: rect(48, 0, 8, 8),
  right: rect(32, 8, 8, 8),
  front: rect(40, 8, 8, 8),
  left: rect(48, 8, 8, 8),
  back: rect(56, 8, 8, 8),
  size: { w: 8, h: 8, d: 8 },
};

const body: PartLayout = {
  top: rect(20, 16, 8, 4),
  bottom: rect(28, 16, 8, 4),
  right: rect(16, 20, 4, 12),
  front: rect(20, 20, 8, 12),
  left: rect(28, 20, 4, 12),
  back: rect(32, 20, 8, 12),
  size: { w: 8, h: 12, d: 4 },
};

const armRight: PartLayout = {
  top: rect(44, 16, 4, 4),
  bottom: rect(48, 16, 4, 4),
  right: rect(40, 20, 4, 12),
  front: rect(44, 20, 4, 12),
  left: rect(48, 20, 4, 12),
  back: rect(52, 20, 4, 12),
  size: { w: 4, h: 12, d: 4 },
};

const armLeft: PartLayout = {
  top: rect(36, 48, 4, 4),
  bottom: rect(40, 48, 4, 4),
  right: rect(32, 52, 4, 12),
  front: rect(36, 52, 4, 12),
  left: rect(40, 52, 4, 12),
  back: rect(44, 52, 4, 12),
  size: { w: 4, h: 12, d: 4 },
};

/** Slim (Alex) arms are 3 px wide and use their own UV regions. */
const slimArmRight: PartLayout = {
  top: rect(44, 16, 3, 4),
  bottom: rect(47, 16, 3, 4),
  right: rect(40, 20, 3, 12),
  front: rect(44, 20, 3, 12),
  left: rect(47, 20, 3, 12),
  back: rect(50, 20, 3, 12),
  size: { w: 3, h: 12, d: 3 },
};

const slimArmLeft: PartLayout = {
  top: rect(36, 48, 3, 4),
  bottom: rect(39, 48, 3, 4),
  right: rect(32, 52, 3, 12),
  front: rect(35, 52, 3, 12),
  left: rect(38, 52, 3, 12),
  back: rect(41, 52, 3, 12),
  size: { w: 3, h: 12, d: 3 },
};

const legRight: PartLayout = {
  top: rect(4, 16, 4, 4),
  bottom: rect(8, 16, 4, 4),
  right: rect(0, 20, 4, 12),
  front: rect(4, 20, 4, 12),
  left: rect(8, 20, 4, 12),
  back: rect(12, 20, 4, 12),
  size: { w: 4, h: 12, d: 4 },
};

const legLeft: PartLayout = {
  top: rect(20, 48, 4, 4),
  bottom: rect(24, 48, 4, 4),
  right: rect(16, 52, 4, 12),
  front: rect(20, 52, 4, 12),
  left: rect(24, 52, 4, 12),
  back: rect(28, 52, 4, 12),
  size: { w: 4, h: 12, d: 4 },
};

export const PART_LAYOUT = {
  head,
  hat,
  body,
  armRight,
  armLeft,
  legRight,
  legLeft,
};

export const SLIM_ARM_LAYOUT = {
  armRight: slimArmRight,
  armLeft: slimArmLeft,
};

export const SKIN_TEXTURE_SIZE = 64;
