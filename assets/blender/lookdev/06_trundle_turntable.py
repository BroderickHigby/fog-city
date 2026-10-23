"""Look-dev 06: the Trundle -> assets/blender/lookdev/06-trundle-turntable.png

Front, three-quarter, side and back at rest; the roll-top lid rolled open (lidOpenRad) with
its cargo; then seized, slumping and melted with the rust preview, and the heap prop.
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
    xs = [-3.5, -2.65, -1.8, -0.95, 0.0, 0.95, 1.85, 2.75, 3.75]
    for x, h in zip(xs, [180, 140, 90, 0, 150]):
        root, objs = L.import_glb("sidewalk-bot.glb", x=x, heading_deg=h)
        A.lights_on(objs.values(), 4.0)
        if x == xs[4]:
            lid = next(o for o in objs.values() if o.name.startswith("lid"))
            lid.rotation_mode = "XYZ"
            # glTF local +X rotation by lidOpenRad is Blender local +X by the same angle
            lid.rotation_euler.x += lid.get("lidOpenRad", 1.57)
    for x, (key, rust) in zip(xs[5:8], (("seize", 0.35), ("slump", 0.6), ("melt", 0.9))):
        root, objs = L.import_glb("sidewalk-bot.glb", x=x, heading_deg=150)
        A.set_keys(objs.values(), **{key: 1.0})
        A.rust_preview(objs.values(), rust, key)
        A.lights_on(objs.values(), 1.5 if key == "seize" else 0.0)
    L.import_glb("heap-trundle.glb", x=xs[8], heading_deg=150)
    L.camera((0.12, -14.0, 1.55), (0.12, 0.0, 0.32), lens=60)
    L.render("06-trundle-turntable.png")


main()
