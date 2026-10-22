"""Generate the Storage Porter extension icons.

Run from the project root:
    python tools/generate_icons.py
"""

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SIZE = 1024
ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "icons"


def diagonal_gradient(size: int, start: tuple[int, int, int], end: tuple[int, int, int]) -> Image.Image:
    y, x = np.mgrid[0:size, 0:size]
    position = (x + y) / (2 * (size - 1))
    eased = position**0.9
    channels = [
        (start[index] + (end[index] - start[index]) * eased).astype(np.uint8)
        for index in range(3)
    ]
    alpha = np.full((size, size), 255, dtype=np.uint8)
    return Image.fromarray(np.dstack([*channels, alpha]), "RGBA")


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def add_shadow(base: Image.Image, box: tuple[int, int, int, int], radius: int, alpha: int) -> None:
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(shadow)
    draw.rounded_rectangle(box, radius=radius, fill=(17, 24, 78, alpha))
    shadow = shadow.filter(ImageFilter.GaussianBlur(26))
    base.alpha_composite(shadow)


def build_icon() -> Image.Image:
    canvas = diagonal_gradient(SIZE, (99, 102, 241), (6, 145, 178))
    canvas.putalpha(rounded_mask(SIZE, 214))

    # Soft light pools give the flat gradient some depth.
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((-280, -360, 760, 520), fill=(255, 255, 255, 46))
    glow_draw.ellipse((620, 650, 1240, 1210), fill=(103, 232, 249, 54))
    glow = glow.filter(ImageFilter.GaussianBlur(70))
    canvas.alpha_composite(Image.composite(glow, Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0)), canvas.getchannel("A")))

    # Inner highlight along the top edge.
    border = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    border_draw = ImageDraw.Draw(border)
    border_draw.rounded_rectangle((7, 7, SIZE - 8, SIZE - 8), radius=208, outline=(255, 255, 255, 48), width=5)
    canvas.alpha_composite(border)

    top_box = (152, 212, 872, 400)
    bottom_box = (152, 624, 872, 812)
    add_shadow(canvas, (top_box[0], top_box[1] + 22, top_box[2], top_box[3] + 22), 94, 78)
    add_shadow(canvas, (bottom_box[0], bottom_box[1] + 22, bottom_box[2], bottom_box[3] + 22), 94, 78)

    white = (255, 255, 255, 247)
    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(top_box, radius=94, fill=white)
    draw.rounded_rectangle(bottom_box, radius=94, fill=white)

    # Storage "slots". The top row is indigo, the bottom row is cyan.
    slot_color_top = (79, 70, 229, 68)
    slot_color_bottom = (8, 145, 178, 64)
    for index in range(3):
        x0 = 210 + index * 82
        draw.rounded_rectangle((x0, 296, x0 + 58, 316), radius=10, fill=slot_color_top)
        draw.rounded_rectangle((x0, 708, x0 + 58, 728), radius=10, fill=slot_color_bottom)

    # Thick transfer arrow between the two storage rows.
    arrow = [
        (476, 438),
        (548, 438),
        (548, 534),
        (636, 534),
        (512, 612),
        (388, 534),
        (476, 534),
    ]
    add_shadow(canvas, (388, 454, 636, 626), 30, 70)
    draw = ImageDraw.Draw(canvas)
    draw.polygon(arrow, fill=(255, 255, 255, 255))

    # A small round status accent on the lower storage row.
    draw.ellipse((786, 682, 838, 734), fill=(103, 232, 249, 255))

    return canvas


def main() -> None:
    ICON_DIR.mkdir(parents=True, exist_ok=True)
    icon = build_icon()

    for size in (16, 32, 48, 128):
        resized = icon.resize((size, size), Image.Resampling.LANCZOS)
        resized.save(ICON_DIR / f"icon{size}.png", optimize=True)
        print(f"wrote icons/icon{size}.png")


if __name__ == "__main__":
    main()
