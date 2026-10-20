"""Look-dev: the humanoid clip library -> assets/blender/lookdev/humanoid-clips.png

One body per clip moment, decoded from the crowd VAT at that frame: walk (mid-stride), idle,
the dive (crouch, airborne, landed on the side, back up), wet shake, sit on a 0.45 m bench,
talk, and the child walking. Every dive frame is placed at its own spot, so the root motion
shows.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import fc  # noqa: E402
import lookdev as L  # noqa: E402
import lookdev_assets as A  # noqa: E402


def main() -> None:
    fc.reset()
    A.studio(res=(1800, 640), samples=48)
    adult, child = A.Vat("adult", "0"), A.Vat("child", "0")
    shots = [
        (adult, "walk", 5, "founder", ("vest_charcoal", "black", 5), -7.4, 160),
        (adult, "idle", 9, "attendee", ("conference_red", "dark_brown", 1), -6.3, 165),
        (adult, "wet_shake", 12, "engineer", ("hoodie_heather", "auburn", 0), -5.0, 170),
        (adult, "talk", 6, "partner", ("partner_vest", "grey", 3), -3.7, 150),
        (adult, "sit", 0, "local", ("rain_orange", "brown", 2), -2.4, 160),
        (adult, "dive", 3, "student", ("student_green", "black", 3), -1.3, 180),
        (adult, "dive", 6, "student", ("student_green", "black", 3), -0.9, 180),
        (adult, "dive", 13, "student", ("student_green", "black", 3), 0.1, 180),
        (adult, "dive", 29, "student", ("student_green", "black", 3), 1.0, 180),
        (child, "walk", 4, "child", ("kid_yellow", "black", 4), 3.3, 160),
    ]
    for i, (vat, clip, f, variant, look, x, h) in enumerate(shots):
        ob = vat.body(f"b{i}", clip, f, variant, vat.colors(*look))
        A.place(ob, x, heading_deg=h)
    # a plain bench under the sitter (seat 0.45 m)
    bench = L.flat_material("bench_wood", "#8a6544", 0.7)
    mb = fc.MeshBuilder()
    mb.box(-0.6, -0.05, 0.4, 0.6, 0.38, 0.45, bench)
    for sx in (-0.5, 0.5):
        mb.box(sx - 0.04, 0.0, 0.0, sx + 0.04, 0.33, 0.4, bench)
    ob = mb.build("bench")
    A.place(ob, -2.4, heading_deg=160)
    L.camera((-2.0, -18.0, 2.2), (-2.0, 0.0, 0.8), lens=55)
    L.render("humanoid-clips.png")


main()
