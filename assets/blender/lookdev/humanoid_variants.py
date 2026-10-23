"""Look-dev: the humanoid body variants -> assets/blender/lookdev/humanoid-variants.png

The eight adult variants and the two child looks, each in one of its suggested outfits at a
height scale inside its range (so the lineup shows the spread of heights), standing in the
idle clip's first frame. Every body is decoded from the vertex-animation textures (positions,
rotations and shape-key deltas) the same way the crowd shader decodes them
(lib/lookdev_assets.Vat), so this is what the game draws.

Skin tones are spread across the roles on purpose: at runtime skin is independent of the
variant (the sim samples it uniformly), and the sign-off image must not pair a tone with a
build or a role. The satirised roles (founder, engineer, partner, attendee) span the range.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import fc  # noqa: E402
import lookdev as L  # noqa: E402
import lookdev_assets as A  # noqa: E402

# variant id: (outfit, hair, skin tone index 0 lightest .. 5 darkest, height scale)
LOOKS = {
    "founder": ("vest_charcoal", "black", 5, 1.03),
    "engineer": ("hoodie_heather", "auburn", 0, 0.95),
    "partner": ("partner_vest", "grey", 3, 1.05),
    "attendee": ("conference_red", "dark_brown", 1, 0.9),
    "local": ("rain_orange", "brown", 2, 0.97),
    "elder": ("retiree_beige", "white", 4, 0.9),
    "runner": ("athleisure", "blonde", 1, 1.07),
    "student": ("student_green", "black", 3, 0.93),
    "child": ("kid_yellow", "black", 4, 1.0),
    "child_long_hair": ("kid_blue", "brown", 0, 0.94),
}


def main() -> None:
    fc.reset()
    A.studio(res=(1800, 640), samples=48)
    adult, child = A.Vat("adult", "0"), A.Vat("child", "0")
    x = -6.3
    for v in adult.meta["variants"]:
        vat = child if v["child"] else adult
        outfit, hair, skin, s = LOOKS[v["id"]]
        lo, hi = v["heightScale"]
        assert lo <= s <= hi, (v["id"], s, v["heightScale"])
        ob = vat.body(v["id"], "idle", 0, v["id"], vat.colors(outfit, hair, skin), scale=s)
        A.place(ob, x, heading_deg=165)
        x += 1.15 if not v["child"] else 0.95
    L.camera((-1.0, -20.5, 1.9), (-1.0, 0.0, 0.95), lens=60)
    L.render("humanoid-variants.png")


main()
