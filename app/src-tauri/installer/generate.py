"""Redraw the NSIS installer artwork from the app icon.

The installer bitmaps are derived from `icons/icon.png`, so they go stale the
moment the icon changes -- silently, because NSIS happily embeds whatever BMP
it finds. Keeping the generator beside its output means a new icon is one
command away from a matching installer instead of a thing to remember.

    python installer/generate.py     (run from src-tauri, needs Pillow)
"""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

HERE = Path(__file__).resolve().parent
ICON = HERE.parent / "icons" / "icon.png"

# Straight from styles.css, so the installer and the app read as one thing.
BASE = (11, 13, 12)  # --accent's backdrop: #0b0d0c
LIFT = (20, 26, 23)  # a touch of light at the top edge
INK = (244, 246, 245)  # --ink
INK_DIM = (155, 160, 158)  # --ink-dim, flattened: BMP carries no alpha
ACCENT = (29, 185, 84)  # --accent

FONTS = Path("C:/Windows/Fonts")


def font(name: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(FONTS / name), size)


def backdrop(width: int, height: int) -> Image.Image:
    """A vertical wash from `LIFT` down to `BASE`, like the app's scrim."""
    canvas = Image.new("RGB", (width, height), BASE)
    draw = ImageDraw.Draw(canvas)
    for y in range(height):
        t = y / max(1, height - 1)
        draw.line(
            [(0, y), (width, y)],
            fill=tuple(round(LIFT[i] + (BASE[i] - LIFT[i]) * t) for i in range(3)),
        )
    return canvas


def glow(canvas: Image.Image, cx: int, cy: int, radius: int) -> Image.Image:
    """A soft accent halo behind the icon, matching the album-art backdrop."""
    layer = Image.new("RGB", canvas.size, (0, 0, 0))
    ImageDraw.Draw(layer).ellipse(
        [cx - radius, cy - radius, cx + radius, cy + radius], fill=(9, 54, 27)
    )
    return ImageChops.add(canvas, layer.filter(ImageFilter.GaussianBlur(radius * 0.6)))


def icon(size: int) -> Image.Image:
    return Image.open(ICON).convert("RGBA").resize((size, size), Image.LANCZOS)


def wrap(text: str, face: ImageFont.FreeTypeFont, width: int) -> list[str]:
    lines: list[str] = []
    line = ""
    for word in text.split():
        candidate = f"{line} {word}".strip()
        if face.getlength(candidate) <= width or not line:
            line = candidate
        else:
            lines.append(line)
            line = word
    if line:
        lines.append(line)
    return lines


def header() -> Image.Image:
    """150x57, shown top-right of every page after the welcome screen."""
    canvas = backdrop(150, 57)
    art = icon(37)
    canvas.paste(art, (13, 10), art)
    ImageDraw.Draw(canvas).text(
        (60, 28), "Hakuro", font=font("seguisb.ttf", 17), fill=INK, anchor="lm"
    )
    # A hairline of accent along the bottom ties it to the app's controls.
    ImageDraw.Draw(canvas).rectangle([0, 55, 150, 57], fill=ACCENT)
    return canvas


def sidebar() -> Image.Image:
    """164x314, the left panel of the welcome and finish pages."""
    canvas = backdrop(164, 314)
    canvas = glow(canvas, 82, 104, 74)

    art = icon(98)
    canvas.paste(art, (33, 55), art)

    draw = ImageDraw.Draw(canvas)
    draw.text((82, 186), "Hakuro", font=font("seguisb.ttf", 23), fill=INK, anchor="mm")
    draw.rectangle([68, 204, 96, 206], fill=ACCENT)

    caption = font("segoeui.ttf", 11)
    y = 224
    for line in wrap("Original-language lyrics for whatever Spotify is playing.", caption, 132):
        draw.text((82, y), line, font=caption, fill=INK_DIM, anchor="mm")
        y += 16
    return canvas


if __name__ == "__main__":
    for name, image in (("header", header()), ("sidebar", sidebar())):
        image.save(HERE / f"{name}.bmp")
        # A PNG twin makes the result reviewable without opening the installer.
        image.save(HERE / f"{name}.png")
        print(f"{name}.bmp  {image.size[0]}x{image.size[1]}")
