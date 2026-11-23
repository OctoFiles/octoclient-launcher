#!/usr/bin/env python3
"""Bakes the mod's animated GIF capes into frame strips for the launcher.

The five animated capes are hand-written mod modules (`BUILTIN:CAPE:<name>`) and
therefore have no catalogue entry, so `build-cosmetic-assets.py` never saw
them. This script decodes each GIF with all of its frames, stacks the frames
vertically into one WebP strip and writes a manifest the launcher reads to play
the clip on the cape cloth.

    python scripts/build-animated-capes.py [--mod-dir DIR] [--out DIR]
"""

from __future__ import annotations

import argparse
import json
import math
import os

from PIL import Image

DEFAULT_MOD = r"E:\C\Neuer Ordner\octoclient"
DEFAULT_OUT = r"E:\der beste launcher der welt\public\cosmetics\capes-anim"

# Same files `ModuleManager` registers as `new Cape(<name>, <file>)`.
CAPES = {
    "Cloud": "68f25dab817305fac760fc8e.gif",
    "Galaxy": "68f25e6a817305fac760fed9.gif",
    "Shadow": "68f2800084c544a757d23ea1.gif",
    "Lightning": "68fe6fbe8ac4a645dc529ee7.gif",
    "Orbit": "6a236be691b47a1fbef95266.gif",
}

# Taller strips than this stop fitting into a single texture on low-end GPUs.
MAX_FRAMES = 32
MAX_EDGE = 320
THUMB_WIDTH = 160
# `Cape.STANDARD_TEXTURE_*` in the mod: the outer face of an animated cape.
CROP = (0.06, 0.08, 0.49, 0.96)


def frame_sequence(image: Image.Image) -> tuple[list[Image.Image], int]:
    """Decodes every composited frame and returns it with the average delay."""
    count = getattr(image, "n_frames", 1)
    step = max(1, math.ceil(count / MAX_FRAMES))
    frames: list[Image.Image] = []
    delays: list[int] = []
    for index in range(0, count, step):
        image.seek(index)
        frames.append(image.convert("RGBA"))
        delays.append(int(image.info.get("duration") or 100))
    # Subsampling frames stretches each one over the skipped time.
    delay = round(sum(delays) / len(delays)) * step
    return frames, max(20, delay)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mod-dir", default=DEFAULT_MOD)
    parser.add_argument("--out", default=DEFAULT_OUT)
    args = parser.parse_args()

    source_dir = os.path.join(
        args.mod_dir, "src", "main", "resources", "assets", "octoclient",
        "textures", "cosmetic", "capes",
    )
    os.makedirs(args.out, exist_ok=True)
    for name in os.listdir(args.out):
        os.remove(os.path.join(args.out, name))

    manifest: dict[str, dict[str, object]] = {}
    total = 0
    for module, file_name in CAPES.items():
        path = os.path.join(source_dir, file_name)
        if not os.path.exists(path):
            print("missing %s (%s)" % (module, path))
            continue
        with Image.open(path) as gif:
            frames, delay = frame_sequence(gif)

        width, height = frames[0].size
        scale = min(1.0, MAX_EDGE / max(width, height))
        frame_width = max(1, round(width * scale))
        frame_height = max(1, round(height * scale))
        strip = Image.new("RGBA", (frame_width, frame_height * len(frames)))
        for index, frame in enumerate(frames):
            strip.paste(frame.resize((frame_width, frame_height), Image.Resampling.LANCZOS),
                        (0, index * frame_height))

        slug = module.lower()
        strip_path = os.path.join(args.out, slug + ".webp")
        strip.save(strip_path, "WEBP", quality=88, method=6)
        total += os.path.getsize(strip_path)

        # The tile shows the cape face itself, not the whole render sheet.
        left = round(width * CROP[0])
        top = round(height * CROP[1])
        right = round(width * CROP[2])
        bottom = round(height * CROP[3])
        thumb = frames[0].crop((left, top, right, bottom))
        thumb_scale = THUMB_WIDTH / max(1, thumb.width)
        thumb = thumb.resize(
            (max(1, round(thumb.width * thumb_scale)), max(1, round(thumb.height * thumb_scale))),
            Image.Resampling.LANCZOS,
        )
        thumb_path = os.path.join(args.out, slug + "-thumb.webp")
        thumb.save(thumb_path, "WEBP", quality=90, method=6)
        total += os.path.getsize(thumb_path)

        manifest[module] = {
            "frames": len(frames),
            "delayMs": delay,
            "file": slug + ".webp",
            "thumb": slug + "-thumb.webp",
            "width": frame_width,
            "height": frame_height,
        }
        print("%-10s %2d frames  %4d ms  %dx%d" % (module, len(frames), delay,
                                                   frame_width, frame_height))

    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, separators=(",", ":"))

    print("capes: %d  %.1f MB" % (len(manifest), total / 1e6))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
