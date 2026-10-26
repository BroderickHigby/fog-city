"""The player's car: an original compact electric hatchback -> public/models/player-car.glb

4.30 m long, 1.80 m wide, 1.50 m tall, 2.70 m wheelbase. Rounded two-box body with a glass
roof, full-width light bars front and rear, black wheel-arch cladding. No real make copied,
no badges. The body colour is the "paint" material so the renderer can recolour it.

Nodes: player_car (root, origin on the ground at the body's centre), body,
wheel_FL/FR/RL/RR (origin at the hub, spin about local X; extras wheel/spinAxis/radius/steer).
Front faces glTF -Z. Budget: 8k triangles.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import fc  # noqa: E402
import vehicle as V  # noqa: E402

BUDGET = 8_000
L, W = 4.30, 1.80
WB = 2.70
WR = 0.35  # wheel radius
WW = 0.215
ARCH_R = 0.405
Y_F, Y_R = WB / 2, -WB / 2

# (y, half width, sill z, shoulder z, centre-top z)
STATIONS = [
    (2.15, 0.72, 0.30, 0.56, 0.58),
    (2.12, 0.81, 0.25, 0.62, 0.65),
    (2.04, 0.865, 0.22, 0.68, 0.72),
    (1.85, 0.895, 0.21, 0.75, 0.80),
    (1.50, 0.90, 0.20, 0.82, 0.87),
    (1.10, 0.90, 0.20, 0.87, 0.92),
    (0.80, 0.90, 0.20, 0.89, 0.94),
    (0.00, 0.90, 0.20, 0.91, 0.95),
    (-0.80, 0.90, 0.20, 0.925, 0.965),
    (-1.50, 0.895, 0.21, 0.94, 0.98),
    (-1.85, 0.88, 0.23, 0.95, 0.99),
    (-2.02, 0.85, 0.26, 0.94, 0.97),
    (-2.12, 0.80, 0.30, 0.90, 0.92),
    (-2.15, 0.74, 0.34, 0.86, 0.88),
]
# greenhouse: (y, roof half width, roof z, crown); None = the glass meets the body here.
# The belt line is the body section's shoulder point at the same y.
GLASS_STATIONS = [
    (0.80, None, None, 0.0),
    (-0.02, 0.66, 1.42, 0.025),
    (-0.42, 0.68, 1.47, 0.03),
    (-0.52, 0.68, 1.475, 0.03),
    (-1.30, 0.665, 1.455, 0.03),
    (-1.52, 0.62, 1.41, 0.025),
    (-1.92, None, None, 0.0),
]


def main() -> None:
    fc.reset()
    paint = fc.material("paint", "#e0532b", 0.32, 0.1)
    glass = fc.material("glass", "#1e2a33", 0.08, 0.6)
    trim = fc.material("trim_black", "#16181b", 0.55, 0.1)
    under = fc.material("underbody", "#0e0f10", 0.9)
    tire = fc.material("tire", "#151515", 0.85)
    rim = fc.material("rim", "#b9bdc2", 0.3, 0.9)
    head = fc.material("light_headlight", "#f4f6f8", 0.2, emission="#fff6e6", strength=1.0)
    tail = fc.material("light_taillight", "#8a1010", 0.3, emission="#ff2a1a", strength=1.0)

    root = fc.empty("player_car")
    body = fc.MeshBuilder()  # smooth skin, welded
    mb = fc.MeshBuilder()  # separate details

    body, _ = V.car_body(STATIONS, GLASS_STATIONS, (Y_F, Y_R), WR, ARCH_R,
                         dict(paint=paint, glass=glass, trim=trim, under=under),
                         pillars=dict(b=(-0.52, -0.42), c=-1.30))

    # roof rails and the glass roof's frame
    for sx in (1, -1):
        pts = [(sx * hr, y, zr + 0.005) for (y, hr, zr, cr) in GLASS_STATIONS[1:-1]]
        for p0, p1 in zip(pts, pts[1:]):
            mb.cyl_between(p0, p1, 0.022, 6, trim, caps=False)
    # light bars
    hw0 = STATIONS[0][1]
    V.strip(mb, -0.70, 0.70, 2.135, 2.16, 0.66, 0.045, head)
    V.strip(mb, -0.70, 0.70, -2.165, -2.135, 0.84, 0.05, tail)
    # lower grille slot and rear diffuser
    mb.box(-0.45, 2.10, 0.36, 0.45, 2.165, 0.44, trim)
    mb.box(-0.55, -2.16, 0.36, 0.55, -2.10, 0.44, trim)
    # mirrors
    for sx in (1, -1):
        mb.box(sx * 0.80, 0.58, 0.925, sx * 0.88, 0.64, 0.95, trim)  # stalk
        mb.frustum([(sx * 0.86, 0.56), (sx * 1.02, 0.54), (sx * 1.02, 0.66), (sx * 0.86, 0.68)][:: sx],
                   [(sx * 0.86, 0.57), (sx * 1.01, 0.56), (sx * 1.01, 0.65), (sx * 0.86, 0.67)][:: sx],
                   0.93, 1.05, paint, top=True, bottom=True)
        mb.box(sx * 0.87, 0.535, 0.94, sx * 1.0, 0.545, 1.035, glass)
    # wheel-arch liners so the arch never shows daylight
    for yw in (Y_F, Y_R):
        mb.push(fc.Matrix.Translation((0, yw, WR + 0.02)) @ fc.Matrix.Rotation(math.pi / 2, 4, "Y"))
        mb.lathe([(ARCH_R - 0.01, 0.86), (ARCH_R - 0.01, -0.86)], 12, under, smooth=False, arc=(math.pi / 2, 3 * math.pi / 2))
        mb.pop()
    body.add(mb)
    body.build("body", parent=root, sharp_angle=38)

    for name, y, sx in (("wheel_FL", Y_F, -1), ("wheel_FR", Y_F, 1), ("wheel_RL", Y_R, -1), ("wheel_RR", Y_R, 1)):
        V.wheel(name, WR, WW, tire, rim, hub=trim, side=sx, parent=root,
                location=(sx * (0.90 - WW / 2 - 0.02), y, WR), extras={"steer": name.startswith("wheel_F")})

    fc.export_glb("player-car.glb", BUDGET)


main()
