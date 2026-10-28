"""Look-dev 09: the Meander robotaxi -> assets/blender/lookdev/09-meander-turntable.png

Left to right: the kerb side from the front three-quarter (sliding door shut), the street
side broadside (no door, two windows either side of a white post: the sides differ), and the
kerb side from the rear three-quarter with the door popped out by its popM and slid back by
its slideM extras. The pod is the same both ways round, so the light bars say which end is
the front. Lights lit as at dusk so the teal status line in the roof band shows.
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
    for x, h, open_door in ((-6.3, 145, False), (0.0, 270, False), (6.3, 35, True)):
        root, objs = L.import_glb("robotaxi.glb", x=x, heading_deg=h)
        A.lights_on(objs.values(), 3.0)
        if open_door:
            for o in objs.values():
                if o.name.startswith("door_slide"):
                    # glTF local +X is Blender local +X; glTF local +Z is Blender local -Y
                    o.location.x += o.get("popM", 0.0)
                    o.location.y -= o.get("slideM", 0.0)
    L.camera((0.0, -28.0, 3.6), (0.0, 0.0, 0.85), lens=52)
    L.render("09-meander-turntable.png")


main()
