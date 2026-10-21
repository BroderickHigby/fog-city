"""Shared helpers for the interim landmark models (Sutro Tower, the bridges, the hero landmarks).

Every landmark stands on data/landmark-sites.json (written by tools/landmark-sites.ts from the
sf world): its origin, heading, the collider records it replaces (footprints and heights in
the model frame) and the sim's ground around it. Nothing here opens the tiles.

Frames. The site file is in the glTF model frame: x right, y up, z back (the front faces -z).
Blender builds the same model with X right, Y forward (= -z), Z up; bl() converts. Heights
are metres above the sim's ground at the origin, which is where the renderer stands the model.
"""

from __future__ import annotations

import json
import math
import os

from mathutils import Matrix, Vector

import fc

SITES_JSON = os.path.join(fc.BLENDER_DIR, "data", "landmark-sites.json")
_SITES: dict | None = None


def site(site_id: str) -> dict:
    global _SITES
    if _SITES is None:
        with open(SITES_JSON, encoding="utf-8") as f:
            _SITES = {s["id"]: s for s in json.load(f)["sites"]}
    return _SITES[site_id]


def bl(mx: float, mz: float) -> tuple[float, float]:
    """glTF model frame (x right, z back) -> Blender plan (X right, Y forward)."""
    return (mx, -mz)


def record(s: dict, rid: str) -> dict:
    for r in s["records"]:
        if r["id"] == rid:
            return r
    raise KeyError(f"{s['id']}: no record {rid}")


def ring_bl(rec: dict) -> list[tuple[float, float]]:
    """A record's footprint in the Blender plan, counter-clockwise seen from above."""
    pts = [bl(x, z) for x, z in rec["footprint"]]
    a = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]
        x1, y1 = pts[(i + 1) % len(pts)]
        a += x0 * y1 - x1 * y0
    return pts if a > 0 else list(reversed(pts))


def ground(s: dict, X: float, Y: float) -> float:
    """The sim's ground under Blender plan point (X, Y), relative to the origin's ground."""
    g = s.get("grid")
    if g is None:
        return 0.0
    mx, mz = X, -Y
    n = len(g["values"])
    fx = (mx + g["half"]) / g["step"]
    fz = (mz + g["half"]) / g["step"]
    fx = min(max(fx, 0.0), n - 1.0)
    fz = min(max(fz, 0.0), n - 1.0)
    ix = min(int(math.floor(fx)), n - 2)
    iz = min(int(math.floor(fz)), n - 2)
    tx, tz = fx - ix, fz - iz
    v = g["values"]
    return (v[iz][ix] * (1 - tx) + v[iz][ix + 1] * tx) * (1 - tz) + (v[iz + 1][ix] * (1 - tx) + v[iz + 1][ix + 1] * tx) * tz


def profile_ground(s: dict, t: float) -> tuple[float, bool]:
    """Ground and water flag t metres ahead of the origin along the model's forward axis (Blender +Y)."""
    p = s["profile"]
    i = (t - p["from"]) / p["step"]
    i0 = int(math.floor(min(max(i, 0.0), len(p["ground"]) - 1.001)))
    f = min(max(i - i0, 0.0), 1.0)
    g = p["ground"][i0] * (1 - f) + p["ground"][i0 + 1] * f
    return g, bool(p["water"][int(round(min(max(i, 0.0), len(p["water"]) - 1)))])


# ---------------------------------------------------------------------------- road clearance
#
# The sim has no collider for landmark geometry, so a model must keep its solids off every road
# ribbon (the site's "roads", from roads.json) from the road up to CLEAR_M above it: a car or a
# walker would pass straight through anything drawn there. tests/assets/landmarks.test.ts
# checks every placed model against every ribbon.

CLEAR_M = 4.5  # the clearance the test asks for above a road
HEADROOM_M = 6.0  # what a portal over a road leaves (CLEAR_M plus a margin for the deck's eye)


def road_ribbons(s: dict):
    """(half width, [(X, Y, ground)...]) per road, in the Blender plan."""
    out = []
    for r in s.get("roads", []):
        pts = [(*bl(x, z), g) for (x, z), g in zip(r["points"], r["ground"])]
        out.append((r["widthM"] / 2, pts))
    return out


def _seg_rect_dist(ax: float, ay: float, bx: float, by: float, x0: float, y0: float, x1: float, y1: float) -> float:
    """Distance from segment a-b to the rectangle [x0, x1] x [y0, y1] (0 when they touch)."""
    # sample the segment densely enough for ribbons a few metres wide
    n = max(1, int(math.ceil(math.hypot(bx - ax, by - ay) / 0.25)))
    best = math.inf
    for k in range(n + 1):
        x = ax + (bx - ax) * k / n
        y = ay + (by - ay) * k / n
        dx = max(x0 - x, 0.0, x - x1)
        dy = max(y0 - y, 0.0, y - y1)
        best = min(best, math.hypot(dx, dy))
        if best == 0.0:
            break
    return best


def clear_of_roads(s: dict, x0: float, y0: float, x1: float, y1: float, margin: float = 1.0) -> bool:
    """Is the Blender-plan rectangle clear of every road ribbon (each widened by `margin`)?"""
    for hw, pts in road_ribbons(s):
        for (ax, ay, _), (bx, by, _) in zip(pts, pts[1:]):
            # quick reject on the segment's box
            if max(ax, bx) + hw + margin < x0 or min(ax, bx) - hw - margin > x1 or max(ay, by) + hw + margin < y0 or min(ay, by) - hw - margin > y1:
                continue
            if _seg_rect_dist(ax, ay, bx, by, x0, y0, x1, y1) < hw + margin:
                return False
    return True


def roads_across(s: dict, x0: float, y0: float, x1: float, y1: float, margin: float = 1.0):
    """The ribbons that reach into the rectangle (widened by `margin`): their X extent there,
    and the highest road ground under it. None when no ribbon does."""
    lo, hi, top = math.inf, -math.inf, -math.inf
    for hw, pts in road_ribbons(s):
        r = hw + margin
        for (ax, ay, ag), (bx, by, bg) in zip(pts, pts[1:]):
            if max(ax, bx) + r < x0 or min(ax, bx) - r > x1 or max(ay, by) + r < y0 or min(ay, by) - r > y1:
                continue
            n = max(1, int(math.ceil(math.hypot(bx - ax, by - ay) / 0.25)))
            for k in range(n + 1):
                x = ax + (bx - ax) * k / n
                y = ay + (by - ay) * k / n
                if x + r < x0 or x - r > x1 or y + r < y0 or y - r > y1:
                    continue
                lo, hi = min(lo, x - r), max(hi, x + r)
                top = max(top, ag + (bg - ag) * k / n)
    return None if lo == math.inf else (lo, hi, top)


def portal_block(mb: fc.MeshBuilder, s: dict, x0: float, y0: float, x1: float, y1: float, z0: float, z1: float, mat, margin: float = 1.0) -> None:
    """A solid block over [x0, x1] x [y0, y1] x [z0, z1], with a portal through it along Y over
    every road ribbon that reaches it: side walls outside the ribbons, and the mass above them
    from the highest road plus HEADROOM_M (none when that is above z1). Open underneath."""
    across = roads_across(s, x0, y0, x1, y1, margin)
    if across is None:
        mb.box(x0, y0, z0, x1, y1, z1, mat, skip=("-z",))
        return
    lo, hi, road_top = across
    lo, hi = max(lo, x0), min(hi, x1)
    if lo > x0:
        mb.box(x0, y0, z0, lo, y1, z1, mat, skip=("-z",))
    if hi < x1:
        mb.box(hi, y0, z0, x1, y1, z1, mat, skip=("-z",))
    soffit = road_top + HEADROOM_M
    if soffit < z1:
        mb.box(lo, y0, soffit, hi, y1, z1, mat)


def legs_clear(s: dict, y: float, x_in: float, w: float, x_max: float, margin: float = 1.0):
    """Leg positions (left X, right X) for a bent at Y: each w wide, as close to +-x_in as the
    road ribbons allow, at most x_max out; None when a side finds no room."""
    xs = []
    for sgn in (-1.0, 1.0):
        x = x_in
        while x <= x_max and not clear_of_roads(s, sgn * x - w / 2, y - w / 2, sgn * x + w / 2, y + w / 2, margin):
            x += 0.5
        if x > x_max:
            return None
        xs.append(sgn * x)
    return xs[0], xs[1]


def extrude_record(mb: fc.MeshBuilder, rec: dict, mat, top_mat=None, sink: float = 0.4, top: float | None = None) -> None:
    """Draw a collider record as the sim has it: its footprint from below its lowest ground
    (footY - sink) to its roof (topY, or `top`)."""
    z0 = rec["footY"] - sink
    z1 = rec["topY"] if top is None else top
    ring = ring_bl(rec)
    n = len(ring)
    for i in range(n):
        a, b = ring[i], ring[(i + 1) % n]
        mb.poly([(a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1)], mat)
    mb.poly([(x, y, z1) for x, y in ring], top_mat or mat)


def strut(mb: fc.MeshBuilder, p0, p1, w: float, mat, d: float | None = None, up=(0.0, 0.0, 1.0)) -> None:
    """A square (w x d) member from p0 to p1: 8 triangles of sides, no caps."""
    p0, p1 = Vector(p0), Vector(p1)
    axis = p1 - p0
    if axis.length < 1e-6:
        return
    a = axis.normalized()
    u = Vector(up)
    if abs(a.dot(u)) > 0.95:
        u = Vector((1.0, 0.0, 0.0)) if abs(a.x) < 0.9 else Vector((0.0, 1.0, 0.0))
    s1 = a.cross(u).normalized() * (w / 2)
    s2 = a.cross(s1).normalized() * ((d if d is not None else w) / 2)
    c0 = [p0 + s1 + s2, p0 - s1 + s2, p0 - s1 - s2, p0 + s1 - s2]
    c1 = [p1 + s1 + s2, p1 - s1 + s2, p1 - s1 - s2, p1 + s1 - s2]
    for i in range(4):
        j = (i + 1) % 4
        mb.poly_n([tuple(c0[i]), tuple(c0[j]), tuple(c1[j]), tuple(c1[i])], mat, tuple((c0[i] + c0[j]) / 2 - p0))


def box_on(mb: fc.MeshBuilder, cx: float, cy: float, z0: float, z1: float, sx: float, sy: float, rot: float, mat, skip=()) -> None:
    """An upright box centred on (cx, cy), rotated by `rot` radians about Z."""
    mb.push(Matrix.Translation((cx, cy, 0)) @ Matrix.Rotation(rot, 4, "Z"))
    mb.box(-sx / 2, -sy / 2, z0, sx / 2, sy / 2, z1, mat, skip)
    mb.pop()


def tube(mb: fc.MeshBuilder, pts, r: float, seg: int, mat, smooth: bool = True) -> None:
    """A tube of radius r along a polyline (sections perpendicular to the path, no caps)."""
    P = [Vector(p) for p in pts]
    secs = []
    for i, p in enumerate(P):
        t = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
        u = Vector((0.0, 0.0, 1.0))
        if abs(t.dot(u)) > 0.95:
            u = Vector((1.0, 0.0, 0.0))
        a = t.cross(u).normalized()
        b = t.cross(a).normalized()
        secs.append([tuple(p + (a * math.cos(2 * math.pi * k / seg) + b * math.sin(2 * math.pi * k / seg)) * r) for k in range(seg)])
    mb.loft(secs, mat, closed=True, smooth=smooth)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def smoothstep(e0: float, e1: float, x: float) -> float:
    t = min(max((x - e0) / (e1 - e0), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def bearing_dir(bearing_deg: float) -> tuple[float, float]:
    """A compass bearing as a Blender plan direction for a model with heading 0 (Y = north)."""
    b = math.radians(bearing_deg)
    return (math.sin(b), math.cos(b))


def report(name: str, s: dict) -> None:
    print(f"[fc] {name}: site {s['id']} at {s['lat']:.7f},{s['lon']:.7f} heading {s['headingDeg']}, ground {s['groundY']} m, replaces {len(s['replacesBuildingIds'])} records")
