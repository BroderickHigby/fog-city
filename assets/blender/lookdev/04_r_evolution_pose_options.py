"""Look-dev 04: the two R-Evolution poses side by side, for the art sign-off ->
assets/blender/lookdev/04-r-evolution-pose-options.png

Left: the game's model (public/models/r-evolution.glb), the real sculpture's stance: Tadasana,
arms open at her sides, palms forward. Right: the brief's "arms raised" variant, built here by
models/r_evolution.py with pose=raised into .cache/variants/raised/ (not a game asset). To make
the raised pose the game's: FC_REVOLUTION_POSE=raised assets/blender/build.sh r_evolution.
Same golden-hour light as look-dev 01, both seen from the front.
"""

import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import bpy  # noqa: E402

import fc  # noqa: E402
import lookdev as L  # noqa: E402

VARIANT_DIR = os.path.join(fc.BLENDER_DIR, ".cache", "variants", "raised")
SCRIPT = os.path.join(fc.BLENDER_DIR, "models", "r_evolution.py")

# build the raised variant with this same Blender, in a clean process
subprocess.run(
    [bpy.app.binary_path, "-b", "--factory-startup", "-noaudio", "--python-exit-code", "1", "-P", SCRIPT, "--",
     "pose=raised", f"out={VARIANT_DIR}"],
    check=True,
    stdout=subprocess.DEVNULL,
)

fc.reset()
L.setup(samples=int(os.environ.get("LOOKDEV_SAMPLES", "64")))
# the camera looks south (-Y), so +X is on the left of the frame
real, real_objs = L.import_glb("r-evolution.glb", x=6.2)
raised, raised_objs = L.import_glb(os.path.join(VARIANT_DIR, "r-evolution.glb"), x=-6.2)
assert real.get("pose") == "tadasana" and raised.get("pose") == "raised", (real.get("pose"), raised.get("pose"))
L.emission(list(real_objs.values()) + list(raised_objs.values()), 0.0)  # by day the glow is off

paving = L.noisy_material("paving", "#9c958b", "#b3ab9f", scale=0.9, rough=0.85, bump=0.03)
L.quad("ground", -200, -200, 200, 200, 0.0, paving)

# golden hour from behind the camera's left, as in look-dev 01
_, to_sun = L.sun(300, 9.0, 8.0, "#ffa257", angle_deg=1.5)
L.world_gradient([(0.0, "#4a4038"), (0.5, "#ffb36e"), (0.535, "#f8bb8c"), (0.6, "#e9b1a6"), (0.7, "#b4b3d0"), (0.85, "#8ea6d6"), (1.0, "#6488c8")],
                 strength=0.65, sun_dir=to_sun, sun_color=(1.0, 0.7, 0.4), sun_glow=3.0)
L.compositor(mist=(30.0, 300.0, "#f3c9a0", 0.25), mist_falloff="LINEAR")
L.camera((0.0, 33.0, 4.5), (0.0, 0.0, 7.6), lens=35.0)
L.render("04-r-evolution-pose-options.png")
