"""Humanoid impostor atlas -> public/models/humanoid-impostor.png (+ the "impostor" entry in
public/models/humanoid-vat.json). For people beyond the low-LOD range (design.md: impostors
beyond 300 m).

8 columns (view angles, 45 degrees apart) x 2 rows (idle, mid-stride walk) of 64 x 128 px
cells, rendered orthographically from the base adult body. Each texel stores what the crowd
shader needs to tint it like the 3D crowd:
  R  slot index * 16 + 8   (decode: floor(R * 255 / 16); the palette row gives the colour)
  G  diffuse shading, sRGB 0..255 (multiply the slot colour by it)
  B  0
  A  coverage, 0 or 255 (alpha test at 0.5)
Column choice: with d the direction from the person to the camera in the person's own glTF
frame (x right, z back), phi = atan2(d.x, -d.z) (0 = camera in front, 90 = on their right);
column = round(phi / 45) mod 8. The quad is cellSizeM wide/tall, its bottom edge on the ground.
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import fc  # noqa: E402
import humanoid as H  # noqa: E402
import humanoid_clips as C  # noqa: E402

COLS, ROWS = 8, 2
CELL = (64, 128)
CELL_M = (1.0, 2.0)
OUT = os.path.join(fc.MODELS_OUT, "humanoid-impostor.png")


def build_scene(F, geo):
    rows = [("idle", 0.0), ("walk", 0.25)]
    for r, (clip, t) in enumerate(rows):
        pose = C.sample_clip(F, geo, clip, [t])[0]
        P, _ = H.skin(geo["P"], geo["idx"], geo["wts"], H.bone_globals(F, pose))
        for c in range(COLS):
            me = bpy.data.meshes.new(f"m{r}{c}")
            me.from_pydata([tuple(p) for p in P], [], [tuple(int(i) for i in tri) for tri in geo["T"]])
            me.polygons.foreach_set("use_smooth", [True] * len(geo["T"]))
            ob = bpy.data.objects.new(f"p{r}{c}", me)
            bpy.context.scene.collection.objects.link(ob)
            # column c shows the body seen from phi = c * 45 degrees (see the docstring)
            phi = math.radians(45.0 * c)
            ob.rotation_euler = (0.0, 0.0, phi - math.pi)
            ob.location = ((c - (COLS - 1) / 2) * CELL_M[0], 0.0, -r * CELL_M[1] * 1.0 + (ROWS - 1) * CELL_M[1] / 2 - CELL_M[1] / 2 + 0.0)
            # slot per face, for the ID pass (as a face attribute)
            attr = me.attributes.new("slot", "FLOAT", "FACE")
            attr.data.foreach_set("value", [float(geo["S"][tri[0]]) for tri in geo["T"]])
    return rows


def id_material():
    m = bpy.data.materials.new("id")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    at = nt.nodes.new("ShaderNodeAttribute")
    at.attribute_type = "GEOMETRY"
    at.attribute_name = "slot"
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY_ADD"
    mul.inputs[1].default_value = 1.0 / 16.0
    mul.inputs[2].default_value = 0.5 / 16.0
    nt.links.new(at.outputs["Fac"], mul.inputs[0])
    nt.links.new(mul.outputs[0], em.inputs["Color"])
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    return m


def shade_material():
    m = bpy.data.materials.new("shade")
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.8, 0.8, 0.8, 1.0)
    b.inputs["Roughness"].default_value = 0.8
    return m


def render(path, samples, filter_px):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_adaptive_sampling = False
    sc.cycles.use_denoising = samples > 1
    sc.cycles.seed = 7
    sc.cycles.filter_width = filter_px
    sc.render.film_transparent = True
    sc.render.threads_mode = "FIXED"
    sc.render.threads = 2
    sc.view_settings.view_transform = "Standard"
    sc.render.image_settings.file_format = "OPEN_EXR"
    sc.render.image_settings.color_depth = "32"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    px = np.array(img.pixels[:], dtype=np.float32).reshape(img.size[1], img.size[0], 4)
    bpy.data.images.remove(img)
    os.remove(path)
    return px[::-1]  # top row first


def main() -> None:
    fc.reset()
    F = H.adult_frame()
    geo = H.key_geometry(F, 0)
    rows = build_scene(F, geo)
    sc = bpy.context.scene
    sc.render.resolution_x = COLS * CELL[0]
    sc.render.resolution_y = ROWS * CELL[1]
    sc.render.resolution_percentage = 100
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = COLS * CELL_M[0]
    cam.location = (0.0, -20.0, 0.0)
    cam.rotation_euler = (math.pi / 2, 0.0, 0.0)
    sc.collection.objects.link(cam)
    sc.camera = cam
    # frame: row r spans z from -r*2 to -(r-1)*2 ... centre the two rows on the camera
    for ob in sc.objects:
        if ob.type == "MESH":
            r = int(ob.name[1])
            ob.location.z = (ROWS / 2 - 1 - r) * CELL_M[1]

    tmp = os.path.join(fc.BLENDER_DIR, ".cache")
    os.makedirs(tmp, exist_ok=True)
    idm = id_material()
    for ob in sc.objects:
        if ob.type == "MESH":
            ob.data.materials.clear()
            ob.data.materials.append(idm)
    w = bpy.data.worlds.new("w")
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.0
    ids = render(os.path.join(tmp, "impostor_id.exr"), 1, 0.01)

    sm = shade_material()
    for ob in sc.objects:
        if ob.type == "MESH":
            ob.data.materials.clear()
            ob.data.materials.append(sm)
    w.node_tree.nodes["Background"].inputs["Color"].default_value = (0.75, 0.8, 0.9, 1.0)
    w.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.6
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 2.5
    sun.rotation_euler = (math.radians(40), 0.0, math.radians(25))
    sc.collection.objects.link(sun)
    shade = render(os.path.join(tmp, "impostor_shade.exr"), 16, 0.01)

    alpha = ids[..., 3] > 0.5
    slot = np.clip(np.floor(ids[..., 0] * 16.0), 0, 15).astype(np.uint8)
    lum = shade[..., 0] * 0.2126 + shade[..., 1] * 0.7152 + shade[..., 2] * 0.0722
    lum = lum / max(float(lum[alpha].max()), 1e-6)
    srgb = np.where(lum <= 0.0031308, 12.92 * lum, 1.055 * np.power(np.clip(lum, 0, 1), 1 / 2.4) - 0.055)
    out = np.zeros(ids.shape[:2] + (4,), dtype=np.uint8)
    out[..., 0] = np.where(alpha, slot * 16 + 8, 0)
    out[..., 1] = np.where(alpha, np.clip(np.round(srgb * 255), 0, 255), 0)
    out[..., 3] = np.where(alpha, 255, 0)
    img = bpy.data.images.new("impostor", out.shape[1], out.shape[0], alpha=True)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set((out[::-1].astype(np.float32) / 255.0).reshape(-1))
    img.filepath_raw = OUT
    img.file_format = "PNG"
    img.save()
    import lookdev

    lookdev.strip_png_text(OUT)

    meta_path = os.path.join(fc.MODELS_OUT, "humanoid-vat.json")
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)
    meta["impostor"] = dict(
        file="humanoid-impostor.png", width=int(out.shape[1]), height=int(out.shape[0]), columns=COLS,
        rows=[r[0] for r in rows], cell=list(CELL), cellSizeM=list(CELL_M),
        channels="R: slot*16+8, G: diffuse shading (sRGB), B: 0, A: coverage (alpha test 0.5)",
        column="phi = atan2(d.x, -d.z) for d the person-to-camera direction in the person's glTF frame; column = round(phi / 45 deg) mod 8",
    )
    fc.write_json(meta_path, meta)
    print(f"[fc] wrote {os.path.relpath(OUT, fc.REPO)}: {out.shape[1]}x{out.shape[0]}, {int(alpha.sum())} covered texels, {os.path.getsize(OUT) // 1024} KiB")


main()
