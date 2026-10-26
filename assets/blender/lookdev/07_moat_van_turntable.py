"""Look-dev 07: the Moat Labs van -> assets/blender/lookdev/07-moat-van-turntable.png

Front three-quarter, side, and rear three-quarter with the barn doors swung open by their
openRad extras; teal accent line lit as at dusk.
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
    for x, h, open_doors in ((-7.6, 145, False), (0.0, 90, False), (7.6, -35, True)):
        root, objs = L.import_glb("moat-van.glb", x=x, heading_deg=h)
        A.lights_on(objs.values(), 3.0)
        if open_doors:
            for o in objs.values():
                if o.name.startswith("door_rear"):
                    o.rotation_mode = "XYZ"
                    # glTF local +Y is Blender local +Z
                    o.rotation_euler.z += o.get("openRad", 0.0)
    L.camera((0.0, -34.0, 4.0), (0.0, 0.0, 1.1), lens=52)
    L.render("07-moat-van-turntable.png")


main()
