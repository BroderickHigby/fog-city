"""Look-dev 01: the Ferry Building tower and R-Evolution from Embarcadero Plaza at golden
hour, light SF fog -> assets/blender/lookdev/01-ferry-revolution-golden-hour.png"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import fc  # noqa: E402
import lookdev as L  # noqa: E402
import plaza  # noqa: E402

fc.reset()
L.setup(samples=int(os.environ.get("LOOKDEV_SAMPLES", "64")))
ferry, fobjs, rev, robjs, frame = plaza.build(night=False)
L.set_clock(fobjs, 18 * 60 + 12)
L.emission(list(fobjs.values()) + list(robjs.values()), 0.0)  # night lights off by day
_, to_sun = L.sun(250, 7.0, 9.0, "#ffa257", angle_deg=1.5)
L.world_gradient([(0.0, "#4a4038"), (0.5, "#ffb36e"), (0.535, "#f8bb8c"), (0.6, "#e9b1a6"), (0.7, "#b4b3d0"), (0.85, "#8ea6d6"), (1.0, "#6488c8")],
                 strength=0.65, sun_dir=to_sun, sun_color=(1.0, 0.7, 0.4), sun_glow=3.0)
L.compositor(mist=(20.0, 380.0, "#f3c9a0", 0.32), mist_falloff="LINEAR")
plaza.golden_camera(rev, plaza.landmarks()["r-evolution"]["headingDeg"])
L.render("01-ferry-revolution-golden-hour.png")
