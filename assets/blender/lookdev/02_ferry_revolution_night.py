"""Look-dev 02: the same view at night, tower outline lit, sculpture glowing, light fog
-> assets/blender/lookdev/02-ferry-revolution-night.png"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

from mathutils import Vector  # noqa: E402

import fc  # noqa: E402
import lookdev as L  # noqa: E402
import plaza  # noqa: E402

fc.reset()
L.setup(samples=int(os.environ.get("LOOKDEV_SAMPLES", "64")), exposure=0.3)
ferry, fobjs, rev, robjs, frame = plaza.build(night=True)
L.set_clock(fobjs, 21 * 60 + 40)
objs = list(fobjs.values()) + list(robjs.values())
L.emission(objs, 30.0, prefix="light_tower_outline")
L.emission(objs, 5.0, prefix="light_clock_face")
L.emission(objs, 7.0, prefix="light_sculpture_glow", color="#c58bff")
L.sun(130, 38, 0.06, "#9db4ff", angle_deg=0.5)  # moonlight
L.world_gradient([(0.0, "#0b0d12"), (0.5, "#28324a"), (0.56, "#1b2438"), (1.0, "#070b16")], strength=0.6)
# warm floodlights washing the facade from the promenade, and a soft uplight on the sculpture
for x in (-80, -50, -20, 20, 50, 80):
    p = frame @ Vector((x, 16.0, 0.6))
    L.point_light((p.x, p.y, p.z), 5000.0, "#ffcf96", kind="SPOT", radius=2.0, spot=(1.6, 1.0),
                  rot=(Vector((0, 0, 9.0)) + (frame @ Vector((x, -2.0, 0)) - p)).to_track_quat("-Z", "Y").to_euler())
for z, x in ((28.0, 0.0),):
    p = frame @ Vector((x, 12.0, 1.0))
    L.point_light((p.x, p.y, p.z), 40000.0, "#ffd9a8", kind="SPOT", radius=1.0, spot=(0.5, 0.8),
                  rot=((frame @ Vector((0, 0, 48.0))) - p).to_track_quat("-Z", "Y").to_euler())
rv = Vector(rev.location)
L.point_light((rv.x, rv.y, 0.9), 900.0, "#b78cff", radius=0.8)
L.compositor(mist=(25.0, 420.0, "#1f2738", 0.55), glare=1.2)
plaza.golden_camera(rev, plaza.landmarks()["r-evolution"]["headingDeg"])
L.render("02-ferry-revolution-night.png")
