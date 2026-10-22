"""Look-dev: the player's default look -> assets/blender/lookdev/player-founder-turntable.png

founder-default, the player's on-foot body (public/models/player.glb exactly as the game loads
it: its own material colours and default morph weights, so the bomber and the smile are on),
at rest from the front, three-quarter, side and back, in the neutral studio set of the other
wave-2 turntables. founder-default is a stylised likeness of the project owner; the reference
photos are kept outside the repository and appear in no committed image.
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
    for i, h in enumerate((180, 140, 90, 0)):
        _, objs = L.import_glb("player.glb", x=-2.25 + 1.5 * i, heading_deg=h)
        A.rest_pose(objs.values())
        A.default_look(objs.values())
    L.camera((0.0, -11.0, 1.3), (0.0, 0.0, 0.99), lens=60)
    L.render("player-founder-turntable.png")


main()
