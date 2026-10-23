"""Look-dev 11: the interim landmarks for the owner's sign-off -> assets/blender/lookdev/11-landmarks.png

Three panels side by side (900, 450 and 450 x 720), golden hour, every model imported from
public/models exactly as the game loads it:
  left    the tall ones at true scale: Sutro Tower (298 m), the pyramid tower at 600 Montgomery
          (260 m), City Hall (93 m), Grace Cathedral (70 m), Coit Tower (64 m) and the Palace of
          Fine Arts rotunda (49 m), with a 10-storey block (32 m) for scale
  middle  the Golden Gate Bridge from the Marin side, low over the water
  right   the Bay Bridge's west span from Rincon Hill toward Yerba Buena Island
The Dragon Gate and the Sutro Baths ruins are in look-dev 12 (street scale).
"""

import math
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import fc  # noqa: E402
import lookdev as L  # noqa: E402
import lookdev_assets as A  # noqa: E402

TMP = tempfile.mkdtemp(prefix="fc-lookdev-")  # panels before stitching; outside the repository, removed after


def stage(ground_hex: str, res, water: bool = False, sun_az: float = 245.0, sun_el: float = 14.0):
    fc.reset()
    sc = L.setup(res=res, samples=48)
    sc.cycles.seed = 11
    _, to_sun = L.sun(sun_az, sun_el, 3.4, "#ffd9ad", angle_deg=2.0)
    L.world_gradient([(0.0, "#5d5a58"), (0.5, "#e6cdb0"), (0.54, "#c9d6e2"), (1.0, "#7f9cc0")], strength=0.9, sun_dir=to_sun, sun_color=(1.0, 0.78, 0.55), sun_glow=0.6)
    g = L.flat_material("ground", "#2f4b5a" if water else ground_hex, 0.25 if water else 0.9)
    L.quad("ground", -6000, -6000, 6000, 6000, 0.0, g)
    return sc


def panel(name: str) -> np.ndarray:
    os.makedirs(TMP, exist_ok=True)
    keep = os.environ.get("FC_LOOKDEV_OUT")
    os.environ["FC_LOOKDEV_OUT"] = TMP
    path = L.render(f"{name}.png")
    if keep is None:
        del os.environ["FC_LOOKDEV_OUT"]
    else:
        os.environ["FC_LOOKDEV_OUT"] = keep
    img = bpy.data.images.load(path)
    px = np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)
    bpy.data.images.remove(img)
    return px


def towers() -> np.ndarray:
    stage("#a49e94", (900, 720))
    row = [
        ("sutro-tower.glb", -330.0, 0.0),
        ("600-montgomery.glb", -150.0, 0.0),
        ("city-hall.glb", 0.0, 30.0),
        ("grace-cathedral.glb", 135.0, 0.0),
        ("coit-tower.glb", 220.0, 0.0),
        ("palace-of-fine-arts.glb", 300.0, 0.0),
    ]
    for f, x, h in row:
        _, objs = L.import_glb(f, x=x, y=0.0, heading_deg=h)
        A.lights_on(objs.values(), 0.0)
    block = L.flat_material("scale_block", "#8f8a82", 0.8)
    mb = fc.MeshBuilder()
    mb.box(370, -15, 0, 400, 15, 32, block)
    mb.build("scale_block_32m")
    L.camera((35.0, -800.0, 110.0), (35.0, 0.0, 135.0), lens=35, clip_end=8000.0)
    return panel("towers")


def golden_gate() -> np.ndarray:
    stage("#6d6a5e", (450, 720), water=True, sun_az=250.0, sun_el=10.0)
    _, objs = L.import_glb("golden-gate-bridge.glb")
    A.lights_on(objs.values(), 0.0)
    # Marin side, looking back south along the bridge, low over the water
    L.camera((420.0, 1950.0, 40.0), (-20.0, 300.0, 120.0), lens=30, clip_end=8000.0)
    return panel("golden-gate")


def bay_bridge() -> np.ndarray:
    stage("#6d6a5e", (450, 720), water=True, sun_az=250.0, sun_el=10.0)
    _, objs = L.import_glb("bay-bridge-west.glb")
    A.lights_on(objs.values(), 0.0)
    L.camera((-380.0, -2450.0, 70.0), (0.0, -600.0, 90.0), lens=32, clip_end=8000.0)
    return panel("bay-bridge")


def main() -> None:
    parts = [towers(), golden_gate(), bay_bridge()]
    out = np.concatenate(parts, axis=1)
    h, w = out.shape[:2]
    img = bpy.data.images.new("landmarks_sheet", w, h, alpha=False)
    img.pixels.foreach_set(out.ravel())
    out_dir = os.environ.get("FC_LOOKDEV_OUT", L.LOOKDEV_DIR)
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "11-landmarks.png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    L.strip_png_text(path)
    shutil.rmtree(TMP, ignore_errors=True)
    print(f"[lookdev] wrote {os.path.relpath(path, fc.REPO)} ({os.path.getsize(path) // 1024} KiB)")


main()
