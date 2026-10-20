"""Look-dev: the humanoid body variants -> assets/blender/lookdev/humanoid-variants.png

The eight adult variants and the two child looks, each at its middle height scale and in one
of its suggested outfits, standing in the idle clip's first frame. Every body is decoded from
the vertex-animation textures (positions, rotations and shape-key deltas) the same way the
crowd shader decodes them (lib/lookdev_assets.Vat), so this is what the game draws.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import fc  # noqa: E402
import lookdev as L  # noqa: E402
import lookdev_assets as A  # noqa: E402

LOOKS = {
    "founder": ("vest_charcoal", "brown", 1),
    "engineer": ("hoodie_heather", "black", 4),
    "partner": ("partner_vest", "grey", 0),
    "attendee": ("conference_red", "dark_brown", 3),
    "local": ("rain_orange", "black", 5),
    "elder": ("retiree_beige", "white", 2),
    "runner": ("athleisure", "blonde", 1),
    "student": ("student_green", "auburn", 0),
    "child": ("kid_yellow", "black", 3),
    "child_long_hair": ("kid_blue", "brown", 2),
}


def main() -> None:
    fc.reset()
    A.studio(res=(1800, 640), samples=48)
    adult, child = A.Vat("adult", "0"), A.Vat("child", "0")
    x = -6.3
    for v in adult.meta["variants"]:
        vat = child if v["child"] else adult
        outfit, hair, skin = LOOKS[v["id"]]
        s = sum(v["heightScale"]) / 2
        ob = vat.body(v["id"], "idle", 0, v["id"], vat.colors(outfit, hair, skin), scale=s)
        A.place(ob, x, heading_deg=165)
        x += 1.15 if not v["child"] else 0.95
    L.camera((-1.0, -20.5, 1.9), (-1.0, 0.0, 0.95), lens=60)
    L.render("humanoid-variants.png")


main()
