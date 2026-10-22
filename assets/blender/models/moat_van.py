"""The Moat Labs van (original design) -> public/models/moat-van.glb

The van that delivers Moat Labs units when threat rises: a tall, faceted, driverless box van
(5.6 m long, 2.1 m wide, 2.5 m tall) in graphite with a teal "moat" band along the sills.
Its castle-and-moat character comes from shapes, not text: a battlement of small blocks
along both roof edges, narrow vertical slit lamps at the corners, chamfered keep-like
corners, and an invented castle-over-water emblem (teal geometry) on each side and the
nose. No real van's shape, light signature or badge; no words anywhere.

Nodes: moat_van (root, origin on the ground at the body centre)
  body
  wheel_FL/FR/RL/RR   origin at the hub, spin about local X, extras radius, steer on the front
  door_rear_L/R       barn doors; origin on the hinge (the rear corner), swing about local +Y
                      by extras openRad (R positive, L negative: both swing outward)
Lights: light_headlight, light_taillight, light_accent (the teal line above the moat band).
Front faces glTF -Z. Budget: 9k triangles.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

from mathutils import Matrix  # noqa: E402

import fc  # noqa: E402
import vehicle as V  # noqa: E402

BUDGET = 9_000
WB = 3.5
WR = 0.37
WW = 0.26
ARCH_R = 0.45
Y_F, Y_R = 1.3, -2.2  # axles (the cab sits ahead of the front axle line's centre)
FRONT, REAR = 2.85, -2.75
HW = 1.03  # body half width at the shoulders
ROOF = 2.38

# stations along y (front to rear): half width low, sill z, shoulder z, half width top, top z
STATIONS = [
    (FRONT, 0.86, 0.42, 0.62, 0.8, 0.98),
    (2.8, 0.96, 0.36, 0.78, 0.9, 1.08),
    (2.62, 1.0, 0.34, 0.9, 0.95, 1.2),
    (2.4, 1.02, 0.33, 1.08, 0.96, 1.36),
    (2.18, 1.03, 0.33, 1.2, 0.95, 1.62),
    (1.75, 1.03, 0.33, 1.25, 0.92, 2.18),
    (1.55, 1.03, 0.33, 1.25, 0.9, ROOF),
    (0.0, 1.03, 0.33, 1.25, 0.9, ROOF),
    (-2.6, 1.03, 0.33, 1.25, 0.9, ROOF),
    (REAR, 1.0, 0.36, 1.22, 0.88, ROOF - 0.04),
]


def interp(y):
    return V.interp(STATIONS, y)


def sill(y, zb):
    z = zb
    for yw in (Y_F, Y_R):
        d = y - yw
        if abs(d) < ARCH_R:
            z = max(z, WR + 0.03 + math.sqrt(ARCH_R**2 - d**2) * 0.98)
    return z


def section(y):
    hw, zb, zs, ht, zt = interp(y)
    zb = sill(y, zb)
    half = [(0.0, zb), (hw - 0.06, zb), (hw, zb + 0.07), (hw, zs), (hw, zt - (zt - zs) * 0.18), (ht, zt - 0.02), (ht - 0.06, zt), (0.0, zt)]
    return half + [(-x, z) for x, z in reversed(half[1:-1])]


def main() -> None:
    fc.reset()
    paint = fc.material("paint_graphite", "#30343a", 0.42, 0.25)
    teal = fc.material("accent_teal", "#1fa79a", 0.4, 0.1)
    glass = fc.material("glass_tinted", "#0d1216", 0.06, 0.6)
    under = fc.material("underbody", "#0e0f10", 0.9)
    trim = fc.material("trim_black", "#16181b", 0.6)
    inside = fc.material("cargo_interior", "#3a3e44", 0.85, double_sided=True)
    tire = fc.material("tire", "#151515", 0.85)
    rim = fc.material("rim", "#2f3338", 0.35, 0.7)
    lens = fc.material("sensor_lens", "#0b0d10", 0.06, 0.4)
    head = fc.material("light_headlight", "#f4f6f8", 0.2, emission="#f2f7ff", strength=1.0)
    tail = fc.material("light_taillight", "#8a1010", 0.3, emission="#ff2a1a", strength=1.0)
    accent = fc.material("light_accent", "#2fd6c1", 0.3, emission="#2fffe0", strength=1.0)

    root = fc.empty("moat_van")
    root["fcActor"] = "moat-van"
    root["vehicle"] = "moat-van"

    # ---- the lofted, faceted body (wheel arches cut by the sill line)
    ys = {s[0] for s in STATIONS}
    for yw in (Y_F, Y_R):
        for k in range(11):
            ys.add(round(yw + ARCH_R * 1.02 * math.cos(math.pi * k / 10), 4))
    for y in (1.0, 0.0, -1.0, -1.8):
        ys.add(y)
    ys = sorted(ys, reverse=True)
    n = len(section(0.0))

    def seg_mat(j, y0, y1):
        # ring points: 0 bottom centre ... 7 top centre ... 13; segments j..j+1
        if j in (0, n - 1):
            return under
        if j in (1, n - 2):
            return trim
        upper = j in (4, n - 5)  # the side above the shoulder line
        roofish = j in (5, 6, n - 7, n - 6)
        if y0 > 1.55 and (upper or roofish) and y1 > 1.5:
            return glass if not (roofish and y1 > 2.3) else paint
        return paint

    body = V.weld(fc.MeshBuilder())
    mb = fc.MeshBuilder()
    V.loft_body(mb, ys, section, seg_mat, axis_z=1.2, cap_front=trim, cap_rear=inside)
    body = V.weld(mb)

    d = fc.MeshBuilder()
    # the moat: a teal band along each sill, with a thin light line above it
    for sx in (1, -1):
        for (y0, y1) in ((FRONT - 0.25, Y_F + ARCH_R + 0.05), (Y_F - ARCH_R - 0.05, Y_R + ARCH_R + 0.05), (Y_R - ARCH_R - 0.05, REAR + 0.15)):
            d.box(sx * (HW - 0.005), y1, 0.5, sx * (HW + 0.015), y0, 0.66, teal)
            d.box(sx * (HW - 0.005), y1, 0.685, sx * (HW + 0.02), y0, 0.705, accent)
    # battlements: small blocks along both roof edges
    for sx in (1, -1):
        y = 1.45
        while y > REAR + 0.1:
            d.box(sx * 0.9 - 0.06, y - 0.16, ROOF - 0.01, sx * 0.9 + 0.06, y, ROOF + 0.09, paint)
            y -= 0.36
    # slit lamps: narrow vertical lights at the four corners
    for sx in (1, -1):
        d.box(sx * 0.84, FRONT - 0.04, 0.62, sx * 0.9, FRONT + 0.01, 0.94, head)
        d.box(sx * 0.68, FRONT - 0.03, 0.66, sx * 0.72, FRONT + 0.005, 0.9, head)
        d.box(sx * 0.9, REAR - 0.03, 1.0, sx * 0.96, REAR + 0.01, 1.75, tail)
    # front: a dark sensor band, a lower grille, the emblem on the nose
    d.box(-0.6, FRONT - 0.02, 0.72, 0.6, FRONT + 0.012, 0.8, lens)
    d.box(-0.55, FRONT - 0.02, 0.46, 0.55, FRONT + 0.015, 0.58, trim)
    emblem(d, (0.0, FRONT + 0.015, 0.9), 0.16, teal, axis="y")
    # sides: the emblem on each cargo panel
    for sx in (1, -1):
        emblem(d, (sx * (HW + 0.012), -0.6, 1.55), 0.55, teal, axis="x", side=sx)
    # camera pods instead of mirrors, a roof sensor fin, rear step and wheel-arch liners
    for sx in (1, -1):
        d.box(sx * 1.0, 1.95, 1.62, sx * 1.06, 2.05, 1.7, trim)
        d.push(Matrix.Translation((sx * 1.08, 2.0, 1.7)))
        d.sphere((0, 0, 0), 0.06, 10, 6, paint, scale=(1.0, 1.3, 0.9))
        d.box(-0.04, 0.06, -0.025, 0.04, 0.095, 0.025, lens)
        d.pop()
    d.box(-0.25, 0.9, ROOF, 0.25, 1.4, ROOF + 0.12, trim)
    d.box(-0.85, REAR - 0.18, 0.36, 0.85, REAR - 0.02, 0.44, trim)
    for yw in (Y_F, Y_R):
        d.push(Matrix.Translation((0, yw, WR + 0.03)) @ Matrix.Rotation(math.pi / 2, 4, "Y"))
        d.lathe([(ARCH_R - 0.01, 0.98), (ARCH_R - 0.01, -0.98)], 12, under, smooth=False, arc=(math.pi / 2, 3 * math.pi / 2))
        d.pop()
    body.add(d)
    body.build("body", parent=root, sharp_angle=30)

    # ---- rear barn doors on hinges at the rear corners
    hw_r, zb_r, zs_r, ht_r, zt_r = interp(REAR)
    for side, sx in (("L", -1), ("R", 1)):
        dm = fc.MeshBuilder()
        w = hw_r - 0.02
        # in the door's frame: hinge at the origin, the door spans toward the centre (-sx)
        dm.box(0.0, -0.05, 0.45 - 0.0, -sx * w, 0.0, zt_r - 0.12, paint)
        dm.box(-sx * (w - 0.04), 0.0, 0.62, -sx * (w - 0.1), 0.01, 0.66, trim)  # handle
        dm.box(-sx * 0.12, 0.0, 0.5, -sx * (w - 0.15), 0.008, 0.62, teal)  # moat band continues
        door = dm.build(f"door_rear_{side}", parent=root, location=(sx * hw_r, REAR - 0.012, 0.0))
        door["hingeAxis"] = [0, 1, 0]
        door["openRad"] = 1.75 * sx
        door["door"] = "rear"

    for name, y, sx in (("wheel_FL", Y_F, -1), ("wheel_FR", Y_F, 1), ("wheel_RL", Y_R, -1), ("wheel_RR", Y_R, 1)):
        V.wheel(name, WR, WW, tire, rim, hub=trim, side=sx, parent=root, seg=16, spokes=6,
                location=(sx * (HW - WW / 2 - 0.02), y, WR), extras={"steer": name.startswith("wheel_F")})

    fc.export_glb("moat-van.glb", BUDGET)


def emblem(mb, centre, size, mat, axis="x", side=1):
    """The invented Moat Labs mark: a keep with three merlons over two wavy lines of water.
    Pure geometry (no text). axis: the panel's normal (x for a side, y for the nose)."""
    cx, cy, cz = centre
    s = size
    t = 0.012
    parts = []
    # the keep: a block with a door notch, three merlons on top
    parts.append((-0.28, 0.0, 0.28, 0.42))
    for k in (-1, 0, 1):
        parts.append((k * 0.2 - 0.07, 0.42, k * 0.2 + 0.07, 0.55))
    # two wavy lines (stepped) below it: the moat
    for row, z in ((0, -0.1), (1, -0.22)):
        for k in range(6):
            x0 = -0.45 + k * 0.15
            dz = 0.03 if (k + row) % 2 else 0.0
            parts.append((x0, z + dz, x0 + 0.13, z + dz + 0.05))
    for (u0, v0, u1, v1) in parts:
        if axis == "x":
            mb.box(cx, cy + u0 * s * -side, cz + v0 * s, cx + side * t, cy + u1 * s * -side, cz + v1 * s, mat)
        else:
            mb.box(cx + u0 * s, cy, cz + v0 * s, cx + u1 * s, cy + t, cz + v1 * s, mat)


main()
