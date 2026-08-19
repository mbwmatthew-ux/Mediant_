#!/usr/bin/env python3
"""
Trace a flat-coloured region of a reference image into an SVG path.

Why this exists
---------------
Hand-drawing an SVG from a design mockup means guessing at silhouettes, and the
guesses are wrong in ways that are obvious to the person who made the mockup and
invisible to the person who drew them. The home-screen mascot got redrawn as a
circle when the reference is an egg with large oval ear cups.

This derives the actual outline from the pixels instead: mask by colour, keep the
largest blob, walk its boundary, simplify, then smooth into cubic béziers.

Usage
-----
    python3 agent_workspace/trace_asset.py IMAGE --box X0 Y0 X1 Y1 \
        --color 60A890 [--tol 26] [--viewbox 200] [--preview out.png]

    # or segment by "darker than everything around it"
    python3 agent_workspace/trace_asset.py IMAGE --box … --dark 110

Prints a `d="…"` path in a viewBox whose width is --viewbox, so it can be pasted
straight into a component.
"""
import argparse, math, sys
import numpy as np
from PIL import Image
from scipy import ndimage


def build_mask(rgb, color=None, tol=26, dark=None):
    """Boolean mask of the target region, cleaned of speckle and pinholes."""
    if dark is not None:
        mask = rgb.astype(int).sum(axis=2) / 3 < dark
    else:
        target = np.array([int(color[i:i + 2], 16) for i in (0, 2, 4)], dtype=int)
        mask = np.sqrt(((rgb.astype(int) - target) ** 2).sum(axis=2)) < tol

    # Close pinholes (JPEG noise, the face drawn on top of the body) and drop
    # stray specks, or the boundary walk wanders into them.
    mask = ndimage.binary_closing(mask, np.ones((5, 5)))
    mask = ndimage.binary_fill_holes(mask)
    mask = ndimage.binary_opening(mask, np.ones((3, 3)))

    lab, n = ndimage.label(mask)
    if n == 0:
        sys.exit("no region matched — widen --tol or check --box/--color")
    sizes = ndimage.sum(mask, lab, range(1, n + 1))
    return lab == (int(np.argmax(sizes)) + 1)


def trace_boundary(mask):
    """Moore-neighbour boundary walk, clockwise, returning [(x, y), …]."""
    ys, xs = np.nonzero(mask)
    start = (int(xs[np.argmin(ys)]), int(ys.min()))   # topmost, then leftmost
    h, w = mask.shape

    def solid(x, y):
        return 0 <= x < w and 0 <= y < h and mask[y, x]

    # 8-neighbourhood, clockwise from "west"
    nbr = [(-1, 0), (-1, -1), (0, -1), (1, -1), (1, 0), (1, 1), (0, 1), (-1, 1)]
    contour, cur, back = [start], start, 0
    for _ in range(4 * mask.sum() + 8):
        found = False
        for k in range(8):
            i = (back + k) % 8
            nx, ny = cur[0] + nbr[i][0], cur[1] + nbr[i][1]
            if solid(nx, ny):
                # re-enter the search from just behind where we came in
                back = (i + 5) % 8
                cur = (nx, ny)
                contour.append(cur)
                found = True
                break
        if not found or (len(contour) > 3 and cur == start):
            break
    return contour


def _rdp_open(points, eps):
    """Ramer–Douglas–Peucker on an OPEN polyline."""
    if len(points) < 3:
        return points
    (x0, y0), (x1, y1) = points[0], points[-1]
    dx, dy = x1 - x0, y1 - y0
    norm = math.hypot(dx, dy)
    dmax, idx = 0.0, 0
    for i in range(1, len(points) - 1):
        px, py = points[i]
        # Degenerate baseline (endpoints coincide) — fall back to radial distance.
        d = (abs(dy * px - dx * py + x1 * y0 - y1 * x0) / norm) if norm > 1e-9 \
            else math.hypot(px - x0, py - y0)
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        return _rdp_open(points[:idx + 1], eps)[:-1] + _rdp_open(points[idx:], eps)
    return [points[0], points[-1]]


def rdp(points, eps):
    """
    RDP for a CLOSED contour.

    Running plain RDP over a closed ring collapses it to a single point: the
    first and last vertices are the same, so the baseline has zero length and
    every perpendicular distance measures as ~0. Split the ring at the vertex
    farthest from the start, simplify each half as an open polyline, and rejoin.
    """
    if len(points) < 4:
        return points
    if points[0] == points[-1]:
        points = points[:-1]
    x0, y0 = points[0]
    far = max(range(len(points)), key=lambda i: math.hypot(points[i][0] - x0, points[i][1] - y0))
    a = _rdp_open(points[:far + 1], eps)
    b = _rdp_open(points[far:] + [points[0]], eps)
    return a[:-1] + b[:-1]


def to_bezier(pts, tension=0.5):
    """Closed Catmull-Rom through the points, emitted as cubic béziers."""
    n = len(pts)
    d = [f"M{pts[0][0]:.1f},{pts[0][1]:.1f}"]
    for i in range(n):
        p0, p1 = pts[(i - 1) % n], pts[i]
        p2, p3 = pts[(i + 1) % n], pts[(i + 2) % n]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6 * tension, p1[1] + (p2[1] - p0[1]) / 6 * tension)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6 * tension, p2[1] - (p3[1] - p1[1]) / 6 * tension)
        d.append(f"C{c1[0]:.1f},{c1[1]:.1f} {c2[0]:.1f},{c2[1]:.1f} {p2[0]:.1f},{p2[1]:.1f}")
    return " ".join(d) + " Z"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--box", nargs=4, type=int, required=True, metavar=("X0", "Y0", "X1", "Y1"))
    ap.add_argument("--color")
    ap.add_argument("--dark", type=int)
    ap.add_argument("--tol", type=float, default=26)
    ap.add_argument("--viewbox", type=float, default=200)
    ap.add_argument("--eps", type=float, default=1.2, help="simplification, in source px")
    ap.add_argument("--preview", help="write the mask as a PNG to eyeball it")
    args = ap.parse_args()

    if not args.color and args.dark is None:
        sys.exit("give --color RRGGBB or --dark N")

    im = Image.open(args.image).convert("RGB").crop(tuple(args.box))
    mask = build_mask(np.asarray(im), args.color, args.tol, args.dark)

    if args.preview:
        Image.fromarray((mask * 255).astype(np.uint8)).save(args.preview)

    pts = rdp(trace_boundary(mask), args.eps)
    if pts[0] == pts[-1]:
        pts = pts[:-1]

    w = args.box[2] - args.box[0]
    scale = args.viewbox / w
    pts = [(x * scale, y * scale) for x, y in pts]

    h = (args.box[3] - args.box[1]) * scale
    print(f'viewBox="0 0 {args.viewbox:.0f} {h:.0f}"   ({len(pts)} anchors)')
    print(f'd="{to_bezier(pts)}"')


if __name__ == "__main__":
    main()
