"""Interim shapes for the hero landmarks, until their full models land (roadmap waves 3-7):

  600-montgomery.glb       the pyramid tower at 600 Montgomery St (tapered, wings, spire)
  coit-tower.glb           Coit Tower: a 64 m fluted column with its arcade and base building
  city-hall.glb            City Hall: the block with pilasters, the colonnaded drum and dome
  palace-of-fine-arts.glb  the rotunda: eight piers, arches, the drum and dome
  grace-cathedral.glb      Grace Cathedral: nave and transept roofs, twin towers, fleche
  dragon-gate.glb          the gate over Grant Ave at Bush St (a prop: no record)
  sutro-baths.glb          the Sutro Baths ruins at Lands End (no record)
  mission-dolores.glb      the basilica as the probe has it: stucco body, tile roof, a stepped
                           Mission Revival front, the domed drum where the LiDAR finds 39 m
  conservatory-of-flowers.glb  the glasshouse on its record, the glazed dome over the centre

Each stands on data/landmark-sites.json. Where the landmark has collider records (the
pipeline's probe records), the model replaces exactly those records in the renderer and is
drawn over their footprints, so nothing the sim collides with is left undrawn: the lower part
of each model is the record's own footprint, extruded. None of them carries an office window
grid: stone, concrete, copper and tile, with a few dark openings (arches, lancets).

No text anywhere: the Dragon Gate's plaque is blank, no signs, no names.
Night: floodlit surfaces use the light_tower_outline level, beacons light_status.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

from mathutils import Matrix  # noqa: E402

import fc  # noqa: E402
import landmark_kit as LK  # noqa: E402

BUDGETS = {
    "600-montgomery.glb": 4_000,
    "coit-tower.glb": 8_000,
    "city-hall.glb": 16_000,
    "palace-of-fine-arts.glb": 12_000,
    "grace-cathedral.glb": 12_000,
    "dragon-gate.glb": 6_000,
    "sutro-baths.glb": 6_000,
    "mission-dolores.glb": 6_000,
    "conservatory-of-flowers.glb": 8_000,
}


def root(name: str, site_id: str, **extras):
    r = fc.empty(name)
    r["fcLandmark"] = site_id
    r["interim"] = True
    for k, v in extras.items():
        r[k] = v
    return r


def banded_walls(mb: fc.MeshBuilder, rec: dict, bands, sink: float = 0.4, top_mat=None) -> None:
    """The record's footprint as walls in horizontal bands [(z1, mat), ...] from footY - sink up."""
    ring = LK.ring_bl(rec)
    z = rec["footY"] - sink
    n = len(ring)
    for (z1, mat) in bands:
        for i in range(n):
            a, b = ring[i], ring[(i + 1) % n]
            mb.poly([(a[0], a[1], z), (b[0], b[1], z), (b[0], b[1], z1), (a[0], a[1], z1)], mat)
        z = z1
    if top_mat is not None:
        mb.poly([(x, y, z) for x, y in ring], top_mat)


def pilasters(mb: fc.MeshBuilder, rec: dict, z0: float, z1: float, every: float, mat, min_edge: float = 12.0, w: float = 1.2, d: float = 0.6) -> None:
    """Shallow pilasters along every long wall of the record's footprint."""
    ring = LK.ring_bl(rec)
    for i in range(len(ring)):
        (ax, ay), (bx, by) = ring[i], ring[(i + 1) % len(ring)]
        L = math.hypot(bx - ax, by - ay)
        if L < min_edge:
            continue
        ux, uy = (bx - ax) / L, (by - ay) / L
        nx, ny = uy, -ux  # outward for a counter-clockwise ring
        k = int(L // every)
        for j in range(1, k + 1):
            t = j * L / (k + 1)
            cx, cy = ax + ux * t + nx * d / 2, ay + uy * t + ny * d / 2
            LK.box_on(mb, cx, cy, z0, z1, w, d, math.atan2(uy, ux), mat, skip=("-z",))


# ============================================================================ 600 Montgomery

def montgomery() -> None:
    s = LK.site("600-montgomery")
    fc.reset()
    white = fc.material("precast_white", "#e7e3da", 0.55)
    shade = fc.material("precast_shade", "#c9c4ba", 0.6)
    glass = fc.material("glass_dark", "#3a4248", 0.25, 0.4)
    lt = fc.material("light_tower_outline", "#e7e3da", 0.5, emission="#fff2d8", strength=1.0)
    beacon = fc.material("light_status", "#5a1010", 0.4, emission="#ff2a18", strength=1.0)
    r = root("pyramid_tower", "600-montgomery", topM=260.0)
    cx, cy = LK.bl(*s["extra"]["baseCentre"])
    half0 = 26.5  # 53 m square base
    z_top, half_top = 212.0, 7.0
    mb = fc.MeshBuilder()
    # the plaza plinth on the podium record's footprint (what the sim collides with at street level)
    banded_walls(mb, LK.record(s, "201006.0000687"), [(1.0, shade)], top_mat=shade)
    mb.push(Matrix.Translation((cx, cy, 0)))
    sq = lambda h: [(-h, -h), (h, -h), (h, h), (-h, h)]  # noqa: E731
    # the base: a dark recessed ground storey under the first floor's trusses
    mb.frustum(sq(half0 - 1.5), sq(half0 - 1.5), -1.0, 6.0, glass, top=False)
    mb.frustum(sq(half0), sq(half0 - (half0 - half_top) * 6.0 / z_top), 6.0, 8.0, shade, top=False)
    h8 = half0 - (half0 - half_top) * 8.0 / z_top
    mb.frustum(sq(h8), sq(half_top), 8.0, z_top, white, top=True)
    # the spire
    mb.frustum(sq(5.0), sq(0.25), z_top, 258.0, white, top=False)
    mb.cylinder(0.18, 258.0, 260.0, 6, white, smooth=False)
    # wings: elevators east (+X), stairs west, from the 29th floor up past the top floor
    z_w = 122.0
    hw = half0 - (half0 - half_top) * z_w / z_top
    mb.box(0.0, -4.6, z_w, hw, 4.6, 222.0, white)
    mb.box(-hw, -3.6, z_w, 0.0, 3.6, 220.0, white)
    # the sloping faces carry no window grid: four shaded recess lines up each face's middle
    for k in range(4):
        rot = Matrix.Rotation(k * math.pi / 2, 4, "Z")
        mb.push(rot)
        for off in (-0.5, 0.5):
            mb.poly_n([(off * 2.0 - 0.3, -h8 - 0.03, 8.0), (off * 2.0 + 0.3, -h8 - 0.03, 8.0), (off * 2.0 + 0.3, -half_top - 0.03, z_top - 2), (off * 2.0 - 0.3, -half_top - 0.03, z_top - 2)], shade, (0, -1, 0.1))
        mb.pop()
    mb.pop()
    mb.build("tower", parent=r, sharp_angle=30)
    li = fc.MeshBuilder()
    li.push(Matrix.Translation((cx, cy, 0)))
    for k in range(4):
        a = k * math.pi / 2 + math.pi / 4
        ex, ey = math.cos(a), math.sin(a)
        LK.strut(li, (ex * 5.0 * 1.414, ey * 5.0 * 1.414, z_top + 0.2), (ex * 0.4, ey * 0.4, 257.5), 0.35, lt)
    li.sphere((0, 0, 260.3), 0.5, 8, 4, beacon)
    li.pop()
    ob = li.build("spire_lights", parent=r)
    ob["nightLight"] = True
    fc.export_glb("600-montgomery.glb", BUDGETS["600-montgomery.glb"])


# ============================================================================ Coit Tower

COIT_TOP = 64.0


def coit() -> None:
    s = LK.site("coit-tower")
    fc.reset()
    concrete = fc.material("light_tower_outline", "#d9d0bf", 0.75, emission="#4c4436", strength=1.0)  # floodlit at night
    base_mat = fc.material("concrete_base", "#cfc6b4", 0.8)
    roof = fc.material("roof_flat", "#8d877c", 0.85)
    dark = fc.material("arcade_shadow", "#2f2c28", 0.9)
    r = root("coit_tower", "coit-tower", topM=COIT_TOP)
    base = LK.record(s, "201006.0006230")
    mb = fc.MeshBuilder()
    banded_walls(mb, base, [(base["topY"] - 0.8, base_mat), (base["topY"], concrete)], top_mat=roof)
    mb.build("base", parent=r, sharp_angle=30)

    col = fc.MeshBuilder()
    foot = LK.record(s, "201006.0006230-tower")["footY"] - 0.4
    # fluted shaft: 16 flutes, 11.2 m across at the foot, 10.0 m under the arcade
    flutes = 16
    z_arc0, z_arc1 = 54.5, 60.0

    def ring(rad: float, z: float):
        pts = []
        for k in range(flutes * 2):
            a = math.pi * k / flutes
            rr = rad if k % 2 == 0 else rad - 0.38
            pts.append((rr * math.cos(a), rr * math.sin(a), z))
        return pts

    secs = [ring(5.6, foot), ring(5.45, 20.0), ring(5.25, 40.0), ring(5.0, z_arc0)]
    col.loft(secs, concrete, closed=True, smooth=False)
    # the arcade: 12 arched openings round the observation gallery
    col.cylinder(4.2, z_arc0, z_arc1, 12, dark, smooth=False, caps=False)
    n = 12
    for k in range(n):
        a = 2 * math.pi * (k + 0.5) / n
        LK.box_on(col, 5.0 * math.cos(a), 5.0 * math.sin(a), z_arc0, z_arc1, 1.0, 1.2, a, concrete)
    # arch heads: a ring over the openings, then the cornice and the stepped crown
    col.lathe([(5.15, z_arc1 - 1.0), (5.15, z_arc1 + 0.6), (5.55, z_arc1 + 0.9), (5.55, z_arc1 + 1.5), (5.0, z_arc1 + 1.7),
               (4.8, 62.4), (4.3, 62.6), (4.3, 63.3), (3.6, 63.5), (3.2, COIT_TOP - 0.05), (0.0, COIT_TOP)], 24, concrete, smooth=False)
    col.lathe([(5.0, z_arc0 - 0.6), (5.45, z_arc0 - 0.4), (5.45, z_arc0 + 0.2), (5.0, z_arc0 + 0.3)], 24, concrete, smooth=False)
    col.build("column", parent=r, sharp_angle=35)
    fc.export_glb("coit-tower.glb", BUDGETS["coit-tower.glb"])


# ============================================================================ City Hall

def city_hall() -> None:
    s = LK.site("city-hall")
    fc.reset()
    granite = fc.material("granite", "#d5d0c5", 0.7)
    rustic = fc.material("granite_base", "#bdb7aa", 0.8)
    cornice = fc.material("granite_cornice", "#e3dfd5", 0.6)
    roof = fc.material("roof_lead", "#6f726f", 0.8)
    copper = fc.material("dome_copper", "#5e7a6e", 0.55, 0.4)
    gold = fc.material("gilt", "#c9a43a", 0.35, 0.9)
    dark = fc.material("colonnade_shadow", "#3b3833", 0.9)
    lt = fc.material("light_tower_outline", "#e3dfd5", 0.6, emission="#ffe2b0", strength=1.0)
    r = root("city_hall", "city-hall", topM=93.0)
    body = LK.record(s, "201006.0000041")
    top = body["topY"]
    mb = fc.MeshBuilder()
    banded_walls(mb, body, [(8.0, rustic), (top - 2.6, granite), (top, cornice)], top_mat=roof)
    pilasters(mb, body, 8.0, top - 2.6, 5.5, granite)
    mb.build("building", parent=r, sharp_angle=30)

    dm = fc.MeshBuilder()
    # square attic under the drum, the colonnaded drum, the dome with gilt ribs, the lantern
    dm.box(-16, -16, top - 0.5, 16, 16, top + 7.0, granite)
    dm.box(-16.6, -16.6, top + 7.0, 16.6, 16.6, top + 8.0, cornice)
    z0 = top + 8.0
    dm.cylinder(13.0, z0, z0 + 17.0, 32, dark, smooth=False, caps=False)
    cols = 28
    for k in range(cols):
        a = 2 * math.pi * k / cols
        dm.push(Matrix.Translation((14.6 * math.cos(a), 14.6 * math.sin(a), 0)))
        dm.cylinder(0.75, z0, z0 + 15.5, 8, granite, smooth=True, caps=False)
        dm.pop()
    dm.lathe([(15.6, z0 + 15.5), (15.6, z0 + 17.5), (14.4, z0 + 17.6), (14.4, z0 + 21.0), (13.4, z0 + 21.2)], 32, cornice, smooth=False)
    zd = z0 + 21.2
    prof = [(13.4, zd), (13.1, zd + 4), (12.0, zd + 9), (10.1, zd + 13.5), (7.4, zd + 17.2), (4.0, zd + 19.8), (3.0, zd + 20.3)]
    dm.lathe(prof, 32, copper, smooth=True)
    for k in range(8):
        a = 2 * math.pi * k / 8
        pts = [(rr * math.cos(a) * 1.01, rr * math.sin(a) * 1.01, zz) for rr, zz in prof]
        for p0, p1 in zip(pts, pts[1:]):
            LK.strut(dm, p0, p1, 0.5, gold)
    zl = zd + 20.3
    dm.cylinder(3.0, zl, zl + 5.5, 12, lt, smooth=False, caps=False)  # the lantern glows at night
    for k in range(8):
        a = 2 * math.pi * k / 8
        LK.box_on(dm, 3.1 * math.cos(a), 3.1 * math.sin(a), zl, zl + 5.5, 0.6, 0.6, a, granite)
    dm.lathe([(3.5, zl + 5.5), (3.5, zl + 6.2), (2.6, zl + 7.4), (1.0, zl + 8.6), (0.35, zl + 9.0)], 12, copper, smooth=True)
    dm.cylinder(0.3, zl + 9.0, 93.0, 6, gold, smooth=False)
    dm.build("dome", parent=r, sharp_angle=30)
    fc.export_glb("city-hall.glb", BUDGETS["city-hall.glb"])


# ============================================================================ Palace of Fine Arts

def palace() -> None:
    s = LK.site("palace-of-fine-arts")
    fc.reset()
    stone = fc.material("stone_ochre", "#d8c3a0", 0.8)
    stone_dk = fc.material("stone_ochre_shade", "#bfa682", 0.85)
    dome = fc.material("dome_terracotta", "#b46f4b", 0.7)
    dark = fc.material("rotunda_shadow", "#2f2a25", 0.95)
    lt = fc.material("light_tower_outline", "#d8c3a0", 0.8, emission="#4a3c2a", strength=1.0)
    r = root("palace_of_fine_arts", "palace-of-fine-arts", topM=49.0)
    rec = LK.record(s, "201006.0000986")
    mb = fc.MeshBuilder()
    # the footprint as the sim has it: a low stone plinth (the rotunda's whole floor plate)
    banded_walls(mb, rec, [(1.2, stone_dk)], top_mat=stone_dk)
    # inside the piers the arches are closed by deep shadow (the sim's record is solid)
    oct_r = 23.0
    mb.push(Matrix.Rotation(math.pi / 8, 4, "Z"))
    mb.cylinder(oct_r, 1.2, 30.0, 8, dark, smooth=False, caps=False)
    mb.pop()
    # eight piers, each a cluster of columns, carrying the entablature
    for k in range(8):
        a = 2 * math.pi * k / 8
        px, py = 28.0 * math.cos(a), 28.0 * math.sin(a)
        LK.box_on(mb, px, py, 1.2, 30.0, 7.0, 7.0, a, stone)
        for (dx, dy) in ((-4.2, -2.6), (-4.2, 2.6), (4.2, -2.6), (4.2, 2.6)):
            mb.push(Matrix.Translation((px, py, 0)) @ Matrix.Rotation(a, 4, "Z") @ Matrix.Translation((dx, dy, 0)))
            mb.cylinder(0.9, 1.2, 27.0, 8, stone, smooth=True, caps=False)
            mb.pop()
        # urn-topped pier caps above the entablature
        LK.box_on(mb, px * 1.03, py * 1.03, 34.0, 37.5, 4.0, 4.0, a, stone_dk)
    # arches between the piers
    for k in range(8):
        a0 = 2 * math.pi * k / 8 + 0.17
        a1 = 2 * math.pi * (k + 1) / 8 - 0.17
        pts = []
        for j in range(9):
            u = j / 8
            a = a0 + (a1 - a0) * u
            pts.append((26.0 * math.cos(a), 26.0 * math.sin(a), 21.0 + 6.0 * math.sin(math.pi * u)))
        for p0, p1 in zip(pts, pts[1:]):
            LK.strut(mb, p0, p1, 2.2, stone, d=3.0)
    # entablature, attic, drum and dome
    mb.push(Matrix.Rotation(math.pi / 8, 4, "Z"))
    mb.lathe([(31.5, 30.0), (31.5, 33.0), (32.3, 33.4), (32.3, 34.5), (24.0, 34.5)], 8, stone, smooth=False)
    mb.lathe([(24.0, 34.5), (24.0, 37.0), (19.0, 37.2)], 8, stone_dk, smooth=False)
    mb.pop()
    mb.lathe([(18.0, 37.2), (18.0, 40.5), (17.0, 40.8)], 24, stone, smooth=False)
    mb.lathe([(17.0, 40.8), (16.4, 43.0), (14.6, 45.4), (11.4, 47.3), (6.6, 48.6), (0.0, 49.0)], 24, dome, smooth=True)
    mb.build("rotunda", parent=r, sharp_angle=30)
    li = fc.MeshBuilder()
    li.push(Matrix.Rotation(math.pi / 8, 4, "Z"))
    li.cylinder(oct_r + 0.05, 2.0, 3.0, 8, lt, smooth=False, caps=False)  # floodlights at the piers' feet
    li.pop()
    li.build("floodlights", parent=r)
    fc.export_glb("palace-of-fine-arts.glb", BUDGETS["palace-of-fine-arts.glb"])


# ============================================================================ Grace Cathedral

def grace() -> None:
    s = LK.site("grace-cathedral")
    fc.reset()
    concrete = fc.material("cast_stone", "#cfc8ba", 0.8)
    shade = fc.material("cast_stone_shade", "#b3ab9c", 0.85)
    roof = fc.material("roof_copper", "#5f7a72", 0.6, 0.3)
    glass = fc.material("stained_glass_dark", "#2c3340", 0.3)
    lt = fc.material("light_tower_outline", "#cfc8ba", 0.8, emission="#544c40", strength=1.0)
    r = root("grace_cathedral", "grace-cathedral", topM=70.0)
    body = LK.record(s, "201006.0000550")
    cx, cy = LK.bl(*s["extra"]["crossing"])
    ys = [LK.bl(x, z)[1] for x, z in body["footprint"]]
    y_front, y_back = max(ys), min(ys)
    wall_top = 24.0
    mb = fc.MeshBuilder()
    banded_walls(mb, body, [(3.0, shade), (wall_top, concrete)], top_mat=shade)
    # lancet windows along the long walls (dark inset strips) and the rose window
    ring = LK.ring_bl(body)
    for i in range(len(ring)):
        (ax, ay), (bx, by) = ring[i], ring[(i + 1) % len(ring)]
        L = math.hypot(bx - ax, by - ay)
        if L < 14.0:
            continue
        ux, uy = (bx - ax) / L, (by - ay) / L
        nx, ny = uy, -ux
        k = int(L // 7.0)
        for j in range(1, k + 1):
            t = j * L / (k + 1)
            px, py = ax + ux * t + nx * 0.05, ay + uy * t + ny * 0.05
            mb.poly_n([(px - ux * 0.9, py - uy * 0.9, 6.0), (px + ux * 0.9, py + uy * 0.9, 6.0), (px + ux * 0.9, py + uy * 0.9, 18.5), (px, py, 20.5), (px - ux * 0.9, py - uy * 0.9, 18.5)], glass, (nx, ny, 0))
    # nave roof (along the axis) and transept roof (across it, at the crossing)
    nave_w = 26.0
    ridge = 36.0

    def gable(x0, x1, y0, y1, along_y: bool):
        if along_y:
            xm = (x0 + x1) / 2
            mb.poly_n([(x0, y0, wall_top), (x0, y1, wall_top), (xm, y1, ridge), (xm, y0, ridge)], roof, (-1, 0, 1))
            mb.poly_n([(x1, y0, wall_top), (xm, y0, ridge), (xm, y1, ridge), (x1, y1, wall_top)], roof, (1, 0, 1))
            for yy, ny in ((y0, -1), (y1, 1)):
                mb.poly_n([(x0, yy, wall_top), (x1, yy, wall_top), (xm, yy, ridge)], concrete, (0, ny, 0))
        else:
            ym = (y0 + y1) / 2
            mb.poly_n([(x0, y0, wall_top), (x1, y0, wall_top), (x1, ym, ridge), (x0, ym, ridge)], roof, (0, -1, 1))
            mb.poly_n([(x0, y1, wall_top), (x0, ym, ridge), (x1, ym, ridge), (x1, y1, wall_top)], roof, (0, 1, 1))
            for xx, nx in ((x0, -1), (x1, 1)):
                mb.poly_n([(xx, y0, wall_top), (xx, y1, wall_top), (xx, ym, ridge)], concrete, (nx, 0, 0))

    gable(cx - nave_w / 2, cx + nave_w / 2, y_back + 8.0, y_front - 10.0, True)
    # the transept reaches the footprint's walls on either side of the crossing
    near = [x for x, y in LK.ring_bl(body) if abs(y - cy) < 12.0]
    gable(max(min(near), cx - 30.0), min(max(near), cx + 30.0), cy - 12.0, cy + 12.0, False)
    # the twin towers on the front, the rose window between them, and pinnacles
    for side in (-1, 1):
        tx = cx + side * 11.5
        ty = y_front - 6.0
        LK.box_on(mb, tx, ty, -1.0, 46.0, 9.0, 9.0, 0.0, concrete, skip=("-z",))
        LK.box_on(mb, tx, ty, 46.0, 48.0, 10.0, 10.0, 0.0, shade)
        mb.push(Matrix.Translation((tx, ty, 0)))
        mb.frustum([(-4.5, -4.5), (4.5, -4.5), (4.5, 4.5), (-4.5, 4.5)], [(-0.4, -0.4), (0.4, -0.4), (0.4, 0.4), (-0.4, 0.4)], 48.0, 53.0, roof, top=True)
        for (px, py) in ((-4.6, -4.6), (4.6, -4.6), (4.6, 4.6), (-4.6, 4.6)):
            mb.push(Matrix.Translation((px, py, 0)))
            mb.frustum([(-0.6, -0.6), (0.6, -0.6), (0.6, 0.6), (-0.6, 0.6)], [(-0.05, -0.05), (0.05, -0.05), (0.05, 0.05), (-0.05, 0.05)], 48.0, 52.0, concrete, top=True)
            mb.pop()
        # belfry openings
        for (ox, oy, nx, ny) in ((0, -4.52, 0, -1), (0, 4.52, 0, 1), (-4.52, 0, -1, 0), (4.52, 0, 1, 0)):
            w = 1.6
            if nx == 0:
                pts = [(ox - w, oy, 34.0), (ox + w, oy, 34.0), (ox + w, oy, 42.0), (ox, oy, 44.0), (ox - w, oy, 42.0)]
            else:
                pts = [(ox, oy - w, 34.0), (ox, oy + w, 34.0), (ox, oy + w, 42.0), (ox, oy, 44.0), (ox, oy - w, 42.0)]
            mb.poly_n(pts, glass, (nx, ny, 0))
        mb.pop()
    seg = 24
    rose = [(cx + 5.0 * math.cos(2 * math.pi * k / seg), y_front + 0.08, 24.0 + 5.0 * math.sin(2 * math.pi * k / seg)) for k in range(seg)]
    mb.poly_n(rose, glass, (0, 1, 0))
    for k in range(8):
        a = 2 * math.pi * k / 8
        LK.strut(mb, (cx, y_front + 0.2, 24.0), (cx + 4.8 * math.cos(a), y_front + 0.2, 24.0 + 4.8 * math.sin(a)), 0.25, concrete)
    # the fleche over the crossing (the probe's tower record)
    mb.push(Matrix.Translation((cx, cy, 0)))
    mb.cylinder(3.2, ridge - 2.0, 44.0, 8, concrete, smooth=False, caps=False)
    mb.lathe([(3.6, 44.0), (3.6, 45.0), (2.6, 46.0), (0.15, 69.5), (0.0, 70.0)], 8, roof, smooth=False)
    mb.pop()
    mb.build("cathedral", parent=r, sharp_angle=30)
    li = fc.MeshBuilder()
    for side in (-1, 1):
        LK.box_on(li, cx + side * 11.5, y_front - 1.45, 2.0, 46.0, 9.1, 0.1, 0.0, lt)
    li.build("floodlights", parent=r)
    fc.export_glb("grace-cathedral.glb", BUDGETS["grace-cathedral.glb"])


# ============================================================================ Mission Dolores

def mission_dolores() -> None:
    s = LK.site("mission-dolores")
    fc.reset()
    stucco = fc.material("stucco_white", "#ece6da", 0.85)
    trim = fc.material("stucco_cream", "#d8cbb2", 0.85)
    tile = fc.material("roof_tile_red", "#a5543a", 0.8)
    dome = fc.material("dome_tile", "#b98b4e", 0.6, 0.2)
    dark = fc.material("openings_shadow", "#33302c", 0.9)
    r = root("mission_dolores", "mission-dolores", topM=39.25)
    body = LK.record(s, "201006.0001563")
    tower = LK.record(s, "201006.0001563-tower")
    top = body["topY"]
    mb = fc.MeshBuilder()
    banded_walls(mb, body, [(2.0, trim), (top - 1.0, stucco), (top, trim)], top_mat=tile)
    # a gabled nave roof in red tile along the long axis, and a stepped Mission Revival front
    ys = [LK.bl(x, z)[1] for x, z in body["footprint"]]
    xs = [LK.bl(x, z)[0] for x, z in body["footprint"]]
    y_front, y_back = max(ys), min(ys)
    xm = (min(xs) + max(xs)) / 2
    half = min(9.0, (max(xs) - min(xs)) / 2 - 1.0)
    ridge = top + 6.0
    mb.poly_n([(xm - half, y_back + 2, top), (xm - half, y_front - 2, top), (xm, y_front - 2, ridge), (xm, y_back + 2, ridge)], tile, (-1, 0, 1))
    mb.poly_n([(xm + half, y_back + 2, top), (xm, y_back + 2, ridge), (xm, y_front - 2, ridge), (xm + half, y_front - 2, top)], tile, (1, 0, 1))
    for yy, ny in ((y_back + 2, -1), (y_front - 2, 1)):
        mb.poly_n([(xm - half, yy, top), (xm + half, yy, top), (xm, yy, ridge)], stucco, (0, ny, 0))
    fy = y_front + 0.05
    prof = [(-half - 1, top), (-half - 1, top + 2.5), (-half * 0.55, top + 4.5), (-half * 0.3, ridge + 1.5), (0, ridge + 3.0), (half * 0.3, ridge + 1.5), (half * 0.55, top + 4.5), (half + 1, top + 2.5), (half + 1, top)]
    mb.poly_n([(xm + px, fy, pz) for px, pz in prof], stucco, (0, 1, 0))
    mb.poly_n([(xm + px, fy - 0.6, pz) for px, pz in reversed(prof)], stucco, (0, -1, 0))
    # the portal and the window over it (dark openings), and a rose
    mb.poly_n([(xm - 2.0, fy + 0.02, 0.0), (xm + 2.0, fy + 0.02, 0.0), (xm + 2.0, fy + 0.02, 6.0), (xm, fy + 0.02, 7.6), (xm - 2.0, fy + 0.02, 6.0)], dark, (0, 1, 0))
    rose = [(xm + 1.4 * math.cos(2 * math.pi * k / 16), fy + 0.02, top + 2.0 + 1.4 * math.sin(2 * math.pi * k / 16)) for k in range(16)]
    mb.poly_n(rose, dark, (0, 1, 0))
    # the tall element the LiDAR finds mid-body: an octagonal drum with arched openings and a tiled dome
    tx, ty = LK.bl(*[sum(c) / len(c) for c in zip(*tower["footprint"])])
    mb.push(Matrix.Translation((tx, ty, 0)) @ Matrix.Rotation(math.pi / 8, 4, "Z"))
    mb.cylinder(4.0, top - 1.0, 30.0, 8, stucco, smooth=False, caps=False)
    mb.lathe([(4.4, 30.0), (4.4, 31.0), (3.8, 31.2)], 8, trim, smooth=False)
    mb.pop()
    for k in range(8):
        a = 2 * math.pi * (k + 0.5) / 8
        ox, oy = tx + 3.72 * math.cos(a), ty + 3.72 * math.sin(a)
        mb.poly_n([(ox - 0.7 * math.sin(a), oy + 0.7 * math.cos(a), 24.0), (ox + 0.7 * math.sin(a), oy - 0.7 * math.cos(a), 24.0),
                   (ox + 0.7 * math.sin(a), oy - 0.7 * math.cos(a), 28.0), (ox - 0.7 * math.sin(a), oy + 0.7 * math.cos(a), 28.0)], dark, (math.cos(a), math.sin(a), 0))
    mb.push(Matrix.Translation((tx, ty, 0)))
    mb.lathe([(3.8, 31.2), (3.5, 33.5), (2.6, 35.5), (1.2, 36.8), (0.5, 37.2)], 16, dome, smooth=True)
    mb.cylinder(0.5, 37.2, 38.4, 8, stucco, smooth=False)
    mb.cylinder(0.08, 38.4, 39.25, 6, trim, smooth=False)
    mb.pop()
    mb.build("basilica", parent=r, sharp_angle=30)
    fc.export_glb("mission-dolores.glb", BUDGETS["mission-dolores.glb"])


# ============================================================================ Conservatory of Flowers

def conservatory() -> None:
    s = LK.site("conservatory-of-flowers")
    fc.reset()
    frame = fc.material("painted_frame_white", "#f1efe8", 0.5)
    glass = fc.material("glasshouse_glass", "#9fb9b0", 0.15, 0.1)
    base = fc.material("stone_base", "#bdb6a8", 0.85)
    r = root("conservatory", "conservatory-of-flowers", topM=17.0)
    body = LK.record(s, "201006.0001537")
    top = body["topY"]
    mb = fc.MeshBuilder()
    banded_walls(mb, body, [(0.9, base), (top - 0.35, glass), (top, frame)], top_mat=glass)
    # white glazing bars on every wall, every 1.5 m
    ring = LK.ring_bl(body)
    for i in range(len(ring)):
        (ax, ay), (bx, by) = ring[i], ring[(i + 1) % len(ring)]
        L = math.hypot(bx - ax, by - ay)
        if L < 2.0:
            continue
        ux, uy = (bx - ax) / L, (by - ay) / L
        nx, ny = uy, -ux
        for k in range(1, int(L // 1.5) + 1):
            t = k * L / (int(L // 1.5) + 1)
            cx, cy = ax + ux * t + nx * 0.04, ay + uy * t + ny * 0.04
            mb.poly_n([(cx - ux * 0.06, cy - uy * 0.06, 0.9), (cx + ux * 0.06, cy + uy * 0.06, 0.9), (cx + ux * 0.06, cy + uy * 0.06, top), (cx - ux * 0.06, cy - uy * 0.06, top)], frame, (nx, ny, 0))
    # the central pavilion: an octagonal glazed drum, the dome with ribs, the lantern
    mb.push(Matrix.Rotation(math.pi / 8, 4, "Z"))
    mb.cylinder(7.2, top - 0.5, 8.5, 8, glass, smooth=False, caps=False)
    mb.lathe([(7.5, 8.5), (7.5, 9.1), (7.0, 9.2)], 8, frame, smooth=False)
    mb.pop()
    prof = [(7.0, 9.2), (6.8, 11.0), (5.9, 12.8), (4.3, 14.3), (2.2, 15.3), (1.2, 15.5)]
    mb.lathe(prof, 16, glass, smooth=True)
    for k in range(16):
        a = 2 * math.pi * k / 16
        pts = [(rr * 1.01 * math.cos(a), rr * 1.01 * math.sin(a), zz) for rr, zz in prof]
        for p0, p1 in zip(pts, pts[1:]):
            LK.strut(mb, p0, p1, 0.18, frame)
    mb.cylinder(1.2, 15.5, 16.4, 8, glass, smooth=False, caps=False)
    mb.lathe([(1.4, 16.4), (0.9, 16.8), (0.2, 17.0), (0.0, 17.0)], 8, frame, smooth=False)
    mb.build("glasshouse", parent=r, sharp_angle=30)
    fc.export_glb("conservatory-of-flowers.glb", BUDGETS["conservatory-of-flowers.glb"])


# ============================================================================ Dragon Gate

def roof_pagoda(mb, x0, x1, y0, y1, z_eave, z_ridge, tile, ridge_mat, lift=0.45) -> None:
    """A hip-and-gable tile roof with upturned eave corners, between x0..x1 and y0..y1."""
    xm = (x0 + x1) / 2
    inset = (x1 - x0) * 0.22
    c = [(x0, y0, z_eave + lift), (x1, y0, z_eave + lift), (x1, y1, z_eave + lift), (x0, y1, z_eave + lift)]
    m0 = [(xm - (x1 - x0) / 2 + 0.6, y0, z_eave), (xm + (x1 - x0) / 2 - 0.6, y0, z_eave)]
    ra, rb = (x0 + inset, (y0 + y1) / 2, z_ridge), (x1 - inset, (y0 + y1) / 2, z_ridge)
    # front and back slopes (with a sag in the middle of the eave), as planar pieces
    mb.poly_n([c[0], m0[0], ra], tile, (0, -1, 1))
    mb.poly_n([m0[0], m0[1], rb, ra], tile, (0, -1, 1))
    mb.poly_n([m0[1], c[1], rb], tile, (0, -1, 1))
    m1 = [(xm + (x1 - x0) / 2 - 0.6, y1, z_eave), (xm - (x1 - x0) / 2 + 0.6, y1, z_eave)]
    mb.poly_n([c[2], m1[0], rb], tile, (0, 1, 1))
    mb.poly_n([m1[0], m1[1], ra, rb], tile, (0, 1, 1))
    mb.poly_n([m1[1], c[3], ra], tile, (0, 1, 1))
    # hips
    mb.poly_n([c[3], c[0], ra], tile, (-1, 0, 1))
    mb.poly_n([c[1], c[2], rb], tile, (1, 0, 1))
    # soffit
    mb.poly_n(list(reversed(c)), tile, (0, 0, -1))
    # ridge beam with upturned fish-tail ends
    LK.strut(mb, ra, rb, 0.3, ridge_mat, d=0.45)
    for (p, sgn) in ((ra, -1), (rb, 1)):
        LK.strut(mb, p, (p[0] + sgn * 0.5, p[1], p[2] + 0.9), 0.22, ridge_mat)


def dragon_gate() -> None:
    s = LK.site("dragon-gate")
    fc.reset()
    stone = fc.material("stone_pale", "#d6d0c2", 0.75)
    red = fc.material("lacquer_red", "#a3352b", 0.5)
    tile = fc.material("glazed_tile_green", "#3d7b58", 0.45)
    gold = fc.material("gilt", "#c9a43a", 0.35, 0.9)
    plaque = fc.material("plaque_blank", "#2d3a52", 0.5)
    r = root("dragon_gate", "dragon-gate", spanM=s["extra"]["spanM"])
    span = min(s["extra"]["spanM"] - 0.16, 11.2)
    half = span / 2
    pw = 0.6  # pillar width
    depth = 1.1
    # Grant Ave's ribbon runs off-centre between the building faces the gate spans, and the sim
    # has no collider for the gate: so only the two outer pillars stand, on the sidewalks either
    # side of it, and everything over the ribbon is at least 4.8 m above the road. The inner
    # posts of the three portals hang from the lintels (pendant posts) and stop above the
    # traffic. rt: the highest road ground under the gate.
    across = LK.roads_across(s, -half, -depth / 2, half, depth / 2, margin=0.05)
    rt = across[2] if across else 0.0
    c_x = 2.9  # the pendant posts, either side of the central portal
    mb = fc.MeshBuilder()
    for sgn in (-1, 1):
        x0, x1 = sorted((sgn * half, sgn * (half - pw)))
        mb.box(x0, -depth / 2, -0.3, x1, depth / 2, rt + 5.8, stone, skip=("-z",))
        mb.box(x0 - 0.04, -depth / 2 - 0.06, -0.3, x1 + 0.04, depth / 2 + 0.06, 0.5, stone, skip=("-z",))
        # the pendant post, hanging from the central lintel, with a gilt drop at its foot
        mb.box(sgn * c_x - 0.25, -0.45, rt + 5.0, sgn * c_x + 0.25, 0.45, rt + 6.1, red)
        mb.sphere((sgn * c_x, 0.0, rt + 5.02), 0.17, 8, 4, gold)
        # the side lintel from the outer pillar to the pendant post, red with a gilt band
        x0, x1 = sorted((sgn * (half - pw), sgn * c_x))
        mb.box(x0, -0.42, rt + 5.2, x1, 0.42, rt + 5.8, red)
        mb.box(x0, -0.44, rt + 5.45, x1, 0.44, rt + 5.55, gold)
    # the central lintel, red with a gilt band
    mb.box(-c_x - 0.25, -0.45, rt + 6.1, c_x + 0.25, 0.45, rt + 6.9, red)
    mb.box(-c_x - 0.25, -0.47, rt + 6.5, c_x + 0.25, 0.47, rt + 6.62, gold)
    # the blank plaque over the central portal (no characters)
    mb.box(-1.3, -0.5, rt + 6.95, 1.3, 0.5, rt + 7.75, gold)
    mb.box(-1.15, -0.53, rt + 7.05, 1.15, 0.53, rt + 7.65, plaque)
    # roofs: the tall central roof and two lower side roofs, with ridge ornaments
    roof_pagoda(mb, -c_x - 1.15, c_x + 1.15, -1.35, 1.35, rt + 7.85, rt + 9.5, tile, gold)
    for sgn in (-1, 1):
        x0, x1 = sorted((sgn * c_x, sgn * (half + 0.03)))
        roof_pagoda(mb, x0, x1, -1.1, 1.1, rt + 5.95, rt + 7.1, tile, gold, lift=0.3)
    # the ridge pearl between two stylised dragons
    mb.sphere((0.0, 0.0, rt + 10.05), 0.28, 10, 6, gold)
    for sgn in (-1, 1):
        pts = [(sgn * (0.45 + 0.35 * k), 0.0, rt + 9.75 + 0.35 * math.sin(k * 0.9)) for k in range(6)]
        LK.tube(mb, pts, 0.11, 6, tile)
    # guardian lions on plinths before the outer pillars, on the front (south, +Y) side, on the
    # sidewalks: seated, facing the street, haunches back, forelegs straight, a maned head;
    # plain stone forms
    for sgn in (-1, 1):
        x = sgn * (half - pw / 2)
        mb.box(x - 0.3, 0.7, -0.3, x + 0.3, 1.5, 0.8, stone, skip=("-z",))
        mb.box(x - 0.22, 0.75, 0.8, x + 0.22, 1.15, 1.15, stone, skip=("-z",))  # haunches
        mb.box(x - 0.19, 1.05, 0.8, x + 0.19, 1.3, 1.45, stone, skip=("-z",))  # chest
        for lx in (-0.11, 0.11):
            mb.box(x + lx - 0.06, 1.28, 0.8, x + lx + 0.06, 1.4, 1.2, stone, skip=("-z",))  # forelegs
        mb.sphere((x, 1.2, 1.62), 0.25, 10, 6, stone, scale=(1.0, 0.8, 1.0))  # mane
        mb.box(x - 0.11, 1.32, 1.5, x + 0.11, 1.48, 1.68, stone)  # muzzle
        mb.sphere((x - sgn * 0.13, 1.36, 0.92), 0.09, 8, 4, gold)  # the ball under a paw
    mb.build("gate", parent=r, sharp_angle=35)
    fc.export_glb("dragon-gate.glb", BUDGETS["dragon-gate.glb"])


# ============================================================================ Sutro Baths

def sutro_baths() -> None:
    s = LK.site("sutro-baths")
    fc.reset()
    concrete = fc.material("concrete_weathered", "#a9a49a", 0.95)
    stain = fc.material("concrete_stained", "#7f7b72", 0.95)
    water = fc.material("pool_water", "#3f5a55", 0.15, 0.0)
    r = root("sutro_baths", "sutro-baths")
    mb = fc.MeshBuilder()

    def g(x, y):
        return LK.ground(s, x, y)

    def wall(x0, y0, x1, y1, h, th=0.8, gaps=()):
        """A broken wall from (x0, y0) to (x1, y1), its top `h` above the local ground."""
        L = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(L // 4.0))
        for k in range(n):
            u0, u1 = k / n, (k + 1) / n
            if any(a <= (u0 + u1) / 2 <= b for a, b in gaps):
                continue
            ax, ay = LK.lerp(x0, x1, u0), LK.lerp(y0, y1, u0)
            bx, by = LK.lerp(x0, x1, u1), LK.lerp(y0, y1, u1)
            jag = 0.35 * math.sin(k * 2.3 + x0 * 0.7 + y0 * 0.3)
            ga, gb = g(ax, ay), g(bx, by)
            ux, uy = (bx - ax) / (L / n), (by - ay) / (L / n)
            nx, ny = -uy * th / 2, ux * th / 2
            top_a, top_b = max(ga, gb) + h + jag, max(ga, gb) + h - jag * 0.6
            bot = min(ga, gb) - 0.5
            q = [(ax + nx, ay + ny), (bx + nx, by + ny), (bx - nx, by - ny), (ax - nx, ay - ny)]
            tops = [top_a, top_b, top_b, top_a]
            for i in range(4):
                j = (i + 1) % 4
                mb.poly([(q[i][0], q[i][1], bot), (q[j][0], q[j][1], bot), (q[j][0], q[j][1], tops[j]), (q[i][0], q[i][1], tops[i])], concrete if i % 2 == 0 else stain)
            mb.poly([(q[i][0], q[i][1], tops[i]) for i in range(4)], stain)

    # the outer basin (about 50 x 90 m) and the old pools inside it
    X0, X1, Y0, Y1 = -24.0, 26.0, -46.0, 44.0
    wall(X0, Y0, X1, Y0, 1.6, 1.2)
    wall(X1, Y0, X1, Y1, 2.4, 1.2, gaps=((0.45, 0.52),))
    wall(X1, Y1, X0, Y1, 1.8, 1.2)
    wall(X0, Y1, X0, Y0, 1.0, 1.2, gaps=((0.3, 0.38), (0.7, 0.75)))
    # the long main pool along the west side, and smaller pools to the east
    wall(-6.0, Y0, -6.0, Y1, 0.9, gaps=((0.2, 0.26), (0.55, 0.6)))
    for y in (-26.0, -8.0, 10.0, 28.0):
        wall(-6.0, y, X1, y, 0.7, gaps=((0.4, 0.5),))
    wall(10.0, Y0, 10.0, Y1, 0.6, gaps=((0.15, 0.25), (0.6, 0.7)))
    # stumps of the old columns along the main pool
    for k in range(10):
        y = Y0 + 6.0 + k * 8.5
        x = -15.0
        gg = g(x, y)
        LK.box_on(mb, x, y, gg - 0.5, gg + 0.5 + 0.4 * (k % 3), 1.0, 1.0, 0.0, stain)
    # standing water in the pools, just over the basin floor
    for (x0, x1, y0, y1) in ((X0 + 0.7, -6.4, Y0 + 0.7, Y1 - 0.7), (-5.6, 9.6, -25.6, -8.4), (10.4, X1 - 0.7, 10.4, 27.6), (-5.6, 9.6, 28.4, Y1 - 0.7)):
        zz = max(g(x, y) for x in (x0, (x0 + x1) / 2, x1) for y in (y0, (y0 + y1) / 2, y1)) + 0.06
        mb.poly_n([(x0, y0, zz), (x1, y0, zz), (x1, y1, zz), (x0, y1, zz)], water, (0, 0, 1))
    mb.build("ruins", parent=r, sharp_angle=40)
    fc.export_glb("sutro-baths.glb", BUDGETS["sutro-baths.glb"])


ALL = {
    "montgomery": montgomery,
    "coit": coit,
    "city_hall": city_hall,
    "palace": palace,
    "grace": grace,
    "dragon_gate": dragon_gate,
    "sutro_baths": sutro_baths,
    "mission_dolores": mission_dolores,
    "conservatory": conservatory,
}

if __name__ == "__main__":
    for name in fc.script_args() or list(ALL):
        ALL[name]()
