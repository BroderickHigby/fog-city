"""An original SF robotaxi -> public/models/robotaxi.glb

A white electric crossover (4.75 m long, 1.92 m wide, 1.66 m to the roof) that reads as
"robotaxi" at a glance: a low sensor crown on the roof with a spinning lidar dome on top
(node sensor_dome, spins about its local Y), four corner sensor pods, camera pods where the
mirrors would be, charcoal cladding and a teal status ring (light_status, emissive) round
the dome's base. No real vehicle's shape, light signature or livery; no badges, no text.

Nodes: robotaxi (root, origin on the ground at the body centre), body, sensor_dome,
wheel_FL/FR/RL/RR (origin at the hub, spin about local X). Front faces glTF -Z.
Budget: 10k triangles.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

from mathutils import Matrix  # noqa: E402

import fc  # noqa: E402
import vehicle as V  # noqa: E402

BUDGET = 10_000
WB = 2.90
WR = 0.375
WW = 0.24
ARCH_R = 0.44
Y_F, Y_R = WB / 2, -WB / 2

STATIONS = [
    (2.37, 0.78, 0.40, 0.70, 0.73),
    (2.33, 0.88, 0.33, 0.77, 0.81),
    (2.24, 0.93, 0.30, 0.84, 0.89),
    (2.02, 0.955, 0.29, 0.92, 0.97),
    (1.60, 0.96, 0.28, 0.98, 1.03),
    (1.15, 0.96, 0.28, 1.02, 1.07),
    (0.90, 0.96, 0.28, 1.03, 1.08),
    (0.00, 0.96, 0.28, 1.05, 1.09),
    (-1.00, 0.96, 0.28, 1.06, 1.10),
    (-1.80, 0.955, 0.29, 1.07, 1.11),
    (-2.10, 0.94, 0.31, 1.07, 1.10),
    (-2.30, 0.90, 0.35, 1.04, 1.07),
    (-2.37, 0.84, 0.40, 0.99, 1.01),
]
GLASS_STATIONS = [
    (0.92, None, None, 0.0),
    (0.18, 0.76, 1.60, 0.03),
    (-0.38, 0.775, 1.65, 0.035),
    (-0.50, 0.775, 1.655, 0.035),
    (-1.70, 0.765, 1.645, 0.035),
    (-1.98, 0.73, 1.58, 0.03),
    (-2.20, None, None, 0.0),
]
ROOF_Z = 1.655


def main() -> None:
    fc.reset()
    paint = fc.material("paint_white", "#f1f2f0", 0.3, 0.05)
    glass = fc.material("glass", "#1b232b", 0.08, 0.6)
    clad = fc.material("cladding", "#2a2d31", 0.7)
    under = fc.material("underbody", "#0e0f10", 0.9)
    tire = fc.material("tire", "#151515", 0.85)
    rim = fc.material("rim", "#2f3338", 0.35, 0.7)
    lens = fc.material("sensor_lens", "#0b0d10", 0.06, 0.4)
    head = fc.material("light_headlight", "#f4f6f8", 0.2, emission="#f2f7ff", strength=1.0)
    tail = fc.material("light_taillight", "#8a1010", 0.3, emission="#ff2a1a", strength=1.0)
    status = fc.material("light_status", "#2fd6c1", 0.3, emission="#2fffe0", strength=1.0)

    root = fc.empty("robotaxi")
    body, rows = V.car_body(STATIONS, GLASS_STATIONS, (Y_F, Y_R), WR, ARCH_R,
                            dict(paint=paint, glass=glass, trim=clad, under=under, roof=paint),
                            pillars=dict(b=(-0.50, -0.38), c=-1.70), clad_segments=2, mid=0.3)
    mb = fc.MeshBuilder()

    # --- sensor crown: a low white plinth with a dark camera window band all round
    cx0, cx1, cy0, cy1 = -0.56, 0.56, -0.95, 0.35
    z0 = ROOF_Z - 0.03
    r = 0.12
    crown = []
    for (cx, cy, a0) in ((cx1 - r, cy1 - r, 0), (cx0 + r, cy1 - r, 90), (cx0 + r, cy0 + r, 180), (cx1 - r, cy0 + r, 270)):
        for k in range(4):
            a = math.radians(a0 + 90 * k / 3)
            crown.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    mb.prism(crown, z0, z0 + 0.07, paint, top=False)
    mb.frustum(crown, [(x * 0.97, y * 0.97 - 0.01) for x, y in crown], z0 + 0.07, z0 + 0.12, lens, top=False)
    mb.frustum([(x * 0.97, y * 0.97 - 0.01) for x, y in crown], [(x * 0.93, y * 0.93 - 0.02) for x, y in crown], z0 + 0.12, z0 + 0.16, paint, top=True)
    # pedestal and status ring under the dome
    zp = z0 + 0.16
    mb.push(Matrix.Translation((0, -0.30, 0)))
    mb.cylinder(0.24, zp, zp + 0.06, 24, clad, caps=True)
    mb.lathe([(0.265, zp + 0.005), (0.265, zp + 0.04), (0.24, zp + 0.04)], 24, status, smooth=False)
    mb.pop()

    # --- corner pods: lidar pucks at the four corners, lens facing out at 45 degrees
    for sx in (1, -1):
        for (py, pz, sy) in ((2.02, 0.86, 1), (-2.17, 1.0, -1)):
            mb.push(Matrix.Translation((sx * 0.86, py, pz)))
            mb.cylinder(0.08, 0.0, 0.17, 12, paint, caps=True)
            mb.push(Matrix.Rotation(math.atan2(sy, sx) - math.pi / 2, 4, "Z"))
            mb.box(-0.05, 0.055, 0.08, 0.05, 0.085, 0.155, lens)
            mb.pop()
            mb.pop()
    # camera pods where mirrors would be
    for sx in (1, -1):
        mb.box(sx * 0.86, 0.60, 1.04, sx * 0.97, 0.66, 1.07, clad)
        mb.push(Matrix.Translation((sx * 1.03, 0.62, 1.08)))
        mb.sphere((0, 0, 0), 0.075, 10, 6, paint, scale=(1.0, 1.4, 0.9))
        mb.box(-0.05, 0.07, -0.03, 0.05, 0.11, 0.03, lens)
        mb.pop()
    # front: slim headlights at the corners joined by a dark sensor band; radar patch
    for sx in (1, -1):
        V.strip(mb, sx * 0.50, sx * 0.80, 2.32, 2.36, 0.74, 0.05, head)
    mb.box(-0.48, 2.33, 0.715, 0.48, 2.37, 0.765, lens)
    mb.box(-0.16, 2.35, 0.48, 0.16, 2.385, 0.58, lens)
    # rear: wrap-around tail strips
    for sx in (1, -1):
        V.strip(mb, sx * 0.40, sx * 0.86, -2.40, -2.35, 0.98, 0.06, tail)
    mb.box(-0.40, -2.39, 0.955, 0.40, -2.355, 1.005, lens)
    # door seams (thin dark lines on the white body)
    for y in (0.85, -0.44, -1.72):
        for sx in (1, -1):
            mb.box(sx * 0.955, y - 0.008, 0.45, sx * 0.968, y + 0.008, 1.02, clad)
    # roof rails
    for sx in (1, -1):
        pts = [(sx * hr, y, zr + 0.01) for (y, hr, zr, cr) in GLASS_STATIONS[1:-1]]
        for p0, p1 in zip(pts, pts[1:]):
            mb.cyl_between(p0, p1, 0.025, 6, clad, caps=False)
    # wheel-arch liners
    for yw in (Y_F, Y_R):
        mb.push(Matrix.Translation((0, yw, WR + 0.02)) @ Matrix.Rotation(math.pi / 2, 4, "Y"))
        mb.lathe([(ARCH_R - 0.01, 0.92), (ARCH_R - 0.01, -0.92)], 12, under, smooth=False, arc=(math.pi / 2, 3 * math.pi / 2))
        mb.pop()
    body.add(mb)
    body.build("body", parent=root, sharp_angle=38)

    # --- the spinning lidar dome (its own node; origin on the spin axis at its base)
    d = fc.MeshBuilder()
    d.cylinder(0.2, 0.0, 0.035, 24, clad, caps=False)
    d.lathe([(0.2, 0.035), (0.205, 0.17)], 24, lens, smooth=True)
    d.lathe([(0.205, 0.17), (0.2, 0.19), (0.17, 0.235), (0.11, 0.265), (0.0, 0.275)], 24, paint, smooth=True)
    d.box(-0.04, 0.19, 0.06, 0.04, 0.215, 0.15, paint)  # a fin so the spin is visible
    dome = d.build("sensor_dome", parent=root, location=(0, -0.30, zp + 0.06))
    dome["spinAxis"] = [0, 1, 0]

    for name, y, sx in (("wheel_FL", Y_F, -1), ("wheel_FR", Y_F, 1), ("wheel_RL", Y_R, -1), ("wheel_RR", Y_R, 1)):
        V.wheel(name, WR, WW, tire, rim, hub=clad, side=sx, parent=root,
                location=(sx * (0.96 - WW / 2 - 0.03), y, WR), extras={"steer": name.startswith("wheel_F")})

    fc.export_glb("robotaxi.glb", BUDGET)


main()
