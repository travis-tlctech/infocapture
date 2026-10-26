"""Builds the app's icons and logo images from the TLC_TRNG brand masters in
brand/ (copied from Dropbox 2_TLC_TRNG/4_Branding/ds-bundle/guidelines/logos).
Run from the repo root: python3 scripts/make_assets.py (needs Pillow)."""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "brand"
ICONS = ROOT / "app" / "icons"
NAVY = (15, 37, 87)  # --tlc-navy #0F2557


def fit(image, size):
    return image.resize((size, size), Image.LANCZOS)


def on_navy(badge, size, scale):
    # The badge centred on a navy square: for launchers that crop icons to
    # their own shape (maskable, iOS), so the corners stay on brand.
    canvas = Image.new("RGBA", (size, size), NAVY + (255,))
    inner = round(size * scale)
    offset = (size - inner) // 2
    canvas.alpha_composite(fit(badge, inner), (offset, offset))
    return canvas


def make_icons():
    ICONS.mkdir(parents=True, exist_ok=True)
    badge = Image.open(BRAND / "tlc-trng-badge.png").convert("RGBA")
    # The badge is the approved mark for app icons and favicons.
    fit(badge, 192).save(ICONS / "icon-192.png", optimize=True)
    fit(badge, 512).save(ICONS / "icon-512.png", optimize=True)
    fit(badge, 64).save(ICONS / "favicon-64.png", optimize=True)
    # Maskable icons keep the artwork inside the central 80% circle.
    on_navy(badge, 512, 0.78).save(ICONS / "icon-maskable-512.png", optimize=True)
    # iOS rounds the corners itself and fills transparency with black.
    on_navy(badge, 180, 0.94).convert("RGB").save(ICONS / "apple-touch-icon.png", optimize=True)
    # The horizontal wordmark for the Settings sign-off, at twice its
    # 20 px display height.
    for variant in ("navy", "gray-white"):
        logo = Image.open(BRAND / f"tlc-trng-horizontal-{variant}.png").convert("RGBA")
        height = 40
        width = round(logo.width * height / logo.height)
        logo.resize((width, height), Image.LANCZOS).save(ICONS / f"tlc-trng-horizontal-{variant}.png", optimize=True)


if __name__ == "__main__":
    make_icons()
    print("icons written")
