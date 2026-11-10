"""Rasterize the Fennec workspace mark to the PNG sizes the manifest ships.

Run from this directory:  python generate_icons.py
Geometry mirrors icon.svg (512-unit canvas) so the SVG and PNGs agree.
"""
from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
BG, ACCENT, GREEN = "#1a1a17", "#eca17d", "#b7c9a3"
S = 4  # supersampling factor on top of the 512 canvas
CANVAS = 512 * S


def draw(scale=1.0, rounded=True):
    image = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    if rounded:
        draw.rounded_rectangle((0, 0, CANVAS - 1, CANVAS - 1), radius=112 * S, fill=BG)
    else:
        draw.rectangle((0, 0, CANVAS, CANVAS), fill=BG)
    if scale != 1.0:
        inner = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
        mark = draw_mark()
        offset = int((CANVAS - CANVAS * scale) / 2)
        inner.alpha_composite(mark.resize((int(CANVAS * scale),) * 2, Image.LANCZOS), (offset, offset))
        image.alpha_composite(inner)
        return image
    image.alpha_composite(draw_mark())
    return image


def draw_mark():
    mark = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(mark)
    box = [(256 - 118) * S, (256 - 118) * S, (256 + 118) * S, (256 + 118) * S]
    draw.arc(box, start=0, end=270, fill=ACCENT, width=54 * S)
    for angle_x, angle_y in ((400, 256), (256, 138)):
        r = 27 * S
        draw.ellipse((angle_x * S - r, angle_y * S - r, angle_x * S + r, angle_y * S + r), fill=ACCENT)
    r = 20 * S
    draw.ellipse((362 * S - r, 150 * S - r, 362 * S + r, 150 * S + r), fill=GREEN)
    return mark


def save(name, size, *, rounded=True, scale=1.0):
    image = draw(scale=scale, rounded=rounded).resize((size, size), Image.LANCZOS)
    image.save(HERE / name, "PNG", optimize=True)
    print(f"{name}: {image.size[0]}x{image.size[1]}")


if __name__ == "__main__":
    save("icon-192.png", 192)
    save("icon-512.png", 512)
    save("icon-maskable-512.png", 512, rounded=False, scale=0.8)
    save("apple-touch-icon.png", 180, rounded=False)
