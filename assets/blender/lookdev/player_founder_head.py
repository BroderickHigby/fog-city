"""Look-dev: the player's face -> assets/blender/lookdev/player-founder-head.png

founder-default head and shoulders, smiling (the default smile weight), from the front and from
the front three-quarter (the right cheek toward the camera): public/models/player.glb as the
game loads it, at rest. The hair silhouette (the quiff, node hair_quiff), the colouring, the
jaw and the grin are what make the likeness. The reference photos are kept outside the
repository and appear in no committed image.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import fc  # noqa: E402
import lookdev as L  # noqa: E402
import lookdev_assets as A  # noqa: E402


def main() -> None:
    fc.reset()
    A.studio(res=(1600, 900), samples=64)
    # a soft key from the front left, so the face reads at this size
    L.point_light((-1.6, -2.6, 2.4), 120.0, "#fff1e2", kind="AREA", size=(1.4, 1.4),
                  rot=(math.radians(60), 0.0, math.radians(-30)))
    for x, h in ((-0.42, 180), (0.42, 140)):
        _, objs = L.import_glb("player.glb", x=x, heading_deg=h)
        A.rest_pose(objs.values())
        A.default_look(objs.values())
    L.camera((0.0, -3.3, 1.66), (0.0, 0.0, 1.6), lens=85)
    L.render("player-founder-head.png")


main()
