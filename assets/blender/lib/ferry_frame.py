"""Where the Ferry Building model sits, derived from the SF footprint. Pure Python (no bpy),
shared by the Blender model script and tools/landmarks.py so both agree exactly.

Frames:
  world   : src/geo/project.ts local metres, x east, z south, origin 37.7955, -122.3937.
  (u, v)  : u along the building's long axis (toward the south-east end), v toward the
            front (the Embarcadero / Market Street side, which faces the city to the west).
  model   : glTF model-local, x right, y up, z back (the front faces -z). Its origin is the
            clock tower's centre at ground level.
  blender : x right, y forward (= -model z), z up.

The footprint fixes the long axis, both facade lines and the central pavilion that projects
toward Market Street. It does not locate the tower; we centre it on the pavilion and set it
TOWER_SETBACK_M behind the pavilion front (a modelling choice from photographs).
"""

from __future__ import annotations

import json
import math
import os

# Same constants as src/geo/project.ts.
ORIGIN_LAT = 37.7955
ORIGIN_LON = -122.3937
M_PER_DEG_LAT = 110992.5853
M_PER_DEG_LON = 88075.7734

TOWER_SETBACK_M = 7.0

HERE = os.path.dirname(os.path.abspath(__file__))
FOOTPRINT_JSON = os.path.join(os.path.dirname(HERE), "data", "ferry-building-footprint.json")


def to_local(lat: float, lon: float) -> tuple[float, float]:
    return (lon - ORIGIN_LON) * M_PER_DEG_LON, -(lat - ORIGIN_LAT) * M_PER_DEG_LAT


def to_latlon(x: float, z: float) -> tuple[float, float]:
    return ORIGIN_LAT - z / M_PER_DEG_LAT, ORIGIN_LON + x / M_PER_DEG_LON


def bearing_of(dx: float, dz: float) -> float:
    """Compass bearing (degrees clockwise from north = -z) of a world direction."""
    return math.degrees(math.atan2(dx, -dz)) % 360.0


def dir_of(bearing_deg: float) -> tuple[float, float]:
    b = math.radians(bearing_deg)
    return math.sin(b), -math.cos(b)


def load_footprint(path: str = FOOTPRINT_JSON) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def outer_ring_world(doc: dict) -> list[tuple[float, float]]:
    shape = doc["record"]["shape"]
    coords = shape["coordinates"]
    if shape["type"] == "MultiPolygon":
        # The largest polygon's outer ring (the record also carries a sliver hole).
        coords = max(coords, key=lambda p: len(p[0]))
    ring = [to_local(lat, lon) for lon, lat in coords[0]]
    if ring[0] == ring[-1]:
        ring = ring[:-1]
    return ring


def frame(doc: dict | None = None) -> dict:
    doc = doc or load_footprint()
    ring = outer_ring_world(doc)

    # Long axis: the minimum-area bounding rectangle, searched in 0.05 degree steps.
    best = None
    for k in range(3600):
        b = k * 0.05
        ux, uz = dir_of(b)
        us = [x * ux + z * uz for x, z in ring]
        vs = [-x * uz + z * ux for x, z in ring]
        area = (max(us) - min(us)) * (max(vs) - min(vs))
        if best is None or area < best[0]:
            best = (area, b)
    axis = best[1]
    ux, uz = dir_of(axis)
    us = [x * ux + z * uz for x, z in ring]
    vs = [-x * uz + z * ux for x, z in ring]
    if max(vs) - min(vs) > max(us) - min(us):
        axis += 90.0  # the rectangle search is symmetric under 90 degrees; keep the long side
    axis %= 180.0
    # u points along the axis toward the south-east end; v is the perpendicular that faces
    # the city (west), which is the Embarcadero facade.
    cand = [(axis + 90.0) % 360.0, (axis + 270.0) % 360.0]
    front = min(cand, key=lambda b: dir_of(b)[0])  # most westward
    u_bearing = (front - 90.0) % 360.0
    ux, uz = dir_of(u_bearing)
    vx, vz = dir_of(front)

    uv = [(x * ux + z * uz, x * vx + z * vz) for x, z in ring]
    vmax = max(v for _, v in uv)
    vmin = min(v for _, v in uv)
    # Front facade line: the v carrying the most edge length on the front half.
    weight: dict[float, float] = {}
    n = len(uv)
    for i in range(n):
        (u0, v0), (u1, v1) = uv[i], uv[(i + 1) % n]
        if abs(v1 - v0) < 0.6 and abs(u1 - u0) > 3 and (v0 + v1) / 2 > (vmin + vmax) / 2:
            key = round((v0 + v1) / 2, 0)
            weight[key] = weight.get(key, 0.0) + abs(u1 - u0)
    v_facade = max(weight.items(), key=lambda kv: kv[1])[0]
    pav = [(u, v) for u, v in uv if v > v_facade + 2.0]
    u_p0 = min(u for u, _ in pav)
    u_p1 = max(u for u, _ in pav)
    u_t = (u_p0 + u_p1) / 2.0
    v_t = vmax - TOWER_SETBACK_M
    tx, tz = u_t * ux + v_t * vx, u_t * uz + v_t * vz
    lat, lon = to_latlon(tx, tz)

    def to_model(x: float, z: float) -> tuple[float, float]:
        u = x * ux + z * uz - u_t
        v = x * vx + z * vz - v_t
        # model x = right of the front = toward -u (north-west end); model z = back = -v.
        return -u, -v

    model_ring = [to_model(x, z) for x, z in ring]
    return {
        "heading_deg": front,
        "long_axis_deg": u_bearing,
        "tower_world": (tx, tz),
        "tower_lat": lat,
        "tower_lon": lon,
        "v_facade": v_facade - v_t,
        "v_pavilion": vmax - v_t,
        "v_back": vmin - v_t,
        "pavilion_u": (u_p0 - u_t, u_p1 - u_t),
        "u_range": (min(u for u, _ in uv) - u_t, max(u for u, _ in uv) - u_t),
        "model_ring": model_ring,
        "to_model": to_model,
        "bldg_id": doc["record"]["sf16_bldgid"],
        "lidar_peak_m": float(doc["record"]["hgt_maxcm"]) / 100.0,
    }


if __name__ == "__main__":
    f = frame()
    for k, v in f.items():
        if k in ("to_model",):
            continue
        if k == "model_ring":
            print("model_ring (x right, z back):")
            for x, z in v:
                print(f"  {x:8.2f} {z:8.2f}")
            continue
        print(k, v)
