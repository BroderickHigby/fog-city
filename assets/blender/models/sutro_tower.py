"""Sutro Tower (interim proxy) -> public/models/sutro-tower.glb

A three-legged lattice radio tower on the hill between Twin Peaks and Mount Sutro, built
from published dimensions (Wikipedia, "Sutro Tower": 297.8 m to the antenna tips; the legs
45.7 m apart at the base, 18.3 m at the waist, 30.5 m at the antenna triangle; the platform
232 m above the ground) and placed on the sf world's data (data/landmark-sites.json, site
"sutro-tower"): the crossarm beams the LiDAR footprints show fix the centre and the legs'
bearings (270, 30, 150). No logos, no text; red and white aviation bands.

It replaces the six records of the pipeline's sutro-tower probe and draws each one where the
sim has it, so the drawn tower base matches what the car and the walker collide with: the
three crossarm-shadow plinths (3 m concrete walls), the equipment building and two sheds.
The lattice itself is not a collider (the sim never reads landmark models).

Nodes:
  sutro_tower        root (extras fcLandmark "sutro-tower", topM)
    tower            legs, bracing, the waist ring, the crossarm and platform, three masts
    base             leg footings and the replaced records
    beacons          red aviation lights (light_status; nightLight)

Frame: origin on the ground at the centre of the base triangle; heading 0, so Blender +Y is
north and +X east. Budget: 12k triangles (it is always drawn: the landmark layer never culls).
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import fc  # noqa: E402
import landmark_kit as LK  # noqa: E402

BUDGET = 12_000
S = LK.site("sutro-tower")

LEG_BEARINGS = (270.0, 30.0, 150.0)
R_BASE = 45.7 / math.sqrt(3)  # 26.4 m circumradius
R_WAIST = 18.3 / math.sqrt(3)  # 10.6 m
R_TOP = 30.5 / math.sqrt(3)  # 17.6 m
Z_WAIST = 165.0
Z_XARM = 200.0  # the lower crossarm (yards)
Z_PLAT = 232.0  # the platform
Z_TIP = 297.8
FOOT_TOP = 2.5  # top of the concrete footings above the local ground
# The lowest bracing ties the legs 9 m above their feet, so the faces stand open over the
# ground: La Avanzada runs in under the east face to the equipment building, and the sim has
# no collider for the lattice (tests/assets/landmarks.test.ts, road clearance).
BOTTOM_TIE = 9.0

# Panel levels of the leg lattice (bands change colour at each level).
LEVELS = [0.0, 30.0, 60.0, 90.0, 120.0, 145.0, Z_WAIST, 183.0, Z_XARM, 216.0, Z_PLAT]


def radius(z: float) -> float:
    if z <= Z_WAIST:
        return LK.lerp(R_BASE, R_WAIST, z / Z_WAIST)
    return LK.lerp(R_WAIST, R_TOP, (z - Z_WAIST) / (Z_PLAT - Z_WAIST))


def leg_point(i: int, z: float) -> tuple[float, float, float]:
    dx, dy = LK.bearing_dir(LEG_BEARINGS[i])
    r = radius(z)
    return (dx * r, dy * r, z)


def leg_width(z: float) -> float:
    return LK.lerp(3.8, 2.4, z / Z_PLAT)


def build() -> None:
    fc.reset()
    red = fc.material("paint_aviation_red", "#b5372b", 0.55)
    white = fc.material("paint_aviation_white", "#e9e6df", 0.5)
    steel = fc.material("steel_grey", "#8d9297", 0.45, 0.6)
    deck = fc.material("deck_grey", "#6f7378", 0.7, 0.3)
    concrete = fc.material("concrete", "#b7b3aa", 0.85)
    stucco = fc.material("stucco_equipment", "#c9c3b5", 0.8)
    roof = fc.material("roof_dark", "#55585c", 0.8)
    beacon = fc.material("light_status", "#5a1010", 0.4, emission="#ff2a18", strength=1.0)

    root = fc.empty("sutro_tower")
    root["fcLandmark"] = "sutro-tower"
    root["topM"] = Z_TIP

    band = lambda k: red if k % 2 == 0 else white  # noqa: E731

    # ---- legs: banded square members between the panel levels, each foot on its footing
    tw = fc.MeshBuilder()
    for i in range(3):
        fx, fy, _ = leg_point(i, 0.0)
        g = LK.ground(S, fx, fy)
        for k in range(len(LEVELS) - 1):
            z0, z1 = LEVELS[k], LEVELS[k + 1]
            p0 = list(leg_point(i, z0))
            p1 = leg_point(i, z1)
            if k == 0:
                p0[2] = g + FOOT_TOP
            LK.strut(tw, p0, p1, leg_width(z0), band(k))
    # ---- bracing: on each face an X per panel and a Warren zig-zag inside it, rings at levels
    for i in range(3):
        j = (i + 1) % 3
        for k in range(len(LEVELS) - 1):
            z0, z1 = LEVELS[k], LEVELS[k + 1]
            a0, a1 = leg_point(i, z0), leg_point(i, z1)
            b0, b1 = leg_point(j, z0), leg_point(j, z1)
            if k == 0:
                z_tie = max(LK.ground(S, a0[0], a0[1]), LK.ground(S, b0[0], b0[1])) + BOTTOM_TIE
                a0 = leg_point(i, z_tie)
                b0 = leg_point(j, z_tie)
            m = band(k)
            LK.strut(tw, a0, b1, 0.8, m)
            LK.strut(tw, b0, a1, 0.8, m)
            # secondary lattice: three zig-zags between the diagonals' halves
            for q in range(3):
                t0, t1 = q / 3, (q + 1) / 3
                pa = [LK.lerp(a0[c], a1[c], t0) for c in range(3)]
                pb = [LK.lerp(b0[c], b1[c], t1) for c in range(3)]
                LK.strut(tw, pa, pb, 0.35, steel)
            LK.strut(tw, a0, b0, 0.7, steel)
        LK.strut(tw, leg_point(i, Z_PLAT), leg_point(j, Z_PLAT), 1.2, steel)

    # ---- the lower crossarm: yards out past the legs, a ring between them
    for i in range(3):
        dx, dy = LK.bearing_dir(LEG_BEARINGS[i])
        inner = leg_point(i, Z_XARM)
        outer = (dx * 24.0, dy * 24.0, Z_XARM)
        LK.strut(tw, inner, outer, 1.6, red, d=2.2)
        LK.strut(tw, (outer[0], outer[1], Z_XARM - 1.1), leg_point(i, Z_XARM - 14.0), 0.5, steel)
        j = (i + 1) % 3
        LK.strut(tw, inner, leg_point(j, Z_XARM), 1.4, white, d=1.8)

    # ---- the platform: a triangular deck between the leg tops, three arms out to 32 m, railing
    tri = [leg_point(i, Z_PLAT) for i in range(3)]
    tw.poly_n([(p[0], p[1], Z_PLAT + 0.6) for p in tri], deck, (0, 0, 1))
    tw.poly_n([(p[0], p[1], Z_PLAT - 0.9) for p in tri], deck, (0, 0, -1))
    for i in range(3):
        j = (i + 1) % 3
        a, b = tri[i], tri[j]
        tw.poly_n([(a[0], a[1], Z_PLAT - 0.9), (b[0], b[1], Z_PLAT - 0.9), (b[0], b[1], Z_PLAT + 0.6), (a[0], a[1], Z_PLAT + 0.6)], deck,
                  ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0))
        dx, dy = LK.bearing_dir(LEG_BEARINGS[i])
        LK.strut(tw, (dx * R_TOP, dy * R_TOP, Z_PLAT), (dx * 32.0, dy * 32.0, Z_PLAT), 2.2, white, d=2.6)
        LK.strut(tw, (dx * 32.0, dy * 32.0, Z_PLAT - 1.3), leg_point(i, Z_PLAT - 16.0), 0.6, steel)
        # railing posts along the platform edge
        LK.strut(tw, (a[0], a[1], Z_PLAT + 1.7), (b[0], b[1], Z_PLAT + 1.7), 0.12, steel)

    # ---- three antenna masts on the platform's corners, tapering, banded, with a tip
    mast_bands = [Z_PLAT, 248.0, 263.0, 278.0, 290.0]
    for i in range(3):
        x, y, _ = tri[i]
        for k in range(len(mast_bands) - 1):
            z0, z1 = mast_bands[k], mast_bands[k + 1]
            w0 = LK.lerp(2.6, 0.9, (z0 - Z_PLAT) / (290.0 - Z_PLAT))
            tw.push(fc.Matrix.Translation((x, y, 0)))
            tw.frustum([(-w0 / 2, -w0 / 2), (w0 / 2, -w0 / 2), (w0 / 2, w0 / 2), (-w0 / 2, w0 / 2)],
                       [(-w0 * 0.45, -w0 * 0.45), (w0 * 0.45, -w0 * 0.45), (w0 * 0.45, w0 * 0.45), (-w0 * 0.45, w0 * 0.45)],
                       z0, z1, band(k + 1), top=(k == len(mast_bands) - 2))
            tw.pop()
        tw.push(fc.Matrix.Translation((x, y, 0)))
        tw.cylinder(0.32, 290.0, Z_TIP - 0.4, 6, white, smooth=False)
        tw.pop()
    tw.build("tower", parent=root, sharp_angle=30)

    # ---- beacons: mast tips, platform arm ends, the crossarm, half way up each leg
    bc = fc.MeshBuilder()
    spots = []
    for i in range(3):
        x, y, _ = tri[i]
        spots.append((x, y, Z_TIP - 0.2, 0.55))
        dx, dy = LK.bearing_dir(LEG_BEARINGS[i])
        spots.append((dx * 32.0, dy * 32.0, Z_PLAT + 1.6, 0.6))
        spots.append((dx * 24.0, dy * 24.0, Z_XARM + 1.4, 0.6))
        lx, ly, lz = leg_point(i, 90.0)
        spots.append((lx + dx * 2.2, ly + dy * 2.2, lz, 0.6))
    for (x, y, z, r) in spots:
        bc.sphere((x, y, z), r, 8, 4, beacon, smooth=True)
    ob = bc.build("beacons", parent=root)
    ob["nightLight"] = True

    # ---- base: a concrete footing under each leg, and the replaced records as the sim has them
    bs = fc.MeshBuilder()
    for i in range(3):
        fx, fy, _ = leg_point(i, 0.0)
        g = LK.ground(S, fx, fy)
        rot = math.radians(90 - LEG_BEARINGS[i])
        LK.box_on(bs, fx, fy, g - 2.5, g + FOOT_TOP, 7.0, 7.0, rot, concrete, skip=("-z",))
    for rec in S["records"]:
        if rec["heightSource"] == "override":
            LK.extrude_record(bs, rec, concrete)  # the 3 m plinths under the crossarm beams
        else:
            LK.extrude_record(bs, rec, stucco, top_mat=roof)
    bs.build("base", parent=root, sharp_angle=40)

    fc.export_glb("sutro-tower.glb", BUDGET)


if __name__ == "__main__":
    LK.report("sutro-tower", S)
    build()
