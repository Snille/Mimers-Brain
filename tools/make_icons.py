"""Turn icon.png into the assets the dashboard needs.

The source is a 1536x1536 sticker on a solid taupe background - far too big to
ship and wrong on a dark page. This flood-fills the background away from the
four corners (rather than matching the colour globally, which would also eat the
grey brain stem), crops to what is left, and writes the sizes the page uses.

    python make_icons.py <source.png> <output-dir>
"""

import sys
from pathlib import Path
from PIL import Image, ImageDraw

TOLERANCE = 60  # how far a pixel may drift from the corner colour and still count as background


def strip_background(im: Image.Image) -> Image.Image:
    im = im.convert("RGBA")
    w, h = im.size

    # Flood fill from every corner, painting the background magenta-with-zero-alpha
    # so we can find it again. ImageDraw.floodfill works on the image in place.
    marker = (255, 0, 255, 0)
    flat = im.copy()
    for xy in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)):
        ImageDraw.floodfill(flat, xy, marker, thresh=TOLERANCE)

    # Anything the fill reached becomes transparent; everything else is kept.
    out = Image.new("RGBA", (w, h))
    src, dst = im.load(), out.load()
    hit = flat.load()
    for y in range(h):
        for x in range(w):
            dst[x, y] = (0, 0, 0, 0) if hit[x, y] == marker else src[x, y]

    bbox = out.getbbox()
    return out.crop(bbox) if bbox else out


def square(im: Image.Image, pad_ratio: float = 0.04) -> Image.Image:
    """Centre on a transparent square with a little breathing room."""
    w, h = im.size
    side = int(max(w, h) * (1 + pad_ratio * 2))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    return canvas


def main() -> int:
    src, outdir = Path(sys.argv[1]), Path(sys.argv[2])
    outdir.mkdir(parents=True, exist_ok=True)

    im = square(strip_background(Image.open(src)))
    print(f"frilagd och beskuren till {im.size[0]}x{im.size[1]}")

    for name, size in (("icon-512.png", 512), ("icon-180.png", 180), ("icon-32.png", 32)):
        im.resize((size, size), Image.LANCZOS).save(outdir / name, optimize=True)
        print(f"  {name:14} {(outdir / name).stat().st_size / 1024:6.1f} kB")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
