"""R-Evolution (after Marco Cochrane's 45 ft sculpture) -> public/models/r-evolution.glb

A woman standing tall on a round plinth, arms held open from her sides, chin lifted. Built from
the CC0 MakeHuman base figure (data/makehuman-female.ply, see tools/make_base_female.py),
re-posed procedurally (arms opened, head lifted, a short bob added), then:

  frame   the figure voxel-remeshed, decimated to ~2k triangles and turned into rods with a
          Wireframe modifier: the triangulated steel-rod frame (steel_rod)
  shell   the outer skin, offset just outside the rods, with an alpha-tested chain-link
          texture (steel_mesh, alphaMode MASK, double sided)
  glow    an inner skin with the same chain-link pattern, emissive for night
          (light_sculpture_glow; by day it reads as a second, darker layer of mesh)
  plinth  the round base

Front faces glTF -Z; origin at the plinth's centre on the ground. Budget: 40k triangles.
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import fc  # noqa: E402

BUDGET = 40_000
FIGURE_H = 13.7  # 45 ft, top of the hair
PLINTH_R = 3.6  # keep in step with tools/landmarks.py
PLINTH_H = 0.6
ARM_DOWN_DEG = 14.0  # rotate the A-pose arms toward the body (A-pose ~42 deg -> ~28 deg)
HEAD_UP_DEG = 9.0
FRAME_TRIS = 2000
SHELL_TRIS = 5200
GLOW_TRIS = 2600
ROD = 0.075  # rod thickness, metres
SHELL_OFFSET = -0.03
GLOW_OFFSET = -0.22
PLY = os.path.join(fc.BLENDER_DIR, "data", "makehuman-female.ply")
TEX_DIR = os.path.join(fc.BLENDER_DIR, ".cache", "textures")


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def rot_about(points, pivot, axis, ang):
    """Rotate each point about the axis through pivot by ang[i] (radians, per point)."""
    axis = axis / np.linalg.norm(axis)
    p = points - pivot
    c, s = np.cos(ang)[:, None], np.sin(ang)[:, None]
    cross = np.cross(axis, p)
    dot = (p @ axis)[:, None]
    return pivot + p * c + cross * s + axis * dot * (1 - c)


JOINTS_JSON = os.path.join(fc.BLENDER_DIR, "data", "makehuman-female-joints.json")


def seg_dist(p, a, b):
    """Distance from each point to the segment a-b."""
    ab = b - a
    t = np.clip(((p - a) @ ab) / (ab @ ab), 0.0, 1.0)
    return np.linalg.norm(p - (a + np.outer(t, ab)), axis=1)


def pose(co: np.ndarray, J: dict) -> np.ndarray:
    """Open the arms to the sculpture's stance and lift the chin.

    A tiny automatic skin: every vertex is weighted to bone groups by its distance to the
    MakeHuman joint segments (soft-min), then the arm and head groups are rotated about the
    shoulder and neck joints with linear blend skinning.
    """
    j = {k: np.array(v) for k, v in J.items()}
    groups = {
        "body": [("pelvis", "spine-4"), ("spine-4", "spine-3"), ("spine-3", "spine-2"), ("spine-2", "spine-1"),
                 ("spine-1", "neck"), ("l-clavicle", "l-shoulder"), ("r-clavicle", "r-shoulder"),
                 ("l-upper-leg", "l-knee"), ("l-knee", "l-ankle"), ("l-ankle", "l-foot-2"),
                 ("r-upper-leg", "r-knee"), ("r-knee", "r-ankle"), ("r-ankle", "r-foot-2"),
                 ("pelvis", "l-upper-leg"), ("pelvis", "r-upper-leg")],
        "head": [("neck", "head"), ("head", "head-2")],
    }
    for s_ in ("l", "r"):
        sh, el, ha = j[f"{s_}-shoulder"], j[f"{s_}-elbow"], j[f"{s_}-hand"]
        tip = ha + (ha - el) / np.linalg.norm(ha - el) * 0.19
        j[f"{s_}-tip"] = tip
        groups[f"arm_{s_}"] = [(f"{s_}-shoulder", f"{s_}-elbow"), (f"{s_}-elbow", f"{s_}-hand"), (f"{s_}-hand", f"{s_}-tip")]
    names = list(groups)
    D = np.stack([np.min([seg_dist(co, j[a], j[b]) for a, b in groups[g]], axis=0) for g in names], axis=1)
    tau = 0.012
    W = np.exp(-(D - D.min(axis=1, keepdims=True)) / tau)
    W /= W.sum(axis=1, keepdims=True)
    out = co.copy()
    for s_, side in (("l", -1), ("r", 1)):
        w = W[:, names.index(f"arm_{s_}")]
        ang = np.full(len(co), np.radians(ARM_DOWN_DEG) * side)
        rotated = rot_about(co, j[f"{s_}-shoulder"], np.array([0.0, 1.0, 0.0]), ang)
        out += (rotated - co) * w[:, None]
    wh = W[:, names.index("head")]
    rotated = rot_about(co, j["neck"], np.array([1.0, 0.0, 0.0]), np.full(len(co), np.radians(HEAD_UP_DEG)))
    out += (rotated - co) * wh[:, None]
    return out


def hair_cap(co: np.ndarray, J: dict):
    """A short bob: an ellipsoid over the crown and back of the head, open at the face."""
    head = co[co[:, 2] > 1.62]
    c = np.array([0.0, head[:, 1].mean() - 0.012, head[:, 2].max() - 0.092])
    r = np.array([0.1, 0.112, 0.102])
    verts, faces = [], []
    rings, seg = 10, 20
    for i in range(rings + 1):
        th = math.pi * i / rings
        for j in range(seg):
            ph = 2 * math.pi * j / seg
            verts.append(c + r * np.array([math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th)]))
    for i in range(rings):
        for j in range(seg):
            a, b = i * seg + j, i * seg + (j + 1) % seg
            faces.append([a, b, b + seg, a + seg])
    verts = np.array(verts)
    # drop the faces in front of the face and below the jaw (pose() tilts it with the head)
    keep = []
    for f in faces:
        cen = verts[f].mean(axis=0) - c
        front = cen[1] > 0.035 and cen[2] < 0.045
        low = cen[2] < -0.075
        if not (front or low):
            keep.append(f)
    return verts, keep


def chainlink_png(path: str, size=256, cells=8, wire=0.26) -> str:
    """Diamond chain-link pattern: white wires, transparent holes (alpha)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    y, x = np.mgrid[0:size, 0:size] / size * cells
    a = np.abs(((x + y) % 1.0) - 0.5)
    b = np.abs(((x - y) % 1.0) - 0.5)
    d = np.minimum(0.5 - a, 0.5 - b)  # distance to the nearest wire, in cells
    alpha = 1.0 - smoothstep(wire * 0.5, wire * 0.5 + 0.06, d)
    shade = 0.75 + 0.25 * (1 - smoothstep(0, wire * 0.5, d))
    img = bpy.data.images.new("chainlink", size, size, alpha=True)
    rgba = np.stack([shade, shade, shade, alpha], axis=-1).astype(np.float32)
    img.pixels.foreach_set(rgba[::-1].ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    return path


def apply_mods(ob):
    bpy.context.view_layer.objects.active = ob
    for o in bpy.context.selected_objects:
        o.select_set(False)
    ob.select_set(True)
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def decimate_to(ob, tris):
    me = ob.data
    me.calc_loop_triangles()
    cur = len(me.loop_triangles)
    m = ob.modifiers.new("dec", "DECIMATE")
    m.decimate_type = "COLLAPSE"
    m.ratio = min(1.0, tris / cur)
    m.use_collapse_triangulate = True
    apply_mods(ob)


def offset(ob, dist):
    m = ob.modifiers.new("off", "DISPLACE")
    m.direction = "NORMAL"
    m.mid_level = 0.0
    m.strength = dist
    apply_mods(ob)


def triplanar_uv(ob, scale, rot=0.0):
    """Project UVs per face from the dominant normal axis (the pattern hides the seams)."""
    me = ob.data
    uv = me.uv_layers.new(name="UVMap")
    c, s = math.cos(rot), math.sin(rot)
    for p in me.polygons:
        n = p.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for li in p.loop_indices:
            v = me.vertices[me.loops[li].vertex_index].co
            if ax == 0:
                u, w = v.y, v.z
            elif ax == 1:
                u, w = v.x, v.z
            else:
                u, w = v.x, v.y
            uv.data[li].uv = ((u * c - w * s) / scale, (u * s + w * c) / scale)


def main() -> None:
    fc.reset()
    tex = chainlink_png(os.path.join(TEX_DIR, "chainlink.png"))
    rod = fc.material("steel_rod", "#55595c", 0.42, 0.88)
    mesh = fc.material("steel_mesh", "#b4b8bb", 0.45, 0.8, image=tex, alpha_clip=0.3, double_sided=True)
    glow = fc.material("light_sculpture_glow", "#4a4d55", 0.5, 0.3, emission="#c9b4ff", strength=1.0,
                       image=tex, alpha_clip=0.3, double_sided=True)
    stone = fc.material("plinth_stone", "#d4d2cc", 0.7)
    band = fc.material("plinth_band", "#3b3d40", 0.5, 0.2)

    # ---- base figure, posed, with hair; scaled to the sculpture's height on the plinth
    bpy.ops.wm.ply_import(filepath=PLY)
    base = bpy.context.selected_objects[0]
    co = np.array([v.co[:] for v in base.data.vertices])
    with open(JOINTS_JSON, encoding="utf-8") as f:
        joints = json.load(f)["joints"]
    hv, hf = hair_cap(co, joints)
    faces = [list(p.vertices) for p in base.data.polygons]
    bpy.data.objects.remove(base)
    allv = pose(np.vstack([co, hv]), joints)
    allf = faces + [[i + len(co) for i in f] for f in hf]
    top = allv[:, 2].max()
    k = FIGURE_H / top
    allv = allv * k
    pel = np.array(joints["pelvis"]) * k
    allv[:, 0] -= pel[0]
    allv[:, 1] -= pel[1]
    allv[:, 2] += PLINTH_H
    me = bpy.data.meshes.new("figure_src")
    me.from_pydata(allv.tolist(), [], allf)
    me.update()
    src = bpy.data.objects.new("figure_src", me)
    bpy.context.scene.collection.objects.link(src)
    rm = src.modifiers.new("remesh", "REMESH")
    rm.mode = "VOXEL"
    rm.voxel_size = 0.055
    sm = src.modifiers.new("smooth", "SMOOTH")
    sm.factor = 0.6
    sm.iterations = 4
    apply_mods(src)

    def copy(name):
        o = src.copy()
        o.data = src.data.copy()
        o.name = name
        o.data.name = name
        bpy.context.scene.collection.objects.link(o)
        return o

    root = fc.empty("r_evolution")
    root["fcLandmark"] = "r-evolution"

    frame = copy("frame")
    decimate_to(frame, FRAME_TRIS)
    wf = frame.modifiers.new("rods", "WIREFRAME")
    wf.thickness = ROD
    wf.offset = 0.0
    wf.use_even_offset = False  # "even" thickness spikes on the thin triangles of the fingers
    wf.use_relative_offset = False
    wf.use_replace = True
    wf.use_boundary = True
    apply_mods(frame)
    frame.data.materials.clear()
    frame.data.materials.append(rod)
    for p in frame.data.polygons:
        p.use_smooth = False
    frame.parent = root

    shell = copy("shell")
    decimate_to(shell, SHELL_TRIS)
    offset(shell, SHELL_OFFSET)
    shell.data.materials.clear()
    shell.data.materials.append(mesh)
    for p in shell.data.polygons:
        p.use_smooth = True
    triplanar_uv(shell, 0.6, 0.0)
    shell.parent = root

    gl = copy("glow")
    decimate_to(gl, GLOW_TRIS)
    offset(gl, GLOW_OFFSET)
    gl.data.materials.clear()
    gl.data.materials.append(glow)
    for p in gl.data.polygons:
        p.use_smooth = True
    triplanar_uv(gl, 0.5, math.radians(30))
    gl.parent = root
    gl["nightLight"] = True

    bpy.data.objects.remove(src)

    # ---- plinth: a low drum with a dark inscription band and a stepped top
    mb = fc.MeshBuilder()
    R = PLINTH_R
    mb.lathe([(R, 0.0), (R, 0.18)], 48, stone, smooth=True)
    mb.lathe([(R + 0.01, 0.18), (R + 0.01, 0.42)], 48, band, smooth=True)
    mb.lathe([(R, 0.42), (R, PLINTH_H - 0.08), (R - 0.08, PLINTH_H), (0.0, PLINTH_H)], 48, stone, smooth=False)
    mb.build("plinth", parent=root)

    for o in (frame, shell, gl):
        print(f"[fc]   {o.name}: {fc.tri_count([o])} tris")
    fc.export_glb("r-evolution.glb", BUDGET)


main()
