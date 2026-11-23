/**
 * Mounts the real cosmetic meshes on the launcher's player rig.
 *
 * The transforms mirror `CatalogCosmeticRenderer`: catalogue meshes are
 * authored with y up / face +z in pixels, which is also the launcher rig's
 * space, so they are only scaled by the catalogue scale. The game flips Y/Z
 * because its own model space is y down / face -z; that flip is undone by
 * mirroring the translation Y and Z here.
 */

import * as THREE from "three";

import { loadCosmeticAsset, type CosmeticAsset } from "./cosmeticAssets";
import type { CosmeticItem } from "./cosmetics";

export interface CosmeticRigHosts {
  head: THREE.Group;
  /** Torso group; its origin is at the feet, so body cosmetics need the neck offset. */
  body: THREE.Group;
  armLeft: THREE.Group;
  armRight: THREE.Group;
  legLeft: THREE.Group;
  legRight: THREE.Group;
}

const BODY_TOP_Y = 1.5;
const HAT_LIFT = 1.1 / 16;
const BANDANA_TOP_Y = -7.75 / 16;
const WING_OFFSET_Y = 1.9 / 16;
/**
 * Wings hang this far behind the torso, in blocks. The cape plane is the outer
 * layer at 0.17, so the pair sits between the back (0.125) and the cloth: they
 * are as close to the body as the cape allows and the roots disappear under it
 * instead of drawing over the whole cape.
 */
const WING_OFFSET_Z = 2.2 / 16;
const WICHTIGER_WING_DROP = 4 / 16;
/**
 * Minimum lateral distance from the spine where a wing root starts, in blocks.
 * 3.2/16 pushed both halves 0.2 blocks outwards, which left a four-pixel gap
 * down the middle of the back and made the pair read as two separate sheets.
 * The roots now meet near the spine (1/16); the cloth still clears the torso
 * because it sits behind it.
 */
const WING_ROOT_X = 1 / 16;

/**
 * The shared wing flutter, ported 1:1 from `CatalogCosmeticRenderer`. Catalog
 * wings replay the idle clip of the Black Dark Wings pack (`nrc.idle`): two
 * chained bones yaw around the vertical axis at 100 degrees per second with a
 * small second harmonic, on top of a constant rest sweep.
 */
const WING_FLUTTER_RATE = 100;
const WING_INNER_PHASE = -50;
const WING_OUTER_PHASE = -100;
const WING_HARMONIC_PHASE = -0.25;
const WING_INNER_SWING = 12;
const WING_INNER_HARMONIC = 5;
const WING_OUTER_SWING = 8;
const WING_OUTER_HARMONIC = 0.2;
/** Span fraction where the whole-sheet yaw starts bending towards the tip. */
const WING_INNER_SPLIT = 0.4;
/** Rest-pose yaw of the reference clip's inner bone (-40 left, +40 right). */
const WING_BASE_SWEEP = 40;

const HEAD_TYPES = new Set([
  "HAT",
  "CUSTOM_HAT",
  "CUSTOM_HALO",
  "EARS",
  "NOSE",
  "MOUTH",
  "EYES",
  "MASK",
  "NECK",
  "HALO",
  "BANDANA",
  "CUSTOM_BANDANA",
  "INSIDER_NAMETAG_ICON",
  "BLC_NAMETAG_ICON",
  "INSIDER_NAMETAG_BORDER",
]);
const ARM_TYPES = new Set(["BOW", "SWORD", "SHIELD", "ARM_BAND"]);

export interface MountedCosmetic {
  root: THREE.Object3D;
  /** Per-frame animation; only wings currently have one. */
  update?: (seconds: number) => void;
  dispose: () => void;
}

function cosmeticMaterial(
  asset: CosmeticAsset,
  flipU = false,
): THREE.MeshLambertMaterial {
  const flipV = asset.entry.flipUVs;
  const texture = flipU || flipV ? asset.texture.clone() : asset.texture;
  if (flipU || flipV) {
    texture.repeat.set(flipU ? -1 : 1, flipV ? -1 : 1);
    texture.offset.set(flipU ? 1 : 0, flipV ? 1 : 0);
    texture.needsUpdate = true;
  }
  return new THREE.MeshLambertMaterial({
    map: texture,
    side: THREE.DoubleSide,
    alphaTest: 0.4,
  });
}

function mountMesh(
  asset: CosmeticAsset,
  material: THREE.Material,
  scale: number,
): THREE.Mesh {
  // The cached geometry is shared between mounts; the preview disposes its own
  // meshes, so give each one a copy.
  const mesh = new THREE.Mesh(asset.geometry.clone(), material);
  // Catalogue assets are authored Y-up with the face toward +Z, which is the
  // launcher rig's own space. The game flips Y/Z only because its model space
  // is Y-down, so no extra rotation belongs here.
  mesh.scale.setScalar(scale);
  return mesh;
}

/** Plane the game draws for catalogue entries without a usable model. */
function mountFallbackPlane(material: THREE.Material): THREE.Mesh {
  return new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), material);
}

interface WingSwing {
  base: number;
  inner: number;
  outer: number;
  rootX: number;
  tipX: number;
}

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Rest yaw plus the two oscillating bone yaws of the game's `nrc.idle` clip. */
function wingSwing(asset: CosmeticAsset, seconds: number): WingSwing | null {
  const box = asset.geometry.boundingBox;
  if (!box) return null;
  // The authored half hinges at whichever X edge sits closest to the spine.
  const rootNearMin = Math.abs(box.min.x) <= Math.abs(box.max.x);
  const rootX = rootNearMin ? box.min.x : box.max.x;
  const tipX = rootNearMin ? box.max.x : box.min.x;
  if (Math.abs(tipX - rootX) < 1e-3) return null;
  // Sweeping back means moving the tip toward -Z (the character faces +Z).
  // A negative yaw does that for a left-authored half, a positive one for a
  // right-authored half — the opposite sign sent both wings forward, through
  // the head, which read as "flapping in the wrong direction".
  const t = seconds * WING_FLUTTER_RATE;
  return {
    base: Math.sign(tipX - rootX) * toRadians(WING_BASE_SWEEP),
    inner: toRadians(
      WING_INNER_SWING * Math.sin(toRadians(t + WING_INNER_PHASE)) +
        WING_INNER_HARMONIC *
          Math.sin(toRadians(t + WING_INNER_PHASE + WING_HARMONIC_PHASE)),
    ),
    outer: toRadians(
      WING_OUTER_SWING * Math.sin(toRadians(t + WING_OUTER_PHASE)) +
        WING_OUTER_HARMONIC *
          Math.sin(toRadians(t + WING_OUTER_PHASE + WING_HARMONIC_PHASE)),
    ),
    rootX,
    tipX,
  };
}

/**
 * Rebends one wing sheet around its spine hinge, mirroring the game's
 * `emitWingTriangle`: the yaw is ramped smoothly from the pinned root to the
 * crease and the outer bend only adds a whip at the tip.
 */
function bendWing(mesh: THREE.Mesh, rest: Float32Array, swing: WingSwing) {
  const attribute = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
  const array = attribute.array as Float32Array;
  const span = swing.tipX - swing.rootX;
  for (let index = 0; index < array.length; index += 3) {
    const px = rest[index];
    const py = rest[index + 1];
    const pz = rest[index + 2];
    const frac = Math.min(1, Math.max(0, (px - swing.rootX) / span));
    let flutter: number;
    if (frac <= WING_INNER_SPLIT) {
      const t = frac / WING_INNER_SPLIT;
      flutter = swing.inner * (t * t * (3 - 2 * t));
    } else {
      const t = (frac - WING_INNER_SPLIT) / (1 - WING_INNER_SPLIT);
      flutter = swing.inner + swing.outer * (t * t * (3 - 2 * t));
    }
    const yaw = swing.base + flutter;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const dx = px - swing.rootX;
    const nx = swing.rootX + dx * cos + pz * sin;
    const nz = -dx * sin + pz * cos;
    array[index] = nx;
    array[index + 1] = py;
    array[index + 2] = nz;
  }
  attribute.needsUpdate = true;
  mesh.geometry.computeVertexNormals();
}

export async function mountCosmetic(
  item: CosmeticItem,
  hosts: CosmeticRigHosts,
): Promise<MountedCosmetic | null> {
  const asset = await loadCosmeticAsset(item.id);
  if (!asset) return null;
  const { entry } = asset;
  const type = entry.type || item.type;
  // A shield is mounted on the outside of the right arm, so the viewer looks at
  // its face from the character's right; that axis mirrors the artwork, which
  // left the bolt pointing the wrong way. Mirror U once to undo it (V is fine:
  // the mesh's v = 0 edge is its top edge).
  const material = cosmeticMaterial(asset, type === "SHIELD");
  const root = new THREE.Group();
  root.name = `cosmetic-${item.id}`;
  const meshes: THREE.Mesh[] = [];

  const scale = entry.scale || 1 / 16;

  let animate: ((seconds: number) => void) | undefined;

  if (type === "WINGS") {
    const wichtiger = (entry.path ?? "").endsWith("/wichtiger.obj");
    root.position.set(
      entry.x,
      BODY_TOP_Y - (entry.y + WING_OFFSET_Y + 1.1 / 16 + (wichtiger ? WICHTIGER_WING_DROP : 0)),
      -(entry.z + WING_OFFSET_Z),
    );
    if (asset.geometry.getAttribute("position")) {
      const wingScale = scale * 1.25;
      const left = mountMesh(asset, material, wingScale);
      const right = mountMesh(asset, material, wingScale);
      // The source assets hold a single half wing; the game draws its mirror.
      right.scale.x = -wingScale;
      // Push both halves out until their roots sit beside the torso instead of
      // inside it. The offset is per half, so the sheet itself stays unbent.
      const box = asset.geometry.boundingBox;
      const innerEdge = box
        ? Math.abs(box.min.x) <= Math.abs(box.max.x)
          ? box.min.x
          : box.max.x
        : 0;
      const rootShift = Math.max(0, WING_ROOT_X - Math.abs(innerEdge) * wingScale);
      left.position.x = -rootShift;
      right.position.x = rootShift;
      const leftRest = Float32Array.from(
        asset.geometry.getAttribute("position").array as Float32Array,
      );
      const rightRest = Float32Array.from(leftRest);
      animate = (seconds: number) => {
        const swing = wingSwing(asset, seconds);
        if (!swing) return;
        bendWing(left, leftRest, swing);
        bendWing(right, rightRest, swing);
      };
      animate(0);
      meshes.push(left, right);
      root.add(left, right);
    } else {
      const plane = mountFallbackPlane(material);
      plane.position.set(0, -0.1, 0);
      meshes.push(plane);
      root.add(plane);
    }
    hosts.body.add(root);
    return {
      root,
      update: animate,
      dispose: () => {
        hosts.body.remove(root);
        material.dispose();
        meshes.forEach((mesh) => {
          if (mesh.geometry !== asset.geometry) mesh.geometry.dispose();
        });
      },
    };
  }

  const hasMesh = asset.geometry.getAttribute("position") !== undefined;
  let host: THREE.Group;
  let offsetY = BODY_TOP_Y;

  if (type === "BOOTS") {
    host = hosts.legRight;
    offsetY = 0;
  } else if (HEAD_TYPES.has(type)) {
    host = hosts.head;
    offsetY = 0;
  } else if (ARM_TYPES.has(type)) {
    // The game shows shields on the main-hand (right) arm.
    host = hosts.armRight;
    offsetY = 0;
  } else {
    host = hosts.body;
    offsetY = BODY_TOP_Y;
  }

  if (hasMesh) {
    let positionY = -entry.y;
    if (type === "BANDANA") {
      // The game aligns the band's top edge just under the crown.
      positionY = -BANDANA_TOP_Y - asset.maxY * scale;
    } else if (type === "HAT") {
      positionY += HAT_LIFT;
    }
    root.position.set(entry.x, offsetY + positionY, -entry.z);
    if (type === "SHIELD") {
      // `renderShieldOnArm`: the artwork is fitted to 14x22 px, centred and
      // pinned 7/16 below the shoulder on the outer side of the forearm.
      const fit = Math.min(14 / Math.max(1, asset.width), 22 / Math.max(1, asset.height));
      const mesh = mountMesh(asset, material, scale * fit);
      const box = asset.geometry.boundingBox;
      if (box) {
        mesh.geometry.translate(
          -(box.min.x + box.max.x) / 2,
          -(box.min.y + box.max.y) / 2,
          -(box.min.z + box.max.z) / 2,
        );
      }
      root.position.set(-0.25, -0.4375, 0.02);
      root.rotation.y = -Math.PI / 2;
      meshes.push(mesh);
      root.add(mesh);
    } else {
      const mesh = mountMesh(asset, material, scale);
      meshes.push(mesh);
      root.add(mesh);
    }
    host.add(root);
    if (type === "BOOTS") {
      const copy = root.clone();
      copy.name = `${root.name}-left`;
      hosts.legLeft.add(copy);
      return {
        root,
        dispose: () => {
          hosts.legRight.remove(root);
          hosts.legLeft.remove(copy);
          material.dispose();
        },
      };
    }
  } else {
    const plane = mountFallbackPlane(material);
    if (HEAD_TYPES.has(type)) {
      root.position.set(entry.x, offsetY - 0.78, 0.33);
    } else {
      root.position.set(entry.x, offsetY - entry.y, -entry.z - 0.28);
    }
    meshes.push(plane);
    root.add(plane);
    host.add(root);
  }

  return {
    root,
    dispose: () => {
      host.remove(root);
      material.dispose();
      meshes.forEach((mesh) => {
        if (mesh.geometry !== asset.geometry) mesh.geometry.dispose();
      });
    },
  };
}
