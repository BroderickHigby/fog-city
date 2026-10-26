"""Trace the Palace lagoon's existing DEM basin; do not paint across raised paths.

Run from any directory with Python 3. This is render data only: the shared terrain
and simulation water/shore remain unchanged. The shoreline is the 1.48 m contour
of the committed DataSF terrain triangles, restricted to the Palace grounds.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "public/tiles/sf/t-10_-2.collider.json"
LEVEL = 1.48
g = json.loads(SOURCE.read_text())["ground"]


def point(x, z):
    return (g["x0"] + x * g["cellSizeM"],
            g["z0"] + z * g["cellSizeM"], g["heights"][z * g["nx"] + x])


def clipped(triangle):
    output = []
    for a, b in zip(triangle, triangle[1:] + triangle[:1]):
        if a[2] <= LEVEL:
            output.append(a)
        if (a[2] <= LEVEL) != (b[2] <= LEVEL):
            t = (LEVEL - a[2]) / (b[2] - a[2])
            output.append(tuple(a[i] + (b[i] - a[i]) * t for i in range(3)))
    return [(round(x, 6), round(z, 6)) for x, z, _ in output]


edges = set()
for z in range(g["nz"] - 1):
    for x in range(g["nx"] - 1):
        a, b, c, d = point(x, z), point(x + 1, z), point(x, z + 1), point(x + 1, z + 1)
        if not (-4870 <= a[0] < -4680 and -970 <= a[1] < -700):
            continue
        for tri in [[a, b, c], [b, d, c]]:
            poly = clipped(tri)
            for start, end in zip(poly, poly[1:] + poly[:1]):
                if start == end:
                    continue
                if (end, start) in edges:
                    edges.remove((end, start))
                else:
                    edges.add((start, end))

loops = []
while edges:
    start, cursor = min(edges)
    edges.remove((start, cursor))
    loop = [start]
    while cursor != start:
        loop.append(cursor)
        onward = sorted(e for e in edges if e[0] == cursor)
        if len(onward) != 1:
            raise ValueError(f"Open/ambiguous lagoon contour at {cursor}")
        edge = onward[0]
        edges.remove(edge)
        cursor = edge[1]
    loops.append(loop)


def area(loop):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(loop, loop[1:] + loop[:1])) / 2


ring = max(loops, key=lambda loop: abs(area(loop)))
# Remove redundant points on straight lattice edges, retaining contour corners.
ring = [b for a, b, c in zip(ring[-1:] + ring[:-1], ring, ring[1:] + ring[:1])
        if abs((b[0]-a[0])*(c[1]-b[1]) - (b[1]-a[1])*(c[0]-b[0])) > 1e-6]
out = {"id": "palace-lagoon", "world": "sf", "level": 1.5, "shoreContourM": LEVEL,
       "source": "Existing DataSF DEM basin in public/tiles/sf/t-10_-2.collider.json; regenerate with assets/blender/build_palace_lagoon.py.",
       "ring": ring}
(ROOT / "content/palace-lagoon.json").write_text(json.dumps(out, indent=2) + "\n")
print(f"Palace lagoon: {len(ring)} shore points, {abs(area(ring)):.1f} square metres")
