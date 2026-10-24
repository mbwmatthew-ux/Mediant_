"""
Stage 2 of the visual score-reading validation harness: applies
synthetic degradation to Stage 1's clean rendered pages, modeling
confirmed real failure modes (EXIF rotation, perspective skew, uneven
lighting, blur/compression).

NOT part of the production Modal image. See
docs/superpowers/specs/2026-10-23-visual-score-reading-validation-harness-design.md
for the tier design (clean/mild/severe) and what each transform models.

Usage:
    python3 degrade_visual_corpus.py \\
        --corpus-dir /Users/matthewwu/.cache/mediant_validation/visual_corpus \\
        --seed 42
"""
import argparse
import io
import random
from pathlib import Path

from PIL import Image, ImageFilter


def rotate_no_exif(img: "Image.Image", degrees: float) -> "Image.Image":
    """
    Rotates the image's actual pixel content by `degrees`, with NO
    corrective EXIF orientation tag written — this is the exact failure
    shape of the real EXIF-orientation bug (a phone stores the photo
    sensor-native plus a rotation tag; the bug was that nothing applied
    the tag, so every pixel-axis-dependent step scanned the wrong axis).
    Here we skip the tag entirely rather than writing-then-not-applying
    one, which is a strictly harder case for the pipeline to recover
    from (it also has nothing to correct against) and matches the
    degraded corpus's purpose: stress-test the read, not the EXIF
    handling specifically.
    """
    rotated = img.rotate(degrees, expand=True, fillcolor="white")
    exif = rotated.getexif()
    exif.pop(274, None)  # 274 = Orientation tag; ensure it's absent, not just 1.
    return rotated


def perspective_warp(img: "Image.Image", corner_displacement_frac: float, rng: "random.Random") -> "Image.Image":
    """
    Applies a perspective transform that displaces each of the 4 corners
    by up to `corner_displacement_frac` of the image's width/height, in a
    random direction — simulating a phone held at a slight angle over a
    music stand (what dewarp_row exists to correct).
    """
    w, h = img.size
    dx = int(w * corner_displacement_frac)
    dy = int(h * corner_displacement_frac)

    def jitter(x, y):
        return x + rng.randint(-dx, dx), y + rng.randint(-dy, dy)

    # PIL's Image.QUAD expects corners in the order UL, LL, LR, UR. Passing
    # them in TL/TR/BR/BL order (clockwise) produces a bow-tie distortion
    # even at zero displacement, so this order is load-bearing.
    src = [(0, 0), (0, h), (w, h), (w, 0)]
    dst = [jitter(*p) for p in src]

    # `dst` is the quad in the SOURCE image that gets sampled to fill the
    # output rectangle.
    return img.transform((w, h), Image.QUAD, sum(dst, ()), fillcolor="white")


def lighting_gradient(img: "Image.Image", dark_factor: float, light_factor: float) -> "Image.Image":
    """
    Multiplies pixel brightness by a linear gradient from `dark_factor`
    (left edge) to `light_factor` (right edge) — simulating a photo taken
    under an angled light source or window, not a uniform exposure shift.
    """
    import numpy as np
    arr = np.asarray(img).astype(np.float32)
    w = arr.shape[1]
    gradient = np.linspace(dark_factor, light_factor, w).reshape(1, w, 1)
    arr = np.clip(arr * gradient, 0, 255).astype("uint8")
    return Image.fromarray(arr)


def gaussian_blur(img: "Image.Image", radius: float) -> "Image.Image":
    """Simulates an out-of-focus phone photo."""
    return img.filter(ImageFilter.GaussianBlur(radius=radius))


def recompress_jpeg(img: "Image.Image", quality: int) -> "Image.Image":
    """Round-trips the image through JPEG at `quality`, introducing real
    compression artifacts, then returns it decoded back to a PIL Image."""
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=quality)
    buf.seek(0)
    return Image.open(buf).convert("RGB")


def degrade_mild(img: "Image.Image", rng: "random.Random") -> "Image.Image":
    """
    Mild tier: small rotation (3-7 degrees, random sign), mild
    perspective warp (2% corner displacement), mild lighting gradient
    (0.85x-1.15x). Simulates a reasonably careful phone photo: slightly
    off-angle, slightly uneven lighting.
    """
    degrees = rng.uniform(3, 7) * rng.choice([-1, 1])
    img = rotate_no_exif(img, degrees)
    img = perspective_warp(img, corner_displacement_frac=0.02, rng=rng)
    img = lighting_gradient(img, dark_factor=0.85, light_factor=1.15)
    return img


def degrade_severe(img: "Image.Image", rng: "random.Random") -> "Image.Image":
    """
    Severe tier: larger rotation (15-25 degrees, random sign), with a
    25% chance of a full 90/180/270-degree rotation instead (the exact
    EXIF-bug shape, at full severity), stronger perspective warp (6%
    corner displacement), harsher lighting gradient (0.6x-1.3x), mild
    blur, and JPEG recompression at quality 60.
    """
    if rng.random() < 0.25:
        degrees = rng.choice([90, 180, 270])
    else:
        degrees = rng.uniform(15, 25) * rng.choice([-1, 1])
    img = rotate_no_exif(img, degrees)
    img = perspective_warp(img, corner_displacement_frac=0.06, rng=rng)
    img = lighting_gradient(img, dark_factor=0.6, light_factor=1.3)
    img = gaussian_blur(img, radius=1.5)
    img = recompress_jpeg(img, quality=60)
    return img


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus-dir", default="/Users/matthewwu/.cache/mediant_validation/visual_corpus")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    corpus_dir = Path(args.corpus_dir)
    clean_dir = corpus_dir / "clean"
    clean_pngs = sorted(clean_dir.glob("*.png"))
    if not clean_pngs:
        print(f"[degrade_visual_corpus] no clean PNGs found in {clean_dir} "
              f"— run build_visual_validation_corpus.py first")
        return 1

    for tier_name, tier_fn in [("mild", degrade_mild), ("severe", degrade_severe)]:
        tier_dir = corpus_dir / "degraded" / tier_name
        tier_dir.mkdir(parents=True, exist_ok=True)
        rng = random.Random(args.seed)
        for clean_path in clean_pngs:
            img = Image.open(clean_path)
            if img.mode == "RGBA":
                # The clean corpus's rendered PNGs are RGBA with a fully
                # TRANSPARENT background (alpha=0) whose underlying RGB is
                # (0, 0, 0), not (255, 255, 255) — it only *looks* white
                # because viewers composite transparency onto a white
                # canvas. A plain .convert("RGB") drops the alpha channel
                # and keeps that raw black RGB, turning the entire page
                # background solid black (confirmed: every pixel of a
                # real degraded output was (0, 0, 0)). Must flatten onto
                # an actual white background first.
                background = Image.new("RGB", img.size, (255, 255, 255))
                background.paste(img, mask=img.split()[3])
                img = background
            else:
                img = img.convert("RGB")
            degraded = tier_fn(img, rng)
            out_path = tier_dir / clean_path.name
            degraded.convert("RGB").save(out_path, format="PNG")
        print(f"[degrade_visual_corpus] {tier_name}: "
              f"{len(clean_pngs)} pages written to {tier_dir}")

    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
