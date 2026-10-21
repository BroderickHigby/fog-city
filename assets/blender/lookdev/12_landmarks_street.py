"""Look-dev 12: the street-scale interim landmarks -> assets/blender/lookdev/12-landmarks-street.png

Two panels (900 x 720 each), imported from public/models as the game loads them:
  left   the Dragon Gate across Grant Ave, seen from the south as a driver arrives up Grant,
         with the player's car under the central portal for scale and the building faces it
         spans (boxes standing in for the pipeline's walls)
  right  the Sutro Baths ruins on the sim's own ground at Lands End (the site grid from
         data/landmark-sites.json), the sea at 0 m below the shelf
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import fc  # noqa: E402
import landmark_kit as LK  # noqa: E402
import lookdev as L  # noqa: E402
import lookdev_assets as A  # noqa: E402

TMP = os.path.join(fc.BLENDER_DIR, ".renders", "lookdev-12")


def stage(res, sun_az=230.0, sun_el=24.0):
    fc.reset()
    sc = L.setup(res=res, samples=48)
    sc.cycles.seed = 11
    _, to_sun = L.sun(sun_az, sun_el, 3.4, "#ffe0bd", angle_deg=2.0)
    L.world_gradient([(0.0, "#5d5a58"), (0.5, "#e2d0bc"), (0.54, "#c9d6e2"), (1.0, "#7f9cc0")], strength=0.9, sun_dir=to_sun, sun_color=(1.0, 0.8, 0.6), sun_glow=0.4)
    return sc


def panel(name: str) -> np.ndarray:
    os.makedirs(TMP, exist_ok=True)
    os.environ["FC_LOOKDEV_OUT"] = TMP
    path = L.render(f"{name}.png")
    del os.environ["FC_LOOKDEV_OUT"]
    img = bpy.data.images.load(path)
    px = np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)
    bpy.data.images.remove(img)
    return px


def dragon_gate() -> np.ndarray:
    stage((900, 720), sun_az=200.0, sun_el=35.0)
    s = LK.site("dragon-gate")
    road = L.flat_material("asphalt", "#3f4042", 0.95)
    walk = L.flat_material("sidewalk", "#b7b2a9", 0.9)
    wall_a = L.flat_material("wall_a", "#c9b79a", 0.85)
    wall_b = L.flat_material("wall_b", "#b4a58d", 0.85)
    half = s["extra"]["spanM"] / 2
    cl = s["extra"]["centrelineX"]
    L.quad("street", -80, -80, 80, 80, -0.01, walk)
    # Grant Ave's carriageway (7.8 m) on its centreline, running front to back (Blender Y)
    L.quad("grant", cl - 3.9, -80, cl + 3.9, 80, 0.0, road)
    mb = fc.MeshBuilder()
    for sx, mat in ((-1, wall_a), (1, wall_b)):
        x0 = sx * half
        mb.box(min(x0, x0 + sx * 12), -60, 0, max(x0, x0 + sx * 12), -1.2, 16 if sx < 0 else 12, mat)
        mb.box(min(x0, x0 + sx * 12), 14.0, 0, max(x0, x0 + sx * 12), 60, 20 if sx < 0 else 14, mat)  # across Bush St
    mb.build("buildings")
    L.import_glb("dragon-gate.glb")
    # the player's car crossing Bush St into Grant, heading north through the central portal
    L.import_glb("player-car.glb", x=cl, y=7.0, heading_deg=180.0)
    L.camera((cl - 1.5, 26.0, 2.2), (cl * 0.3, 0.0, 4.8), lens=28)
    return panel("dragon-gate")


def sutro_baths() -> np.ndarray:
    stage((900, 720), sun_az=250.0, sun_el=18.0)
    s = LK.site("sutro-baths")
    g = s["grid"]
    n = len(g["values"])
    land = L.flat_material("bluff", "#8b8270", 0.95)
    sea = L.flat_material("sea", "#2f4b5a", 0.2)
    mb = fc.MeshBuilder()
    pts = [[LK.bl(-g["half"] + ix * g["step"], -g["half"] + iz * g["step"]) for ix in range(n)] for iz in range(n)]
    for iz in range(n - 1):
        for ix in range(n - 1):
            q = [(iz, ix), (iz, ix + 1), (iz + 1, ix + 1), (iz + 1, ix)]
            mb.poly_n([(pts[a][b][0], pts[a][b][1], g["values"][a][b]) for a, b in q], land, (0, 0, 1))
    mb.build("ground")
    # the sea at sea level (0 m in the world = -groundY here)
    L.quad("sea", -400, -400, 400, 400, -s["groundY"] + 0.05, sea)
    L.import_glb("sutro-baths.glb")
    L.camera((70.0, -95.0, 48.0), (-2.0, 2.0, 0.0), lens=32)
    return panel("sutro-baths")


def main() -> None:
    out = np.concatenate([dragon_gate(), sutro_baths()], axis=1)
    h, w = out.shape[:2]
    img = bpy.data.images.new("street_sheet", w, h, alpha=False)
    img.pixels.foreach_set(out.ravel())
    path = os.path.join(L.LOOKDEV_DIR, "12-landmarks-street.png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    L.strip_png_text(path)
    print(f"[lookdev] wrote {os.path.relpath(path, fc.REPO)} ({os.path.getsize(path) // 1024} KiB)")


main()
