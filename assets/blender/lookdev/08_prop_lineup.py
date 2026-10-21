"""Look-dev 08: the wave-2 prop lineup -> assets/blender/lookdev/08-prop-lineup.png

Left to right: hydrant, drinking fountain, traffic cone, the player wearing the water blaster,
repair kiosk, vendor cart, wheelchair, the three rust heaps, a pigeon (standing and pecking)
and the leashed dog (both strides). All imported from public/models.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import fc  # noqa: E402
import lookdev as L  # noqa: E402
import lookdev_assets as A  # noqa: E402


def main() -> None:
    fc.reset()
    A.studio(res=(1800, 700), samples=48)
    # back row: the big pieces; front row: the street-level ones
    row = [
        ("repair-kiosk.glb", -3.6, 2.6, 165, {}),
        ("player.glb", -1.5, 2.2, 150, {}),
        ("water-blaster.glb", -1.5, 2.2, 150, {}),
        ("vendor-cart.glb", 1.3, 2.6, 172, {}),
        ("wheelchair.glb", 3.7, 2.3, 140, {}),
        ("hydrant.glb", -4.6, 0.0, 160, {}),
        ("drinking-fountain.glb", -3.8, 0.0, 160, {}),
        ("traffic-cone.glb", -3.0, 0.0, 160, {}),
        ("heap-porter.glb", -1.7, 0.0, 160, {}),
        ("heap-trundle.glb", -0.1, 0.0, 160, {}),
        ("heap-mixed.glb", 1.6, 0.0, 160, {}),
        ("pigeon.glb", 2.9, -0.2, 120, {}),
        ("pigeon.glb", 3.25, 0.1, 200, {"peck": 1.0}),
        ("dog.glb", 4.3, 0.0, 120, {}),
    ]
    for file, x, y, h, keys in row:
        root, objs = L.import_glb(file, x=x, y=y, heading_deg=h)
        A.rest_pose(objs.values())
        A.lights_on(objs.values(), 3.0)
        if keys:
            A.set_keys(objs.values(), **keys)
    L.camera((0.0, -13.5, 3.6), (0.0, 1.0, 0.75), lens=45)
    L.render("08-prop-lineup.png")


main()
