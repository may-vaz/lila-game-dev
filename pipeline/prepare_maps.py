#!/usr/bin/env python3
"""
Downscale + re-encode the supplied minimaps for the web.

The raw minimaps are 4320x4320 PNG (9.7 MB), 2160x2158 PNG (2.9 MB) and
9000x9000 JPG (11.8 MB) - 24 MB of imagery that would make the tool feel
broken on first load. We emit 2048px WebP, which is plenty for a 1024-ish
CSS pixel canvas on a retina screen.

Note: the dataset README states the minimaps are 1024x1024. They are not.
Because the whole pipeline works in resolution-independent UV space, the
actual pixel size never matters - but anyone hardcoding 1024 would be wrong.

Run:
    python pipeline/prepare_maps.py --input ./player_data/minimaps --out ./web/public/maps
"""

import argparse
import os

from PIL import Image

Image.MAX_IMAGE_PIXELS = None

SOURCES = {
    "AmbroseValley": "AmbroseValley_Minimap.png",
    "GrandRift": "GrandRift_Minimap.png",
    "Lockdown": "Lockdown_Minimap.jpg",
}

TARGET = 2048


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--size", type=int, default=TARGET)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)

    for map_id, fname in SOURCES.items():
        src = os.path.join(args.input, fname)
        if not os.path.exists(src):
            print(f"  !! missing {src}")
            continue
        im = Image.open(src)
        orig = im.size
        orig_bytes = os.path.getsize(src)

        im = im.convert("RGBA")

        # Several source maps are non-square (GrandRift is 2160x2158) while the
        # UV projection assumes a square world footprint. Pad to square so UV
        # (0..1) maps onto the image without stretching the terrain.
        if im.size[0] != im.size[1]:
            side = max(im.size)
            canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
            canvas.paste(im, ((side - im.size[0]) // 2, (side - im.size[1]) // 2))
            im = canvas
            print(f"  {map_id}: padded {orig[0]}x{orig[1]} -> {side}x{side} (square)")

        im = im.resize((args.size, args.size), Image.LANCZOS)
        dst = os.path.join(args.out, f"{map_id}.webp")
        im.save(dst, "WEBP", quality=88, method=6)
        new_bytes = os.path.getsize(dst)
        print(f"  {map_id}: {orig[0]}x{orig[1]} {orig_bytes/1e6:.1f}MB "
              f"-> {args.size}x{args.size} {new_bytes/1e6:.2f}MB WebP "
              f"({100*(1-new_bytes/orig_bytes):.0f}% smaller)")


if __name__ == "__main__":
    main()
