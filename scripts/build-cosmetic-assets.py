#!/usr/bin/env python3
"""Bakes the mod's real cosmetic assets into the launcher's preview pack.

The in-game cosmetics are OBJ / MD5 meshes with PNG textures. This script
parses the catalog, merges every referenced mesh into a compact binary
(positions, UVs, indices) and re-encodes the textures as small WebP files, so
the launcher can render exactly what Minecraft renders.

    python scripts/build-cosmetic-assets.py [--mod-dir DIR] [--out DIR]

Defaults: the mod checkout is the Freebuff workspace beside the launcher.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import struct
import sys

from PIL import Image

DEFAULT_MOD = r"E:\C\Neuer Ordner\octoclient"
DEFAULT_OUT = r"E:\der beste launcher der welt\public\cosmetics"
MAX_TEXTURE_EDGE = 512
MESH_MAGIC = 0x3143454F  # "OEC1"

JOINT_RE = re.compile(r'"([^"]+)"\s+(-?\d+)\s+\(\s*([^)]*)\)\s+\(\s*([^)]*)\)')
VERT_RE = re.compile(r"vert\s+(\d+)\s+\(\s*([-\d.eE]+)\s+([-\d.eE]+)\s*\)\s+(.*)")
WEIGHT_RE = re.compile(r"weight\s+(\d+)\s+(\d+)\s+([-\d.eE]+)\s+\(\s*([^)]*)\)")
TRI_RE = re.compile(r"tri\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)")


def quat_rotate(qx: float, qy: float, qz: float, qw: float, vx: float, vy: float, vz: float):
    """Rotates a vector by a unit quaternion, matching MD5 weight baking."""
    tx = 2.0 * (qy * vz - qz * vy)
    ty = 2.0 * (qz * vx - qx * vz)
    tz = 2.0 * (qx * vy - qy * vx)
    return (
        vx + qw * tx + (qy * tz - qz * ty),
        vy + qw * ty + (qz * tx - qx * tz),
        vz + qw * tz + (qx * ty - qy * tx),
    )


def md5_mesh_blocks(text: str):
    """Triangles grouped per `mesh { ... }` block of an MD5 mesh file."""
    blocks = []
    current = None
    depth = 0
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("mesh") and line.endswith("{"):
            current = []
            depth = 1
            continue
        if current is None:
            continue
        if line.endswith("{"):
            depth += 1
        elif line == "}":
            depth -= 1
            if depth == 0:
                blocks.append(current)
                current = None
                continue
        match = TRI_RE.match(line)
        if match:
            current.append((int(match.group(2)), int(match.group(3)), int(match.group(4))))
    return [block for block in blocks if block]


def parse_md5(text: str):
    joints = []
    for match in JOINT_RE.finditer(text):
        position = [float(value) for value in match.group(3).split()]
        orientation = [float(value) for value in match.group(4).split()]
        joints.append((position, orientation + [0.0] * (4 - len(orientation))))

    verts = {}
    for match in VERT_RE.finditer(text):
        index = int(match.group(1))
        u = float(match.group(2))
        v = float(match.group(3))
        weights = [int(value) for value in match.group(4).split()]
        verts[index] = (u, v, weights)

    weights = {}
    for match in WEIGHT_RE.finditer(text):
        weights[int(match.group(1))] = (
            int(match.group(2)),
            float(match.group(3)),
            [float(value) for value in match.group(4).split()],
        )

    baked = {}
    for index, (u, v, weight_indices) in verts.items():
        x = y = z = 0.0
        for weight_index in weight_indices:
            joint_index, bias, local = weights[weight_index]
            position, orientation = joints[joint_index]
            rx, ry, rz = quat_rotate(*orientation, *local)
            x += bias * (position[0] + rx)
            y += bias * (position[1] + ry)
            z += bias * (position[2] + rz)
        baked[index] = ((x, y, z), (u, v))

    parts = []
    for block in md5_mesh_blocks(text):
        positions = []
        uvs = []
        remap = {}
        indices = []
        for triangle in block:
            for vertex_index in triangle:
                if vertex_index not in remap:
                    remap[vertex_index] = len(positions)
                    position, uv = baked[vertex_index]
                    positions.append(position)
                    uvs.append(uv)
                indices.append(remap[vertex_index])
        parts.append((positions, uvs, indices))
    return parts


def parse_obj(text: str):
    source_positions = []
    source_uvs = []
    positions = []
    uvs = []
    indices = []
    remap = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("v "):
            parts = line.split()
            source_positions.append((float(parts[1]), float(parts[2]), float(parts[3])))
        elif line.startswith("vt "):
            parts = line.split()
            source_uvs.append((float(parts[1]), float(parts[2])))
        elif line.startswith("f "):
            corners = []
            for corner in line.split()[1:]:
                bits = corner.split("/")
                vertex = int(bits[0])
                vertex = vertex - 1 if vertex > 0 else len(source_positions) + vertex
                uv = -1
                if len(bits) > 1 and bits[1]:
                    value = int(bits[1])
                    uv = value - 1 if value > 0 else len(source_uvs) + value
                corners.append((vertex, uv))
            for i in range(1, len(corners) - 1):
                for vertex, uv in (corners[0], corners[i], corners[i + 1]):
                    key = (vertex, uv)
                    if key not in remap:
                        remap[key] = len(positions)
                        positions.append(source_positions[vertex])
                        uvs.append(source_uvs[uv] if 0 <= uv < len(source_uvs) else (0.0, 0.0))
                    indices.append(remap[key])
    return [(positions, uvs, indices)]


def load_mesh(path: str):
    with open(path, "r", encoding="utf-8", errors="ignore") as handle:
        text = handle.read()
    if path.lower().endswith(".md5mesh"):
        return parse_md5(text)
    return parse_obj(text)


def merge(parts):
    positions = []
    uvs = []
    indices = []
    offset = 0
    for part_positions, part_uvs, part_indices in parts:
        positions.extend(part_positions)
        uvs.extend(part_uvs)
        indices.extend(index + offset for index in part_indices)
        offset += len(part_positions)
    return positions, uvs, indices


def write_mesh(path: str, positions, uvs, indices):
    with open(path, "wb") as handle:
        handle.write(struct.pack("<IIII", MESH_MAGIC, 1, len(positions), len(indices)))
        handle.write(struct.pack("<%df" % (len(positions) * 3), *[c for p in positions for c in p]))
        handle.write(struct.pack("<%df" % (len(uvs) * 2), *[c for uv in uvs for c in uv]))
        handle.write(struct.pack("<%dI" % len(indices), *indices))


def bake_texture(source: str, target: str):
    image = Image.open(source)
    if image.mode != "RGBA":
        image = image.convert("RGBA")
    longest = max(image.width, image.height)
    if longest > MAX_TEXTURE_EDGE:
        scale = MAX_TEXTURE_EDGE / longest
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.Resampling.LANCZOS,
        )
    image.save(target, "WEBP", quality=90, method=6)


def short_hash(value: str) -> str:
    return hashlib.sha1(value.encode("utf-8")).hexdigest()[:16]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mod-dir", default=DEFAULT_MOD)
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args()

    root = os.path.join(args.mod_dir, "src", "main", "resources", "assets", "octoclient")
    asset_root = os.path.join(root, "textures", "cosmetics")
    with open(os.path.join(root, "cosmetics", "catalog.json"), encoding="utf-8") as handle:
        catalog = json.load(handle)["items"]

    textures_dir = os.path.join(args.out, "tex")
    meshes_dir = os.path.join(args.out, "mesh")
    os.makedirs(textures_dir, exist_ok=True)
    os.makedirs(meshes_dir, exist_ok=True)
    for folder in (textures_dir, meshes_dir):
        for name in os.listdir(folder):
            os.remove(os.path.join(folder, name))

    texture_names = {}
    mesh_names = {}
    manifest = {}
    texture_bytes = 0
    mesh_bytes = 0
    skipped = []

    for item in catalog:
        key = "%s:%s" % (item["type"], item["id"])
        texture = item.get("texture") or ""
        texture_path = os.path.join(asset_root, texture)
        if not texture or not os.path.exists(texture_path):
            skipped.append(key)
            continue
        if texture not in texture_names:
            name = short_hash(texture) + ".webp"
            target = os.path.join(textures_dir, name)
            bake_texture(texture_path, target)
            texture_bytes += os.path.getsize(target)
            texture_names[texture] = name

        model_paths = item.get("modelPaths") or []
        mesh_name = None
        if model_paths:
            mesh_key = "|".join(model_paths)
            if mesh_key not in mesh_names:
                existing = [os.path.join(asset_root, path) for path in model_paths]
                if all(os.path.exists(path) for path in existing):
                    try:
                        parts = []
                        for path in existing:
                            parts.extend(load_mesh(path))
                        positions, uvs, indices = merge(parts)
                        name = short_hash(mesh_key) + ".bin"
                        target = os.path.join(meshes_dir, name)
                        write_mesh(target, positions, uvs, indices)
                        mesh_bytes += os.path.getsize(target)
                        mesh_names[mesh_key] = name
                    except Exception as error:  # noqa: BLE001 - report and keep going
                        print("mesh failed: %s (%s)" % (mesh_key, error), file=sys.stderr)
                        mesh_names[mesh_key] = None
                else:
                    mesh_names[mesh_key] = None
            mesh_name = mesh_names[mesh_key]

        manifest[key] = {
            "t": texture_names[texture],
            "m": mesh_name,
            "s": item.get("scale", 1.0),
            "x": item.get("translationX", 0.0),
            "y": item.get("translationY", 0.0),
            "z": item.get("translationZ", 0.0),
            "f": bool(item.get("flipUVs")),
            "d": item.get("type"),
            "p": model_paths[0] if model_paths else None,
        }

    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump({"items": manifest}, handle, separators=(",", ":"))

    print(
        "items: %d  textures: %d (%.1f MB)  meshes: %d (%.1f MB)  skipped: %d"
        % (
            len(manifest),
            len(texture_names),
            texture_bytes / 1e6,
            len([name for name in mesh_names.values() if name]),
            mesh_bytes / 1e6,
            len(skipped),
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
