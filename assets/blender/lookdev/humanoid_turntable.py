"""Look-dev: humanoid turntable -> assets/blender/lookdev/humanoid-turntable.png

The founder look from the front, three-quarter, side and back (decoded from the crowd VAT),
then the player body (player.glb, skinned, at rest) wearing the water blaster, from the front
three-quarter and from behind (the tank on the back, the wand in the right hand).
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
    vat = A.Vat("adult", "0")
    cols = vat.colors("vest_charcoal", "brown", 1)
    for i, h in enumerate((180, 135, 90, 0)):
        ob = vat.body(f"founder_{i}", "idle", 0, "founder", cols)
        A.place(ob, -4.2 + 1.2 * i, heading_deg=h)
    for x, h in ((1.6, 150), (3.0, 330)):
        for file in ("player.glb", "water-blaster.glb"):
            root, objs = L.import_glb(file, x=x, heading_deg=h)
            A.rest_pose(objs.values())
    L.camera((-0.6, -17.0, 2.4), (-0.6, 0.0, 0.95), lens=60)
    L.render("humanoid-turntable.png")


main()
