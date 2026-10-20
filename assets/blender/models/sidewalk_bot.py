"""An original six-wheeled sidewalk delivery bot -> public/models/sidewalk-bot.glb

Knee-high (0.62 m to the lid, 0.76 m long, 0.58 m wide) insulated cargo box on six small
wheels, with a coral lid, a graphite bumper band, two round "eyes" on the front
(light_eyes, emissive) and a tall whip flag so drivers can see it.

Nodes: sidewalk_bot (root, ground), body, wheel_L1/L2/L3, wheel_R1/R2/R3 (1 = front; origin
at the hub, spin about local X), flag (origin at the pole's foot, so it can sway).
Front faces glTF -Z. Budget: 3k triangles.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

from mathutils import Matrix  # noqa: E402

import fc  # noqa: E402
import vehicle as V  # noqa: E402

BUDGET = 3_000
L, W = 0.76, 0.58
Z0, Z1 = 0.13, 0.55
WR = 0.095


def rounded_rect(hx, hy, r, n=3):
    pts = []
    for (cx, cy, a0) in ((hx - r, hy - r, 0), (-hx + r, hy - r, 90), (-hx + r, -hy + r, 180), (hx - r, -hy + r, 270)):
        for k in range(n + 1):
            a = math.radians(a0 + 90 * k / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts


def main() -> None:
    fc.reset()
    shell = fc.material("shell_white", "#eeeeea", 0.4)
    lid = fc.material("lid_coral", "#f06d4f", 0.45)
    band = fc.material("bumper_graphite", "#2b2f35", 0.6)
    tire = fc.material("tire", "#161616", 0.85)
    hub = fc.material("hub", "#9aa0a6", 0.4, 0.6)
    eye = fc.material("light_eyes", "#e9fbff", 0.2, emission="#d8f6ff", strength=1.0)
    flagm = fc.material("flag_orange", "#ff8a1f", 0.6, double_sided=True)
    pole = fc.material("flag_pole", "#e8e8e8", 0.4)

    root = fc.empty("sidewalk_bot")
    root["fcActor"] = "sidewalk-bot"
    mb = fc.MeshBuilder()
    hx, hy = W / 2, L / 2
    rr = rounded_rect(hx, hy, 0.09)
    mb.prism(rr, Z0, Z0 + 0.09, band, top=False, bottom=True)
    mb.prism(rounded_rect(hx - 0.01, hy - 0.01, 0.085), Z0 + 0.09, Z1 - 0.04, shell, top=False)
    mb.frustum(rounded_rect(hx - 0.01, hy - 0.01, 0.085), rounded_rect(hx - 0.04, hy - 0.04, 0.07), Z1 - 0.04, Z1, shell, top=False)
    # lid: a shallow coral dome with a seam
    lid_b = rounded_rect(hx - 0.035, hy - 0.035, 0.07)
    lid_t = rounded_rect(hx - 0.08, hy - 0.08, 0.05)
    mb.frustum(lid_b, lid_b, Z1, Z1 + 0.025, band, top=False)
    mb.frustum(lid_b, lid_t, Z1 + 0.025, Z1 + 0.07, lid, top=True)
    # front face: two round eyes in dark bezels
    for sx in (1, -1):
        mb.push(Matrix.Translation((sx * 0.11, hy - 0.002, 0.40)) @ Matrix.Rotation(-math.pi / 2, 4, "X"))
        mb.lathe([(0.062, 0.0), (0.062, 0.012), (0.05, 0.012)], 16, band, smooth=False)
        mb.lathe([(0.05, 0.008), (0.0, 0.014)], 16, eye, smooth=True)
        mb.pop()
    # side fenders over the wheel line
    for sx in (1, -1):
        mb.box(sx * (hx - 0.005), -0.36, Z0 - 0.005, sx * (hx + 0.03), 0.36, Z0 + 0.05, band)
    # flag socket at the rear left corner
    mb.push(Matrix.Translation((-(hx - 0.07), -(hy - 0.07), 0)))
    mb.cylinder(0.022, Z1 - 0.02, Z1 + 0.09, 8, band)
    mb.pop()
    mb.build("body", parent=root, sharp_angle=40)

    # whip flag: thin pole and a pennant; origin at the pole foot
    f = fc.MeshBuilder()
    top = 1.42 - (Z1 + 0.09)
    f.cylinder(0.008, 0.0, top, 6, pole, caps=True)
    f.poly_n([(0.0, 0.0, top - 0.02), (0.0, -0.30, top - 0.09), (0.0, 0.0, top - 0.20)], flagm, (1, 0, 0))
    flag = f.build("flag", parent=root, location=(-(hx - 0.07), -(hy - 0.07), Z1 + 0.09))
    flag["swayAxis"] = [1, 0, 0]

    for side, sx in (("L", -1), ("R", 1)):
        for k, y in enumerate((0.26, 0.0, -0.26), start=1):
            V.wheel(f"wheel_{side}{k}", WR, 0.07, tire, hub, hub=band, seg=12, spokes=3, side=sx,
                    parent=root, location=(sx * (hx + 0.005), y, WR))

    fc.export_glb("sidewalk-bot.glb", BUDGET)


main()
