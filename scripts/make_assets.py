"""Builds the app's icons and the TLC_TRNG wordmark images.
Run from the repo root: python3 scripts/make_assets.py (needs Pillow).

The app icon is InfoCapture's own glyph (scan corners around a contact card)
in the Snap card button's colours: TLC_TRNG neon cyan, glowing, on navy.
The wordmark images come from the brand masters in brand/."""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "brand"
ICONS = ROOT / "app" / "icons"
NAVY = (15, 37, 87)     # --tlc-navy #0F2557
CYAN = (111, 242, 255)  # --tlc-cyan #6FF2FF


def draw_glyph(s, pad):
    # Cyan corners and card, with the card's details cut out in navy.
    layer = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    span = s - 2 * pad
    w = max(2, int(s * 0.055))
    arm = span * 0.26
    x0, y0, x1, y1 = pad, pad, s - pad, s - pad
    for (cx, cy, dx, dy) in [(x0, y0, 1, 1), (x1, y0, -1, 1), (x0, y1, 1, -1), (x1, y1, -1, -1)]:
        d.line([(cx, cy + dy * arm), (cx, cy), (cx + dx * arm, cy)], fill=CYAN, width=w, joint="curve")
    cw, ch = span * 0.62, span * 0.42
    cx0, cy0 = s / 2 - cw / 2, s / 2 - ch / 2
    d.rounded_rectangle([cx0, cy0, cx0 + cw, cy0 + ch], radius=int(ch * 0.16), fill=CYAN)
    cut = NAVY + (255,)
    r = ch * 0.17
    pcx, pcy = cx0 + cw * 0.26, cy0 + ch * 0.4
    d.ellipse([pcx - r, pcy - r, pcx + r, pcy + r], fill=cut)
    d.rounded_rectangle([pcx - r * 1.7, pcy + r * 1.35, pcx + r * 1.7, pcy + r * 2.9], radius=int(r), fill=cut)
    lx = cx0 + cw * 0.5
    lh = max(2, int(ch * 0.09))
    for i, frac in enumerate([0.32, 0.55]):
        ly = cy0 + ch * frac
        d.rounded_rectangle([lx, ly, lx + cw * (0.38 if i == 0 else 0.28), ly + lh], radius=lh // 2, fill=cut)
    return layer


def draw_icon(size, maskable=False, rounded=True):
    scale = 4  # draw large, downsample for smooth edges
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable or not rounded:
        d.rectangle([0, 0, s, s], fill=NAVY)
    else:
        d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=NAVY)
    # Maskable icons keep the glyph inside the central safe zone.
    glyph = draw_glyph(s, s * (0.27 if maskable else 0.2))
    # The glow: a blurred copy of the cyan glyph under the sharp one.
    glow = glyph.filter(ImageFilter.GaussianBlur(s * 0.025))
    glow.putalpha(glow.getchannel("A").point(lambda a: int(a * 0.75)))
    mask = img.getchannel("A")
    img.alpha_composite(glow)
    img.alpha_composite(glyph)
    img.putalpha(mask)  # keep the glow inside the icon's own shape
    return img.resize((size, size), Image.LANCZOS)


def make_icons():
    ICONS.mkdir(parents=True, exist_ok=True)
    draw_icon(192).save(ICONS / "icon-192.png", optimize=True)
    draw_icon(512).save(ICONS / "icon-512.png", optimize=True)
    draw_icon(64).save(ICONS / "favicon-64.png", optimize=True)
    draw_icon(512, maskable=True).save(ICONS / "icon-maskable-512.png", optimize=True)
    # iOS applies its own corner mask, so the touch icon is square.
    draw_icon(180, rounded=False).convert("RGB").save(ICONS / "apple-touch-icon.png", optimize=True)
    # The horizontal TLC_TRNG wordmark for the Settings sign-off, at twice
    # its 20 px display height.
    for variant in ("navy", "gray-white"):
        logo = Image.open(BRAND / f"tlc-trng-horizontal-{variant}.png").convert("RGBA")
        height = 40
        width = round(logo.width * height / logo.height)
        logo.resize((width, height), Image.LANCZOS).save(ICONS / f"tlc-trng-horizontal-{variant}.png", optimize=True)


if __name__ == "__main__":
    make_icons()
    print("icons written")
