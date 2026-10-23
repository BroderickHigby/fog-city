"""Quick Cycles previews of an exported GLB, for checking a model by eye (not committed).

  "$BLENDER" -b --factory-startup -noaudio -P assets/blender/tools/preview.py -- \
      public/models/robotaxi.glb [views=front3q,back3q,side,top] [res=640] [samples=16]

Writes assets/blender/.renders/<model>-<view>.png. The model is re-imported from the GLB,
so this also proves the file round-trips. Views are named in the model's own frame:
front3q looks at the front-right corner (the front faces glTF -Z = Blender +Y).
"""

import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))
import fc  # noqa: E402

VIEWS = {
    # name: (azimuth deg from +Y toward +X, elevation deg, distance factor)
    "front": (0, 8, 1.0),
    "front3q": (40, 18, 1.0),
    "back3q": (180 + 40, 18, 1.0),
    "side": (90, 5, 1.0),
    "left": (-90, 5, 1.0),
    "back": (180, 8, 1.0),
    "top": (0, 89, 1.0),
    "low3q": (30, 4, 0.9),
}


def main() -> None:
    args = fc.script_args()
    glb = os.path.abspath(args[0])
    opts = dict(a.split("=", 1) for a in args[1:])
    views = opts.get("views", "front3q,back3q,side").split(",")
    res = int(opts.get("res", "640"))
    samples = int(opts.get("samples", "16"))
    focus = opts.get("focus")  # optional node name to frame instead of the whole model

    fc.reset()
    bpy.ops.import_scene.gltf(filepath=glb)
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    glo, _ = fc.world_bounds(objs)

    def under(o, root):
        while o is not None:
            if o == root:
                return True
            o = o.parent
        return False

    if focus:
        root = bpy.data.objects[focus]
        objs = [o for o in objs if under(o, root)]
    lo, hi = fc.world_bounds(objs)
    c = (lo + hi) / 2
    radius = (hi - lo).length / 2

    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.render.resolution_x = res
    sc.render.resolution_y = res * 9 // 16
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.exposure = float(opts.get("exposure", "-1.2"))

    world = bpy.data.worlds.new("w")
    sc.world = world
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes["Background"]
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "NISHITA"
    sky.sun_elevation = math.radians(35)
    sky.sun_rotation = math.radians(200)
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 0.35
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 3.5
    sun.data.angle = math.radians(2)
    sun.rotation_euler = (math.radians(50), 0, math.radians(200))
    sc.collection.objects.link(sun)

    ground = bpy.data.meshes.new("ground")
    s = radius * 8
    s = max(s, 200.0)
    ground.from_pydata([(-s, -s, glo.z), (s, -s, glo.z), (s, s, glo.z), (-s, s, glo.z)], [], [(0, 1, 2, 3)])
    g = bpy.data.objects.new("ground", ground)
    gm = bpy.data.materials.new("groundmat")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.12, 0.12, 0.125, 1)
    ground.materials.append(gm)
    sc.collection.objects.link(g)

    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.lens = 50
    cam.data.clip_end = radius * 50
    sc.collection.objects.link(cam)
    sc.camera = cam
    fov = cam.data.angle_y if res * 9 // 16 < res else cam.data.angle
    out_dir = os.path.join(fc.BLENDER_DIR, ".renders")
    os.makedirs(out_dir, exist_ok=True)
    stem = os.path.splitext(os.path.basename(glb))[0] + (f"-{focus}" if focus else "")
    if "cam" in opts:
        # explicit shot: cam=x,y,z look=x,y,z (Blender coordinates), lens=mm
        views = ["shot"]
        cam.data.lens = float(opts.get("lens", "35"))
    for v in views:
        if v == "shot":
            p = Vector([float(t) for t in opts["cam"].split(",")])
            q = Vector([float(t) for t in opts["look"].split(",")])
            cam.location = p
            cam.rotation_euler = (q - p).to_track_quat("-Z", "Y").to_euler()
            sc.render.filepath = os.path.join(out_dir, f"{stem}-{opts.get('name', 'shot')}.png")
            bpy.ops.render.render(write_still=True)
            print("[preview]", sc.render.filepath)
            continue
        az, el, k = VIEWS[v]
        d = radius / math.sin(fov / 2) * 1.05 * k
        a, e = math.radians(az), math.radians(el)
        direction = Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)))
        cam.location = c + direction * d
        cam.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(out_dir, f"{stem}-{v}.png")
        bpy.ops.render.render(write_still=True)
        print("[preview]", sc.render.filepath)


main()
