"""Look-dev 05: the Porter -> assets/blender/lookdev/05-porter-turntable.png

Left to right: front, three-quarter, side and back at rest; then the melt sequence as the
renderer plays it, with the rust preview driven by _RUST_MASK: seized (rust 0.35), slumping
(0.6), melted (0.9), and the heap prop that replaces it. Imported from the exported GLBs.
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
    xs = [-5.8, -4.45, -3.1, -1.75, -0.1, 1.45, 3.0, 4.55, 6.1]
    views = [180, 135, 90, 0]
    for x, h in zip(xs[:4], views):
        root, objs = L.import_glb("errand-robot.glb", x=x, heading_deg=h)
        A.lights_on(objs.values(), 4.0)
    for x, (key, rust) in zip(xs[5:], (("seize", 0.35), ("slump", 0.6), ("melt", 0.9))):
        root, objs = L.import_glb("errand-robot.glb", x=x, heading_deg=160)
        A.set_keys(objs.values(), **{key: 1.0})
        A.rust_preview(objs.values(), rust, key)
        A.lights_on(objs.values(), 1.5 if key == "seize" else 0.0)
    L.import_glb("heap-porter.glb", x=xs[8] - 0.2, heading_deg=160)
    L.camera((0.15, -24.0, 1.9), (0.15, 0.0, 0.95), lens=62)
    L.render("05-porter-turntable.png")


main()
