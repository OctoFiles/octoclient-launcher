/**
 * Minecraft player rig (vanilla proportions, 1 unit = 1 block).
 *
 * Every part is a box whose UVs are written from `PART_LAYOUT`, so the texture
 * regions and geometry can't disagree. The head overlay is a slightly inflated
 * copy of the head box, exactly like the vanilla hat layer.
 *
 * Coordinates: feet at y = 0, character faces +z, +x is the character's left.
 */

import * as THREE from "three";

import type { SkinModel } from "../../../lib/types";
import { ANIMATED_CAPE_UV, loadAnimatedCape } from "./animatedCapes";
import { capeCanvas, getCape } from "./cape";
import { loadCapeTexture } from "./cosmeticAssets";
import { mountCosmetic, type CosmeticRigHosts, type MountedCosmetic } from "./cosmeticRig";
import { getCosmeticItem } from "./cosmetics";
import { canonicalSkinCanvas, getSkin, skinCanvas } from "./skin";
import {
  PART_LAYOUT,
  SKIN_TEXTURE_SIZE,
  SLIM_ARM_LAYOUT,
  type PartLayout,
} from "./skinLayout";

export interface PointerState {
  x: number;
  y: number;
}

export interface PlayerModel {
  root: THREE.Group;
  /** `yaw` is the drag-controlled body rotation in radians. */
  update: (time: number, delta: number, pointer: PointerState, yaw?: number) => void;
  dispose: () => void;
}

/** Fabrics of the standard cape template end at 34/46; below is the strap strip. */
const CAPE_ATLAS_V1 = 34 / 46;

function makeTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/** Writes absolute skin UVs onto a BoxGeometry (face order: +x, -x, +y, -y, +z, -z). */
function applyLayoutUvs(geometry: THREE.BoxGeometry, layout: PartLayout) {
  const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
  const rects = [
    layout.left,
    layout.right,
    layout.top,
    layout.bottom,
    layout.front,
    layout.back,
  ];

  rects.forEach((rect, face) => {
    const u0 = rect.x / SKIN_TEXTURE_SIZE;
    const u1 = (rect.x + rect.w) / SKIN_TEXTURE_SIZE;
    const vTop = 1 - rect.y / SKIN_TEXTURE_SIZE;
    const vBottom = 1 - (rect.y + rect.h) / SKIN_TEXTURE_SIZE;
    const base = face * 4;
    uv.setXY(base, u0, vTop);
    uv.setXY(base + 1, u1, vTop);
    uv.setXY(base + 2, u0, vBottom);
    uv.setXY(base + 3, u1, vBottom);
  });

  uv.needsUpdate = true;
}

function createPart(
  layout: PartLayout,
  material: THREE.Material,
  scale = 1,
): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(
    (layout.size.w / 16) * scale,
    (layout.size.h / 16) * scale,
    (layout.size.d / 16) * scale,
  );
  applyLayoutUvs(geometry, layout);
  return new THREE.Mesh(geometry, material);
}

export interface PlayerOptions {
  skinId: string;
  skinModel: SkinModel;
  skinDataUrl?: string | null;
  capeId: string;
  accessoryId: string;
  headId: string;
  bandanaId: string;
  wingId: string;
  shieldId: string;
}

export function createPlayer({
  skinId,
  skinModel,
  skinDataUrl,
  capeId,
  accessoryId,
  headId,
  bandanaId,
  wingId,
  shieldId,
}: PlayerOptions): PlayerModel {
  // Start with the local skin, then paint the account's real skin over it as
  // soon as the PNG from Microsoft is decoded.
  const canvas = document.createElement("canvas");
  canvas.width = SKIN_TEXTURE_SIZE;
  canvas.height = SKIN_TEXTURE_SIZE;
  const context = canvas.getContext("2d");
  if (context) {
    context.imageSmoothingEnabled = false;
    context.drawImage(skinCanvas(getSkin(skinId)), 0, 0);
  }
  const skinTexture = makeTexture(canvas);
  const capeTexture = makeTexture(capeCanvas(getCape(capeId)));
  /** Whatever cloth texture is live right now; disposed with the model. */
  let capeMap: THREE.Texture = capeTexture;
  // The cape plane faces the body, so its back side is what the viewer sees:
  // mirror U once so designs are not left-right swapped from behind. Baked cape
  // textures are authored top-down with `flipY = false`, so V is mirrored too —
  // otherwise the whole cape hangs upside down.
  capeTexture.repeat.set(-1, -1);
  capeTexture.offset.set(1, 1);
  let disposed = false;

  if (skinDataUrl) {
    const image = new Image();
    image.onload = () => {
      if (disposed || !context) return;
      // HD (128x128) and legacy (64x32) skins must be rebuilt into the
      // canonical 64x64 layout before the box UVs can sample them.
      const canonical = canonicalSkinCanvas(image);
      context.clearRect(0, 0, SKIN_TEXTURE_SIZE, SKIN_TEXTURE_SIZE);
      context.imageSmoothingEnabled = false;
      context.drawImage(canonical, 0, 0);
      skinTexture.needsUpdate = true;
    };
    image.src = skinDataUrl;
  }

  const root = new THREE.Group();
  root.name = "frost-player";
  const bodyGroup = new THREE.Group();
  root.add(bodyGroup);

  const skinMaterial = new THREE.MeshLambertMaterial({ map: skinTexture });
  const hatMaterial = new THREE.MeshLambertMaterial({
    map: skinTexture,
    transparent: true,
    alphaTest: 0.5,
  });

  // Torso: 8×12×4 px, centred at y = 1.125.
  const torso = createPart(PART_LAYOUT.body, skinMaterial);
  torso.name = "torso";
  torso.position.set(0, 1.125, 0);
  bodyGroup.add(torso);

  // Head: pivot at the neck (y = 1.5) so it can look around.
  const headGroup = new THREE.Group();
  headGroup.name = "head";
  headGroup.position.set(0, 1.5, 0);
  const head = createPart(PART_LAYOUT.head, skinMaterial);
  head.position.set(0, 0.25, 0);
  headGroup.add(head);

  const hat = createPart(PART_LAYOUT.hat, hatMaterial, 1.075);
  hat.position.set(0, 0.25, 0);
  headGroup.add(hat);
  bodyGroup.add(headGroup);

  // Arms: pivot at the shoulder. Classic arms are 4 px wide, slim (Alex) arms
  // are 3 px wide and use their own skin UV layout.
  const armRightLayout =
    skinModel === "slim" ? SLIM_ARM_LAYOUT.armRight : PART_LAYOUT.armRight;
  const armLeftLayout =
    skinModel === "slim" ? SLIM_ARM_LAYOUT.armLeft : PART_LAYOUT.armLeft;
  const armOffset = 0.25 + armRightLayout.size.w / 32;

  const armRight = new THREE.Group();
  armRight.position.set(-armOffset, 1.5, 0);
  const armRightMesh = createPart(armRightLayout, skinMaterial);
  armRightMesh.position.set(0, -0.375, 0);
  armRight.add(armRightMesh);
  bodyGroup.add(armRight);

  const armLeft = new THREE.Group();
  armLeft.position.set(armOffset, 1.5, 0);
  const armLeftMesh = createPart(armLeftLayout, skinMaterial);
  armLeftMesh.position.set(0, -0.375, 0);
  armLeft.add(armLeftMesh);
  bodyGroup.add(armLeft);

  // Legs: pivot at the hip (y = 0.75).
  const legRight = new THREE.Group();
  legRight.position.set(-0.125, 0.75, 0);
  const legRightMesh = createPart(PART_LAYOUT.legRight, skinMaterial);
  legRightMesh.position.set(0, -0.375, 0);
  legRight.add(legRightMesh);
  bodyGroup.add(legRight);

  const legLeft = new THREE.Group();
  legLeft.position.set(0.125, 0.75, 0);
  const legLeftMesh = createPart(PART_LAYOUT.legLeft, skinMaterial);
  legLeftMesh.position.set(0, -0.375, 0);
  legLeft.add(legLeftMesh);
  bodyGroup.add(legLeft);

  // Cape: 10×16 px plane pinned at the shoulder line, hanging down the back.
    const capeGeometry = new THREE.PlaneGeometry(0.625, 1, 8, 12);
  capeGeometry.translate(0, -0.5, 0);
  const capeBase = Float32Array.from(
    capeGeometry.getAttribute("position").array as Float32Array,
  );
  const capeMaterial = new THREE.MeshLambertMaterial({
    map: capeTexture,
    side: THREE.DoubleSide,
    alphaTest: 0.1,
  });
  const capeMesh = new THREE.Mesh(capeGeometry, capeMaterial);
  capeMesh.name = "cape-mesh";
  const capeGroup = new THREE.Group();
  capeGroup.name = "cape";
  // 0.17 units behind the torso keeps the waving cloth out of the body mesh.
  capeGroup.position.set(0, 1.47, -0.17);
  capeGroup.add(capeMesh);
  bodyGroup.add(capeGroup);

  const capePosition = capeGeometry.getAttribute("position") as THREE.BufferAttribute;

  // --- Cosmetics ----------------------------------------------------------
  // Real in-game assets: the mod's own OBJ/MD5 meshes and textures. A missing
  // asset (built-in module cosmetics) simply leaves the slot empty.
  const cosmeticHosts: CosmeticRigHosts = {
    head: headGroup,
    body: bodyGroup,
    armLeft,
    armRight,
    legLeft,
    legRight,
  };
  const mountedCosmetics: MountedCosmetic[] = [];
  for (const item of [
    getCosmeticItem("heads", headId),
    getCosmeticItem("bandanas", bandanaId),
    getCosmeticItem("accessories", accessoryId),
    getCosmeticItem("wings", wingId),
    getCosmeticItem("shields", shieldId),
  ]) {
    if (item.id === "none") continue;
    void mountCosmetic(item, cosmeticHosts).then((mounted) => {
      if (!mounted) return;
      if (disposed) {
        mounted.dispose();
        return;
      }
      mountedCosmetics.push(mounted);
    });
  }

  // Animated capes (the mod's GIF modules) play their baked frame strip: the
  // cloth samples one frame band at a time and `update` walks down the strip.
  const capeItem = getCosmeticItem("capes", capeId);
  let capeClip: { frames: number; delayMs: number; frame: number; elapsed: number } | null =
    null;
  if (capeItem.kind === "animated") {
    void loadAnimatedCape(capeItem.moduleName).then((clip) => {
      if (!clip || disposed) return;
      const texture = clip.texture;
      const spanX = ANIMATED_CAPE_UV.u1 - ANIMATED_CAPE_UV.u0;
      const spanY = ANIMATED_CAPE_UV.v1 - ANIMATED_CAPE_UV.v0;
      // Mirror U for the back view and keep only the outer face of the sheet,
      // then map exactly one frame of the strip onto the cloth.
      texture.repeat.set(-spanX, -spanY / clip.frames);
      texture.offset.set(
        ANIMATED_CAPE_UV.u1,
        ANIMATED_CAPE_UV.v1 / clip.frames,
      );
      texture.needsUpdate = true;
      capeMaterial.map = texture;
      capeMaterial.needsUpdate = true;
      capeMap.dispose();
      capeMap = texture;
      capeClip = { frames: clip.frames, delayMs: clip.delayMs, frame: 0, elapsed: 0 };
    });
  } else if (capeId !== "none") {
    // Catalogue capes carry their own artwork; paint it onto the cloth plane.
    void loadCapeTexture(capeId).then((cape) => {
      if (!cape || disposed) return;
      const texture = cape.texture;
      // Catalogue capes ship as the 44×46 cape template (near-square sheets,
      // e.g. 245×256): the outer face is the left cell (u 0..0.5), the inner
      // face the right one, and the strip below v 34/46 holds the straps. The
      // whole sheet used to be stretched over the 10×16 cloth, so that strap
      // strip landed on the hem and read as a cut-off bottom, and the square
      // artwork was squeezed into an egg-shaped moon. Sample exactly the outer
      // cell, like `CatalogCosmeticRenderer.readCapeUv` does in game; sheets
      // wider than the template are one continuous design and keep the whole
      // image.
      const image = texture.image as { width?: number; height?: number } | undefined;
      const imageAspect =
        (image?.width ?? 10) / Math.max(1, image?.height ?? 16);
      const atlas = imageAspect >= 0.9 && imageAspect <= 1.02;
      const cropX = atlas ? 0.5 : 1;
      const cropY = atlas ? CAPE_ATLAS_V1 : 1;
      // Back side faces the viewer, so U is mirrored; the sheets are authored
      // top-down with `flipY = false`, so V is mirrored as well to keep the
      // artwork upright. Both mirrors run inside the sampled cell.
      texture.repeat.set(-cropX, -cropY);
      texture.offset.set(cropX, cropY);
      texture.needsUpdate = true;
      capeMaterial.map = texture;
      capeMaterial.needsUpdate = true;
      capeMap.dispose();
      capeMap = texture;
    });
  }

  function updateCape(time: number, wind: number) {
    const array = capePosition.array as Float32Array;
    for (let index = 0; index < array.length; index += 3) {
      const x = capeBase[index];
      const y = capeBase[index + 1];
      const t = Math.min(1, Math.max(0, -y));
      const flutter =
        Math.sin(time * 2.1 + t * 4.4) * 0.045 * t +
        Math.sin(time * 1.3 + x * 9) * 0.013 * t;
      array[index] = x + Math.sin(time * 0.8 + t * 2.6) * 0.014 * t;
      array[index + 2] = flutter - t * t * 0.02 - wind * 0.03 * t;
    }
    capePosition.needsUpdate = true;
    capeGeometry.computeVertexNormals();
    capeGroup.rotation.x = 0.05 + Math.sin(time * 0.9) * 0.025;
    capeGroup.rotation.z = Math.sin(time * 0.6) * 0.012;
  }

  let smoothedTurn = -0.32;

  function update(
    time: number,
    delta: number,
    pointer: PointerState,
    yaw = -0.32,
  ) {
    const ease = Math.min(1, delta * 5);
    // The pointer adds a small parallax on top of the dragged body rotation.
    const desiredTurn = yaw + pointer.x * 0.12;
    smoothedTurn += (desiredTurn - smoothedTurn) * Math.min(1, delta * 5);
    root.rotation.y = smoothedTurn;

    // Head follows the pointer within a natural range.
    headGroup.rotation.y += (pointer.x * 0.42 - headGroup.rotation.y) * ease;
    headGroup.rotation.x += (-pointer.y * 0.22 - headGroup.rotation.x) * ease;

    // Idle breathing + relaxed limbs.
    bodyGroup.position.y = Math.sin(time * 1.2) * 0.012;
    armRight.rotation.x = Math.sin(time * 1.25) * 0.055 + 0.03;
    armLeft.rotation.x = -Math.sin(time * 1.25) * 0.055 + 0.03;
    armRight.rotation.z = -0.018;
    armLeft.rotation.z = 0.018;
    legRight.rotation.x = Math.sin(time * 1.05) * 0.02;
    legLeft.rotation.x = -Math.sin(time * 1.05) * 0.02;

    // Wind follows how quickly the body is turning.
    const turning = Math.abs(desiredTurn - smoothedTurn);
    updateCape(time, Math.min(1, turning * 4));

    // Animated capes advance frame by frame, exactly like `AnimatedCapeTextures`.
    if (capeClip) {
      capeClip.elapsed += delta * 1000;
      const frame = Math.floor(capeClip.elapsed / capeClip.delayMs) % capeClip.frames;
      const map = capeMaterial.map as THREE.Texture | null;
      if (frame !== capeClip.frame && map) {
        capeClip.frame = frame;
        map.offset.y = (frame + ANIMATED_CAPE_UV.v1) / capeClip.frames;
      }
    }

    // Wings play the same flutter the game runs on the player.
    for (const mounted of mountedCosmetics) mounted.update?.(time);

  }

  function dispose() {
    disposed = true;
    skinTexture.dispose();
    capeMap.dispose();
    skinMaterial.dispose();
    hatMaterial.dispose();
    capeMaterial.dispose();
    mountedCosmetics.forEach((mounted) => mounted.dispose());
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose();
      }
    });
  }

  return { root, update, dispose };
}
