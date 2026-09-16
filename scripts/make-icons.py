#!/usr/bin/env python3
"""Generate the Zyvro Studio application icons.

The web app's mark is a white Z with a gradient node, on a transparent
background. That is right for a page and wrong for an app icon: a white glyph
on transparency vanishes against a light dock or a light Windows taskbar. So
the desktop icon puts the same mark on a dark tile, which is also what both
platforms expect an application icon to be.

The mark itself is not redrawn. It is composited from the brand PNG, so the
letterform stays exactly the one the rest of the product uses.

Run it only when the artwork changes; the results are committed.

    python3 scripts/make-icons.py

Requires Pillow, plus iconutil (macOS) for the .icns.
"""

from __future__ import annotations

import math
import shutil
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageOps

HERE = Path(__file__).resolve().parent
DESKTOP = HERE.parent
BRAND = DESKTOP.parent / "Zyvro-frontend" / "public" / "brand" / "icon-512x512.png"
OUT = DESKTOP / "resources"

# Drawn at 4x and downsampled, so every curve and edge ends up antialiased
# without hand-rolling any of it.
SUPERSAMPLE = 4
SIZE = 1024

# The palette is the app's own: the tile is the editor's background, a little
# lighter at the top so the icon has a light source.
TOP = (24, 24, 32)
BOTTOM = (9, 9, 14)
RIM = (255, 255, 255, 20)
GLOW = (99, 91, 255)


def squircle_mask(size: int, radius: int) -> Image.Image:
    """A rounded-rectangle mask. macOS uses a continuous corner rather than a
    circular one, which is why the radius here is larger than it looks: an
    ordinary rounded rectangle needs more radius to read as the same shape."""
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return mask


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    base = Image.new("RGB", (1, size))
    pixels = base.load()
    for y in range(size):
        t = y / max(size - 1, 1)
        # Eased rather than linear: a straight ramp on a near-black tile bands
        # visibly, and the eye reads the easing as a softer light.
        t = t * t * (3 - 2 * t)
        pixels[0, y] = tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return base.resize((size, size), Image.NEAREST)


def radial_glow(size: int, center: tuple[float, float], radius: float, color: tuple[int, int, int], peak: int) -> Image.Image:
    """A soft coloured bloom behind the node, so the tile is not flatly black."""
    glow = Image.new("L", (size, size), 0)
    pixels = glow.load()
    cx, cy = center
    for y in range(size):
        for x in range(size):
            d = math.hypot(x - cx, y - cy) / radius
            if d >= 1:
                continue
            pixels[x, y] = round(peak * (1 - d) ** 2)
    layer = Image.new("RGBA", (size, size), color + (0,))
    layer.putalpha(glow.filter(ImageFilter.GaussianBlur(size / 24)))
    return layer


def build_tile(size: int, radius_ratio: float, inset_ratio: float, glyph_ratio: float) -> Image.Image:
    """One icon at one shape. radius_ratio and inset_ratio are what differ
    between platforms: macOS wants a heavily rounded tile floating inside
    transparent padding, Windows wants the artwork closer to the edges."""
    s = size * SUPERSAMPLE
    inset = round(s * inset_ratio)
    tile_size = s - inset * 2
    radius = round(tile_size * radius_ratio)

    tile = vertical_gradient(tile_size, TOP, BOTTOM).convert("RGBA")

    node_center = (tile_size * 0.62, tile_size * 0.55)
    tile.alpha_composite(radial_glow(tile_size, node_center, tile_size * 0.62, GLOW, 62))

    # A hairline rim keeps the tile from dissolving into a dark background,
    # which is exactly where a near-black icon is hardest to see.
    ImageDraw.Draw(tile).rounded_rectangle(
        [0, 0, tile_size - 1, tile_size - 1],
        radius=radius,
        outline=RIM,
        width=max(2, round(tile_size / 320)),
    )

    glyph = Image.open(BRAND).convert("RGBA")
    glyph = glyph.crop(glyph.getbbox())
    target_w = round(tile_size * glyph_ratio)
    target_h = round(glyph.height * target_w / glyph.width)
    glyph = glyph.resize((target_w, target_h), Image.LANCZOS)
    # The brand file is 512px and the tile is drawn at 4096, so the mark is
    # enlarged and Lanczos leaves the edges slightly soft. A light unsharp pass
    # on the alpha alone restores the crispness of the letterform without
    # touching the gradient in the node.
    r, g, b, a = glyph.split()
    a = a.filter(ImageFilter.UnsharpMask(radius=target_w / 180, percent=90, threshold=0))
    a = ImageOps.autocontrast(a, cutoff=0)
    glyph = Image.merge("RGBA", (r, g, b, a))

    # The mark carries more weight low and left, so centring it on geometry
    # alone leaves it looking like it has slipped down the tile.
    x = round((tile_size - target_w) / 2)
    y = round((tile_size - target_h) / 2 - tile_size * 0.012)
    tile.alpha_composite(glyph, (x, y))

    tile.putalpha(squircle_mask(tile_size, radius))

    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.alpha_composite(tile, (inset, inset))
    return canvas.resize((size, size), Image.LANCZOS)


def write_icns(master: Image.Image, target: Path) -> None:
    iconset = OUT / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir(parents=True)
    # The names are a fixed contract with iconutil; anything else is ignored.
    for px in (16, 32, 128, 256, 512):
        master.resize((px, px), Image.LANCZOS).save(iconset / f"icon_{px}x{px}.png")
        master.resize((px * 2, px * 2), Image.LANCZOS).save(iconset / f"icon_{px}x{px}@2x.png")
    subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(target)], check=True)
    shutil.rmtree(iconset)


def main() -> int:
    if not BRAND.exists():
        print(f"Cannot find the brand mark at {BRAND}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)

    # macOS: the artwork sits inside transparent padding and the system draws
    # no shape of its own, so the tile has to be the squircle.
    mac = build_tile(SIZE, radius_ratio=0.225, inset_ratio=0.085, glyph_ratio=0.60)
    mac.save(OUT / "icon.png")
    if shutil.which("iconutil"):
        write_icns(mac, OUT / "icon.icns")
    else:
        print("iconutil not found, skipping the .icns", file=sys.stderr)

    # Windows: taskbar and Explorer give an icon less room, so the tile fills
    # more of the canvas and the corners are tighter.
    win = build_tile(SIZE, radius_ratio=0.18, inset_ratio=0.02, glyph_ratio=0.62)
    win.save(
        OUT / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )

    print(f"Wrote {OUT/'icon.png'}, {OUT/'icon.icns'} and {OUT/'icon.ico'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
