"""Rust heaps -> public/models/heap-porter.glb, heap-trundle.glb, heap-mixed.glb

What a melted robot leaves (design.md: "a rusty pile and a puddle"): the robot's own melt
shape key (seize -> slump -> melt), frozen, rusted over and simplified, on a puddle of spray
water. Built from the exported robot GLBs, so the swap from the melt key to the heap prop is
seamless. Cartoon, not gore: a rusty soft-serve mound, the lantern head or a roll-top lid on
top, a wheel or the groceries poking out; nothing broken off, no fluids but water.

  heap (root, origin on the ground at the mound's centre; extras heap: porter|trundle|mixed)
    pile    the rusted mound (materials rust_*, and the parts that keep their own colour:
            groceries, paper, foil, tyres)
    puddle  a flat irregular puddle just above the ground (puddle_water): fade it or shrink it
            as it dries; Tidy hauls the heap

Heaps are significant only until Tidy comes, so they are few: each is decimated to fit
2.5k triangles.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import fc  # noqa: E402

BUDGET = 2_500
KEEP = ("produce_", "bag_paper", "cargo_", "tire")


def import_melted(file, offset=(0.0, 0.0), turn=0.0, scale=1.0):
    """Import a robot GLB, apply its melt key, return the joined mesh object (Blender frame)."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(fc.MODELS_OUT, file))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    for o in meshes:
        keys = o.data.shape_keys
        if keys:
            for kb in keys.key_blocks[1:]:
                kb.value = 1.0 if kb.name == "melt" else 0.0
    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    out = []
    for o in meshes:
        ev = o.evaluated_get(dg)
        me = bpy.data.meshes.new_from_object(ev, preserve_all_data_layers=False, depsgraph=dg)
        ob = bpy.data.objects.new(o.name + "_baked", me)
        bpy.context.scene.collection.objects.link(ob)
        ob.matrix_world = o.matrix_world.copy()
        out.append(ob)
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.object.select_all(action="DESELECT")
    for ob in out:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = out[0]
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    m = (Matrix_T(offset[0], offset[1]) @ Matrix_R(turn) @ Matrix_S(scale))
    ob.data.transform(m)
    ob.data.update()
    return ob


def Matrix_T(x, y):
    from mathutils import Matrix

    return Matrix.Translation((x, y, 0.0))


def Matrix_R(a):
    from mathutils import Matrix

    return Matrix.Rotation(a, 4, "Z")


def Matrix_S(s):
    from mathutils import Matrix

    return Matrix.Diagonal((s, s, s, 1.0))


def rust_materials():
    return {
        "dark": fc.material("rust_dark", "#5a2e19", 0.85, 0.3),
        "orange": fc.material("rust_orange", "#a4501f", 0.8, 0.35),
        "stain": fc.material("rust_stained_ceramic", "#c9a184", 0.6, 0.1),
        "lamp": fc.material("lamp_off", "#3a3631", 0.5),
    }


def rust_over(ob, R):
    """Swap the robot's materials for rust, by each face's rust mask (low = rusted through)."""
    me = ob.data
    mask = None
    if "_RUST_MASK" in me.attributes:
        mask = np.zeros(len(me.vertices), dtype=np.float32)
        me.attributes["_RUST_MASK"].data.foreach_get("value", mask)
    old = [m.name if m else "" for m in me.materials]
    keep = {}
    new_mats = []

    def slot(mat):
        if mat not in new_mats:
            new_mats.append(mat)
        return new_mats.index(mat)

    face_mat = []
    for poly in me.polygons:
        name = old[poly.material_index]
        if name.startswith(KEEP):
            if name not in keep:
                keep[name] = bpy.data.materials.get(name)
            face_mat.append(slot(keep[name]))
            continue
        if name.startswith("light_"):
            face_mat.append(slot(R["lamp"]))
            continue
        v = float(np.mean([mask[i] for i in poly.vertices])) if mask is not None else 0.5
        h = (math.sin(poly.center.x * 31.7 + poly.center.y * 13.1 + poly.center.z * 23.3) * 43758.55) % 1.0
        v += 0.25 * (h - 0.5)
        face_mat.append(slot(R["dark"] if v < 0.3 else R["orange"] if v < 0.72 else R["stain"]))
    me.materials.clear()
    for m in new_mats:
        me.materials.append(m)
    me.polygons.foreach_set("material_index", face_mat)
    if "_RUST_MASK" in me.attributes:
        me.attributes.remove(me.attributes["_RUST_MASK"])
    me.update()


def decimate(ob, budget):
    me = ob.data
    me.calc_loop_triangles()
    tris = len(me.loop_triangles)
    if tris <= budget:
        return
    mod = ob.modifiers.new("dec", "DECIMATE")
    mod.ratio = budget / tris * 0.97
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier=mod.name)


def puddle(root, radius, seed, mat):
    mb = fc.MeshBuilder()
    n = 28
    pts = []
    for k in range(n):
        a = 2 * math.pi * k / n
        r = radius * (1.0 + 0.16 * math.sin(3 * a + seed) + 0.09 * math.sin(7 * a + 2 * seed) + 0.05 * math.sin(11 * a))
        pts.append((r * math.cos(a), r * 0.82 * math.sin(a), 0.004))
    mb.concentric(pts, 2, mat, (0, 0, 1), smooth=True)
    mb.build("puddle", parent=root)


def build(name, parts, radius, seed):
    fc.reset()
    R = rust_materials()
    water = fc.material("puddle_water", "#2e3a44", 0.05, 0.0)
    objs = [import_melted(*p) for p in parts]
    bpy.ops.object.select_all(action="DESELECT")
    for ob in objs:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    pile = bpy.context.view_layer.objects.active
    pile.name = "pile"
    pile.data.name = "pile"
    rust_over(pile, R)
    decimate(pile, BUDGET - 120)
    for poly in pile.data.polygons:
        poly.use_smooth = True
    # sit the mound on the ground, centred
    co = np.zeros(len(pile.data.vertices) * 3)
    pile.data.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    c = (co[:, :2].min(axis=0) + co[:, :2].max(axis=0)) / 2
    co[:, 0] -= c[0]
    co[:, 1] -= c[1]
    co[:, 2] -= co[:, 2].min()
    pile.data.vertices.foreach_set("co", co.reshape(-1))
    pile.data.update()
    root = fc.empty("heap")
    root["fcActor"] = f"heap-{name}"
    root["heap"] = name
    pile.parent = root
    pile.matrix_parent_inverse.identity()
    puddle(root, radius, seed, water)
    fc.export_glb(f"heap-{name}.glb", BUDGET)


build("porter", [("errand-robot.glb",)], 0.85, 0.4)
build("trundle", [("sidewalk-bot.glb",)], 0.7, 1.7)
build("mixed", [("errand-robot.glb", (-0.18, 0.05), 0.6, 0.85), ("sidewalk-bot.glb", (0.3, -0.12), -0.9, 0.9)], 0.95, 2.9)
