"""Look-dev 10: the San Francisco house kit -> assets/blender/lookdev/10-house-kit.png

A row of houses laid out with the game's own layout maths (runtime/house-kit.ts, through
tools/house-kit-demo.ts) and the exported prototypes (public/models/house-kit/), recoloured per
house through the _SLOT attribute the way the renderer will: left to right an Italianate with
angled bays, bracketed cornice and a railed stoop; a Queen Anne with hipped bay caps; an
Edwardian with square bays and a parapet coping; a corner house with its turret; a 1925
apartment block with its rooftop kit. On the far left, a public stairway climbing a slope, as
stepped blocks (stairLayout) and, beside it, the same climb as a ramp carrying stair-treads.png.
The house bodies are plain boxes standing in for the pipeline's walls.
"""

import json
import math
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix  # noqa: E402

import fc  # noqa: E402
import lookdev as L  # noqa: E402
import lookdev_assets as A  # noqa: E402

# glTF (x, y up, z back) -> Blender (x, y forward, z up)
C = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def demo() -> dict:
    out = subprocess.run(["node", os.path.join(fc.BLENDER_DIR, "tools", "house-kit-demo.ts")], check=True, capture_output=True, text=True, cwd=fc.REPO)
    return json.loads(out.stdout)


def gltf_matrix(m) -> Matrix:
    # column-major 16 -> mathutils rows
    return Matrix(((m[0], m[4], m[8], m[12]), (m[1], m[5], m[9], m[13]), (m[2], m[6], m[10], m[14]), (m[3], m[7], m[11], m[15])))


PROTOS: dict = {}


def proto_mesh(proto: str, node: str):
    """The imported prototype node's mesh (imported once per file, hidden)."""
    if proto not in PROTOS:
        root, objs = L.import_glb(f"house-kit/{proto}.glb", x=0, y=-500)
        PROTOS[proto] = {o.name.split(".")[0]: o for o in objs.values() if o.type == "MESH"}
        for o in objs.values():
            o.hide_render = True
    return PROTOS[proto][node].data


def recoloured(me, body: str, trim: str, tag: str):
    """A copy of the mesh with slot 0 (body) and slot 1 (trim) recoloured, as the shader does."""
    key = f"{me.name}|{tag}"
    have = bpy.data.meshes.get(key)
    if have is not None:
        return have
    m2 = me.copy()
    m2.name = key
    slot = m2.attributes.get("_SLOT") or m2.attributes.get("_slot")
    col = m2.color_attributes[0] if len(m2.color_attributes) else None
    if slot is not None and col is not None:
        n = len(slot.data)
        s = np.zeros(n, dtype=np.float32)
        slot.data.foreach_get("value", s)
        domain_point = col.domain == "POINT"
        rgba = np.zeros(len(col.data) * 4, dtype=np.float32)
        col.data.foreach_get("color", rgba)
        rgba = rgba.reshape(-1, 4)
        if domain_point:
            per = s
        else:
            loops = np.zeros(len(m2.loops), dtype=np.int64)
            m2.loops.foreach_get("vertex_index", loops)
            per = s[loops]
        for sid, hexcol in ((0, body), (1, trim)):
            rgb = fc.hex_rgb(hexcol)
            rgba[per == sid, :3] = rgb
        col.data.foreach_set("color", rgba.ravel())
    return m2


def place(me, mw: Matrix, name: str):
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.matrix_world = mw
    return ob


def house_body(h: dict) -> None:
    body = L.flat_material(f"body_{h['name']}", h["body"], 0.8)
    dark = L.flat_material(f"win_{h['name']}", "#2f3940", 0.25)
    trim = L.flat_material(f"trim_{h['name']}", h["trim"], 0.6)
    mb = fc.MeshBuilder()
    hx = -h["x"]  # the camera looks back at the fronts: mirror the street so it reads left to right
    x0, x1 = hx - h["frontM"] / 2, hx + h["frontM"] / 2
    mb.box(x0, -h["depthM"], -0.5, x1, 0.0, h["roofM"], body, skip=("-z",))
    # plain sash windows beside the bays, one per storey, and the raised basement's vents
    xs = [hx - 2.3 if h["name"] in ("queen-anne", "corner-turret") else hx + 2.3]
    if h["name"] == "apartments-1925":
        xs = [hx + d for d in (-5.5, -2.8, 2.8, 5.5)]
    for s in range(h["storeys"]):
        z0 = h["floorM"] + s * h["storeyM"] + 0.9
        for wx in xs:
            if s == 0 and abs(wx - hx) < 1.0 and h["name"] != "apartments-1925":
                continue
            mb.box(wx - 0.55, 0.0, z0, wx + 0.55, 0.03, z0 + 1.8, dark)
            mb.box(wx - 0.68, 0.0, z0 - 0.12, wx + 0.68, 0.08, z0, trim)
    mb.build(f"house_{h['name']}")


def ramp(profile, width, x_centre, y0, mat, uv_run=None):
    """A ground ramp along a path profile, climbing back from the sidewalk (toward -Y)."""
    mb = fc.MeshBuilder()
    for (s0, z0), (s1, z1) in zip(profile, profile[1:]):
        pts = [(x_centre + width / 2, y0 - s0, z0), (x_centre - width / 2, y0 - s0, z0), (x_centre - width / 2, y0 - s1, z1), (x_centre + width / 2, y0 - s1, z1)]
        uv = None
        if uv_run is not None:
            uv = [(0.0, s0 / uv_run), (width / 2.0, s0 / uv_run), (width / 2.0, s1 / uv_run), (0.0, s1 / uv_run)]
        mb.poly(pts, mat, uv=uv)
        # the slope's sides down to the ground
        for xx in (x_centre - width / 2, x_centre + width / 2):
            mb.poly_n([(xx, y0 - s0, -0.2), (xx, y0 - s1, -0.2), (xx, y0 - s1, z1), (xx, y0 - s0, z0)], mat, (1 if xx > x_centre else -1, 0, 0))
    return mb


def main() -> None:
    fc.reset()
    A.studio(res=(1800, 640), samples=48, ground="#8d8a85")
    d = demo()
    sidewalk = L.flat_material("sidewalk", "#b9b4ab", 0.9)
    road = L.flat_material("asphalt", "#3d3e40", 0.95)
    L.quad("sidewalk", -35, 0.0, 40, 3.6, 0.005, sidewalk)
    L.quad("road", -35, 3.6, 40, 14.0, 0.0, road)
    for h in d["houses"]:
        house_body(h)
        # the facade frame's +x is the facade's right seen from behind it (the camera's left)
        H = Matrix.Translation((-h["x"], 0.0, 0.0)) @ Matrix.Scale(-1, 4, (1, 0, 0))
        for k, inst in enumerate(h["instances"]):
            me = recoloured(proto_mesh(inst["proto"], inst["node"]), h["body"], h["trim"], h["name"])
            place(me, H @ C @ gltf_matrix(inst["matrix"]) @ C.inverted(), f"{h['name']}_{inst['proto']}_{inst['node']}_{k}")
    # the public stairway: a slope block, the stepped stair on it, and the textured ramp beside it
    st = d["stairs"]
    concrete = L.flat_material("slope_concrete", "#a7a29a", 0.9)
    tex_mat = fc.material("stair_treads_tex", "#ffffff", 0.85, image=os.path.join(fc.MODELS_OUT, "house-kit", "stair-treads.png"))
    y0 = 1.0  # the climb starts at the sidewalk and runs back (path forward = Blender -Y)
    hill = ramp([(s, z - 0.25) for s, z in st["profile"]], 9.0, 31.0, y0, concrete)
    hill.build("stair_slope")
    Pth = Matrix.Translation((33.0, y0, 0.0)) @ Matrix.Rotation(math.pi, 4, "Z")
    for k, inst in enumerate(st["instances"]):
        me = recoloured(proto_mesh("stair-flight", inst["node"]), "#bdb7ad", "#d9d4ca", "stairs")
        place(me, Pth @ C @ gltf_matrix(inst["matrix"]) @ C.inverted(), f"stair_{inst['node']}_{k}")
    tr = ramp(st["profile"], 2.2, 28.6, y0, tex_mat, uv_run=0.3)
    tr.build("stair_texture_ramp")
    L.camera((6.0, 46.0, 26.0), (5.0, -4.0, 8.5), lens=27)
    L.render("10-house-kit.png")


main()
