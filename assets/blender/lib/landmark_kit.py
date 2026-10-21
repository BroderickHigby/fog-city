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
