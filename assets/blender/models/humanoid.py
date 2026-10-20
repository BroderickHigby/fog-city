"""The humanoid line -> public/models/humanoid-crowd.glb, humanoid-vat-*.bin, humanoid-vat.json,
player.glb, and tests/assets/fixtures/humanoid-vat-reference.json.

One parametric body (lib/humanoid.py), one 20-bone rig, one clip library
(lib/humanoid_clips.py), two uses:

  - Crowds: every clip is baked to vertex-animation textures (VAT) for instancing. Positions
    (RGBA16F) and each vertex's blended bone rotation (RGBA8 quaternion) per frame, plus the
    body variants' shape-key deltas (RGBA16F). The crowd meshes are written in bake order by
    lib/glbwrite.py. The adult body has two LODs; the child is a separate model flagged child.
  - The player: a skinned glTF with the same body, all twelve shape keys as morph targets,
    tint materials per slot and every clip (plus run and aim) as a glTF animation.

The texture layout, clip table and shader contract are in assets/blender/README.md
("Humanoid line"); assets/blender/runtime/humanoid-vat.ts decodes them.
"""

from __future__ import annotations

import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix, Quaternion  # noqa: E402

import fc  # noqa: E402
import glbwrite as GW  # noqa: E402
import humanoid as H  # noqa: E402
import humanoid_clips as C  # noqa: E402

BUDGET_LOD0 = 4_000
BUDGET_LOD1 = 1_000
MAX_W = 2048
PLAYER_FPS = 30
FIXTURE = os.path.join(fc.REPO, "tests", "assets", "fixtures", "humanoid-vat-reference.json")

# --------------------------------------------------------------------- looks and palettes

VARIANTS = [
    dict(id="founder", label="Founder: slim, fleece vest, conference lanyard", model="adult",
         weights=dict(build_slim=0.5, vest=1.0, lanyard=1.0), heightScale=[0.97, 1.04], outfits=["vest_charcoal", "vest_navy"]),
    dict(id="engineer", label="Engineer: hoodie, bun", model="adult",
         weights=dict(hoodie=1.0, hair_bun=1.0, build_broad=0.2), heightScale=[0.98, 1.05], outfits=["hoodie_heather", "hoodie_black"]),
    dict(id="partner", label="Partner: older, broad, fleece vest", model="adult",
         weights=dict(older=0.6, build_broad=0.4, vest=1.0), heightScale=[0.98, 1.05], outfits=["partner_vest"], hair=["grey", "white"]),
    dict(id="attendee", label="Attendee: long hair, skirt, lanyard", model="adult",
         weights=dict(curvy=0.9, hair_long=1.0, lanyard=1.0, skirt=1.0, build_slim=0.2), heightScale=[0.92, 0.99], outfits=["conference_red", "warm_mustard"]),
    dict(id="local", label="Local: heavier build", model="adult",
         weights=dict(build_heavy=0.9), heightScale=[0.95, 1.02], outfits=["rain_orange", "student_green", "designer_grey"]),
    dict(id="elder", label="Older adult: slight stoop, thinning hair", model="adult",
         weights=dict(older=1.0, build_slim=0.3, hair_none=0.5), heightScale=[0.92, 0.98], outfits=["retiree_beige", "partner_vest"], hair=["grey", "white"]),
    dict(id="runner", label="Runner: athletic, ponytail-length hair", model="adult",
         weights=dict(build_broad=0.6, curvy=0.4, hair_long=0.5), heightScale=[0.96, 1.03], outfits=["athleisure"]),
    dict(id="student", label="Student: slim, hoodie, long hair", model="adult",
         weights=dict(build_slim=0.7, hoodie=1.0, hair_long=1.0), heightScale=[0.94, 1.0], outfits=["student_green", "hoodie_heather"]),
    dict(id="child", label="Child (about seven): hoodie", model="child", child=True,
         weights=dict(hoodie=1.0), heightScale=[0.94, 1.05], outfits=["kid_yellow", "kid_blue"]),
    dict(id="child_long_hair", label="Child (about seven): long hair", model="child", child=True,
         weights=dict(hair_long=0.8), heightScale=[0.94, 1.05], outfits=["kid_blue", "kid_yellow"]),
]

SKIN_TONES = ["#f2d6c4", "#e3b796", "#c79067", "#a26b48", "#7a4a31", "#4d2f21"]
HAIR = {"black": "#1e1914", "dark_brown": "#3a2a1f", "brown": "#6e4b30", "auburn": "#9a522a", "blonde": "#cfae6c",
        "grey": "#a19f9a", "white": "#dcd8cf"}
# top, bottom, shoes, outer (vest), accent (lanyard), sole
OUTFITS = {
    "vest_charcoal": ["#8fb0cf", "#b5a07e", "#9b9a96", "#4c5259", "#e85a4f", "#efede8"],
    "vest_navy": ["#ebe8e1", "#2d3a4f", "#cdc6b9", "#25344c", "#3a7bd5", "#f2f0ea"],
    "hoodie_heather": ["#8c9096", "#2a2b2e", "#3b3d42", "#556b2f", "#f2b134", "#e9e6df"],
    "hoodie_black": ["#2a2c30", "#4a5568", "#d8d3c8", "#5a4a6a", "#9b6dd6", "#f4f1ea"],
    "partner_vest": ["#dfe7ef", "#3b3f46", "#6b5847", "#2f3438", "#2f6f9f", "#3a2f28"],
    "conference_red": ["#b23a48", "#1f2a44", "#ece6da", "#d9a441", "#f2b134", "#f4f1ea"],
    "warm_mustard": ["#e2b04a", "#3d5a80", "#c8c0b3", "#8b4c39", "#e85a4f", "#efebe3"],
    "rain_orange": ["#c96a2c", "#5d6d7e", "#4b3b30", "#2e4053", "#e8e8e8", "#2a2420"],
    "student_green": ["#3e7d5a", "#2c3e50", "#ece7dd", "#7a5c3a", "#f2b134", "#f6f3ec"],
    "retiree_beige": ["#d9c9a8", "#5f5f5f", "#3b2f2a", "#8a7f6a", "#7a9a5a", "#2a2420"],
    "athleisure": ["#7c6fd1", "#1f1f24", "#f2f0eb", "#e86a5c", "#e85a4f", "#ffffff"],
    "designer_grey": ["#3a3a3c", "#8a8f98", "#f4f1ea", "#b9b2a6", "#e85a4f", "#ffffff"],
    "kid_yellow": ["#f6c445", "#3d5a80", "#e94f37", "#3e7d5a", "#7ac0e8", "#ffffff"],
    "kid_blue": ["#7ac0e8", "#7a3b69", "#f2f0eb", "#f6c445", "#e94f37", "#ffffff"],
}
FIXED = {"eyes": "#18161a", "badge": "#f6f5f0"}
DEFAULT_LOOK = dict(outfit="vest_charcoal", hair="brown", skin=1)


def palette_colors(outfit, hair, skin):
    top, bottom, shoes, outer, accent, sole = OUTFITS[outfit]
    return [SKIN_TONES[skin], HAIR[hair], top, bottom, shoes, outer, accent, sole, FIXED["eyes"], FIXED["badge"]]


# ----------------------------------------------------------------------------- the bake


def frame_times(name, child=False):
    _, loop, fps = C.CLIPS[name][:3]
    d = C.duration(name, child)
    n = round(d * fps) if loop else round(d * fps) + 1
    return [i / fps for i in range(n)], fps


def bake(F, geos, clips, child):
    """Pose every clip frame (ground solved on LOD0) and skin each LOD. Returns per-LOD
    position and rotation stacks and the clip table."""
    out = {lod: dict(pos=[], quat=[]) for lod in geos}
    table = []
    start = 0
    for name in clips:
        times, fps = frame_times(name, child)
        poses = C.sample_clip(F, geos[0], name, times, child=child)
        for pose in poses:
            G = H.bone_globals(F, pose)
            for lod, g in geos.items():
                P, q = H.skin(g["P"], g["idx"], g["wts"], G)
                out[lod]["pos"].append(P)
                out[lod]["quat"].append(q)
        d, loop = C.duration(name, child), C.CLIPS[name][1]
        entry = dict(name=name, startFrame=start, frameCount=len(times), fps=fps, loop=loop, durationS=d)
        if name == "dive":
            entry["rootMotion"] = [round(C.DIVE_DX * F["scale"] if child else C.DIVE_DX, 3), 0.0, 0.0]
        if name == "walk":
            entry["speedMps"] = round(walk_speed(F, geos[0], child), 3)
        if name == "sit":
            entry["seatHeightM"] = round(C.SEAT_HEIGHT * (0.66 if child else 1.0), 3)
        table.append(entry)
        start += len(times)
    for lod in out:
        out[lod]["pos"] = np.asarray(out[lod]["pos"])
        out[lod]["quat"] = np.asarray(out[lod]["quat"])
    return out, table


def walk_speed(F, geo, child):
    """Ground speed that keeps the planted foot still: how fast the stance foot slides back."""
    T = C.CHILD_WALK_T if child else 1.0
    sole = np.flatnonzero((geo["S"] == H.SLOT["sole"]) & (geo["P"][:, 0] < 0))  # left foot
    ts = [0.15 * T, 0.4 * T]
    ys = []
    for t in ts:
        pose = C.sample_clip(F, geo, "walk", [t], child=child)[0]
        P, _ = H.skin(geo["P"][sole], geo["idx"][sole], geo["wts"][sole], H.bone_globals(F, pose))
        ys.append(P[:, 1].mean())
    return (ys[0] - ys[1]) / (ts[1] - ts[0])


def half(a):
    return np.asarray(a, dtype=np.float32).astype(np.float16).view(np.uint16)


def write_vat(path, geo, baked):
    """One .bin per model+LOD: [positions RGBA16F][rotations RGBA8][morphs RGBA16F]."""
    V = len(geo["P"])
    W = min(V, MAX_W)
    rpf = math.ceil(V / W)
    nF = baked["pos"].shape[0]
    K = len(H.KEYS)

    def texture(rows_per_item, items, channels, dtype):
        return np.zeros((items * rows_per_item * W, channels), dtype=dtype)

    pos = texture(rpf, nF, 4, np.float32)
    rot = texture(rpf, nF, 4, np.uint8)
    for f in range(nF):
        p = GW.to_gltf(baked["pos"][f])
        q = GW.quat_to_gltf(baked["quat"][f])
        base = f * rpf * W
        pos[base : base + V, :3] = p
        pos[base : base + V, 3] = 1.0
        rot[base : base + V] = np.clip(np.round((q * 0.5 + 0.5) * 255.0), 0, 255).astype(np.uint8)
    N0 = H.vertex_normals(geo["P"], geo["T"])
    morph = texture(rpf, K * 2, 4, np.float32)
    for k in range(K):
        d = geo["deltas"][k]
        n1 = H.vertex_normals(geo["P"] + d, geo["T"])
        for c, vec in ((0, d), (1, n1 - N0)):
            base = (2 * k + c) * rpf * W
            morph[base : base + V, :3] = GW.to_gltf(vec)
    blobs = [half(pos).tobytes(), rot.tobytes(), half(morph).tobytes()]
    with open(path, "wb") as f:
        for b in blobs:
            f.write(b)
    off = np.cumsum([0] + [len(b) for b in blobs])
    all_pos = GW.to_gltf(baked["pos"].reshape(-1, 3))
    return dict(
        vertexCount=V, width=W, rowsPerFrame=rpf, frames=nF,
        position=dict(format="RGBA16F", byteOffset=int(off[0]), byteLength=len(blobs[0]), height=nF * rpf),
        rotation=dict(format="RGBA8", byteOffset=int(off[1]), byteLength=len(blobs[1]), height=nF * rpf),
        morph=dict(format="RGBA16F", byteOffset=int(off[2]), byteLength=len(blobs[2]), height=K * 2 * rpf),
        bounds=dict(min=[round(float(v), 3) for v in all_pos.min(axis=0)], max=[round(float(v), 3) for v in all_pos.max(axis=0)]),
        triangles=int(len(geo["T"])),
    )


def crowd_mesh(w, name, geo, mat, extras):
    P = GW.to_gltf(geo["P"])
    N = GW.to_gltf(H.vertex_normals(geo["P"], geo["T"]))
    V = len(P)
    vid = np.arange(V, dtype=np.float32)
    slot = geo["S"].astype(np.float32)
    m = w.mesh(name, P, N, geo["T"].astype(np.uint32), mat,
               extra_attributes={"_VID": (vid, GW.FLOAT, False), "_SLOT": (slot, GW.FLOAT, False)}, extras=extras)
    return w.node(name, mesh=m, extras=extras)


# ---------------------------------------------------------------------------- the player


def build_player(F, geo):
    fc.reset()
    bpy.context.scene.render.fps = PLAYER_FPS
    bpy.context.scene.render.fps_base = 1.0
    look = palette_colors(DEFAULT_LOOK["outfit"], DEFAULT_LOOK["hair"], DEFAULT_LOOK["skin"])
    mats = []
    for i, slot in enumerate(H.SLOTS):
        name = f"tint_{slot}" if i < 8 else slot
        rough = {"hair": 0.55, "sole": 0.85, "eyes": 0.3, "badge": 0.4}.get(slot, 0.75)
        mats.append(fc.material(name, look[i], rough, extras={"tintSlot": slot, "slotIndex": i}))

    arm = bpy.data.armatures.new("player_rig")
    rig = bpy.data.objects.new("player", arm)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    J, tips = F["J"], F["tips"]
    children = {}
    for b, parent in H.BONES:
        if parent:
            children.setdefault(parent, []).append(b)
    tail_of = {"root": (0.0, 0.0, 0.12), "hips": J["spine"], "spine": J["chest"], "chest": J["neck"], "neck": J["head"]}
    for b, parent in H.BONES:
        eb = arm.edit_bones.new(b)
        eb.head = J[b]
        if b in tail_of:
            eb.tail = tail_of[b]
        elif b in tips:
            eb.tail = tips[b]
        else:
            eb.tail = J[children[b][0]]
        if parent:
            eb.parent = arm.edit_bones[parent]
        eb.use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    rest = {b.name: b.matrix_local.to_3x3() for b in arm.bones}

    me = bpy.data.meshes.new("player_body")
    me.from_pydata([tuple(p) for p in geo["P"]], [], [tuple(int(i) for i in t) for t in geo["T"]])
    for m in mats:
        me.materials.append(m)
    me.polygons.foreach_set("material_index", [int(geo["S"][t[0]]) for t in geo["T"]])
    me.polygons.foreach_set("use_smooth", [True] * len(geo["T"]))
    me.update()
    body = bpy.data.objects.new("player_body", me)
    bpy.context.scene.collection.objects.link(body)
    body.parent = rig
    for b, _ in H.BONES:
        body.vertex_groups.new(name=b)
    for v in range(len(geo["P"])):
        for j in range(4):
            w = float(geo["wts"][v, j])
            if w > 0:
                body.vertex_groups[H.BONES[int(geo["idx"][v, j])][0]].add([v], w, "REPLACE")
    mod = body.modifiers.new("rig", "ARMATURE")
    mod.object = rig
    body.shape_key_add(name="Basis", from_mix=False)
    for k, key in enumerate(H.KEYS):
        sk = body.shape_key_add(name=key, from_mix=False)
        sk.data.foreach_set("co", (geo["P"] + geo["deltas"][k]).reshape(-1))
    me["targetNames"] = list(H.KEYS)

    rig["fcActor"] = "player"
    rig["slots"] = list(H.SLOTS)
    rig["morphs"] = list(H.KEYS)
    rig["clips"] = [n for n, c in C.CLIPS.items() if c[3]]
    rig["groundY"] = 0.0

    # one action per clip, keyed every 1/30 s; pose rotations converted into each bone's frame
    rig.animation_data_create()
    for b in rig.pose.bones:
        b.rotation_mode = "QUATERNION"
    for name, spec in C.CLIPS.items():
        if not spec[3]:
            continue
        d, loop = spec[0], spec[1]
        n = round(d * PLAYER_FPS)
        times = [i / PLAYER_FPS for i in range(n + 1)]
        poses = C.sample_clip(F, geo, name, times)
        act = bpy.data.actions.new(name)
        act.use_fake_user = True
        rig.animation_data.action = act
        # create the curves once, then fill them in bulk
        for bname, _ in H.BONES:
            pb = rig.pose.bones[bname]
            pb.keyframe_insert("rotation_quaternion", frame=0, group=bname)
            if bname == "hips":
                pb.keyframe_insert("location", frame=0, group=bname)
        curves = {(c.data_path, c.array_index): c for c in act.fcurves}
        for bname, _ in H.BONES:
            B3 = rest[bname]
            Binv = B3.inverted()
            qs, ls = [], []
            for pose in poses:
                R = Matrix(H._rot(*pose.get(bname, (0.0, 0.0, 0.0))).tolist())
                q = (Binv @ R @ B3).to_quaternion()
                if qs and q.dot(Quaternion(qs[-1])) < 0:
                    q = -q
                qs.append(tuple(q))
                if bname == "hips":
                    ls.append(tuple(Binv @ Matrix.Translation(pose["hips_t"]).to_translation()))
            path = f'pose.bones["{bname}"].rotation_quaternion'
            for i in range(4):
                c = curves[(path, i)]
                c.keyframe_points.clear()
                c.keyframe_points.add(len(times))
                c.keyframe_points.foreach_set("co", [v for f, q in enumerate(qs) for v in (f, q[i])])
                c.keyframe_points.foreach_set("interpolation", [1] * len(times))  # LINEAR
            if bname == "hips":
                path = f'pose.bones["{bname}"].location'
                for i in range(3):
                    c = curves[(path, i)]
                    c.keyframe_points.clear()
                    c.keyframe_points.add(len(times))
                    c.keyframe_points.foreach_set("co", [v for f, l in enumerate(ls) for v in (f, l[i])])
                    c.keyframe_points.foreach_set("interpolation", [1] * len(times))
        for c in act.fcurves:
            c.update()
        track = rig.animation_data.nla_tracks.new()
        track.name = name
        track.strips.new(name, 0, act)
        rig.animation_data.action = None
    return rig, body


def check_player(rig, body, F, geo):
    """Blender's armature deform must match the numpy skinning the VAT used."""
    worst = 0.0
    for name, times in (("walk", [0.25, 0.6]), ("dive", [0.5, 1.2]), ("sit", [0.5])):
        act = bpy.data.actions[name]
        rig.animation_data.action = act
        for t in times:
            frame = t * PLAYER_FPS
            bpy.context.scene.frame_set(int(frame))
            bpy.context.view_layer.update()
            dg = bpy.context.evaluated_depsgraph_get()
            ev = body.evaluated_get(dg)
            m = ev.to_mesh()
            co = np.zeros(len(m.vertices) * 3)
            m.vertices.foreach_get("co", co)
            ev.to_mesh_clear()
            co = co.reshape(-1, 3)
            pose = C.sample_clip(F, geo, name, [int(frame) / PLAYER_FPS])[0]
            P, _ = H.skin(geo["P"], geo["idx"], geo["wts"], H.bone_globals(F, pose))
            worst = max(worst, float(np.abs(co - P).max()))
    rig.animation_data.action = None
    bpy.context.scene.frame_set(0)
    if worst > 2e-3:
        raise SystemExit(f"player rig deform differs from the VAT skinning by {worst:.4f} m")
    print(f"[fc] player rig matches the VAT skinning within {worst * 1000:.2f} mm")


def export_player():
    path = os.path.join(fc.MODELS_OUT, "player.glb")
    tris = fc.tri_count()
    if tris > BUDGET_LOD0:
        raise SystemExit(f"player.glb: {tris} triangles exceeds {BUDGET_LOD0}")
    bpy.ops.export_scene.gltf(
        filepath=path, export_format="GLB", use_selection=False, export_yup=True, export_apply=False,
        export_extras=True, export_cameras=False, export_lights=False, export_texcoords=False,
        export_normals=True, export_tangents=False, export_materials="EXPORT",
        export_skins=True, export_all_influences=False, export_def_bones=False,
        export_morph=True, export_morph_normal=True, export_morph_tangent=False,
        export_animations=True, export_animation_mode="ACTIONS", export_force_sampling=True,
        export_frame_step=1, export_optimize_animation_size=False, export_anim_single_armature=True,
        export_reset_pose_bones=True, export_rest_position_armature=True, export_current_frame=False,
        export_draco_mesh_compression_enable=False,
    )
    print(f"[fc] wrote {os.path.relpath(path, fc.REPO)}: {tris} tris, skinned, {len(H.KEYS)} morphs, {os.path.getsize(path) // 1024} KiB")


# ------------------------------------------------------------------------ reference data


def reference(F, geo, baked, table, variant, clip_frames, every=23):
    """Exact skinning of a variant (its own shape, not the VAT approximation) at a few frames,
    for tests/assets to check the decoder against."""
    P_var = H.variant_positions(geo, variant["weights"])
    ids = list(range(0, len(geo["P"]), every))
    samples = []
    for clip, local in clip_frames:
        c = next(x for x in table if x["name"] == clip)
        t = local / c["fps"]
        pose = C.sample_clip(F, geo, clip, [t], child=F["child"])[0]
        P, _ = H.skin(P_var[ids], geo["idx"][ids], geo["wts"][ids], H.bone_globals(F, pose))
        samples.append(dict(clip=clip, frame=local, positions=[[round(float(v), 5) for v in p] for p in GW.to_gltf(P)]))
    return dict(variant=variant["id"], vertices=ids, samples=samples)


# ---------------------------------------------------------------------------------- main


def main() -> None:
    os.makedirs(fc.MODELS_OUT, exist_ok=True)
    adult, child = H.adult_frame(), H.child_frame()
    geos = {
        "adult": {0: H.key_geometry(adult, 0), 1: H.key_geometry(adult, 1)},
        "child": {0: H.key_geometry(child, 0), 1: H.key_geometry(child, 1)},
    }
    for model, gl in geos.items():
        for lod, g in gl.items():
            limit = BUDGET_LOD0 if lod == 0 else BUDGET_LOD1
            if len(g["T"]) > limit:
                raise SystemExit(f"{model} LOD{lod}: {len(g['T'])} triangles exceeds {limit}")

    meta = dict(
        version=1,
        frame="glTF model space: metres, +Y up, the front faces -Z, origin on the ground between the feet",
        slots=list(H.SLOTS),
        morphs=list(H.KEYS),
        models={},
        clips={},
        variants=[],
        palette=dict(skinTones=SKIN_TONES, hair=HAIR, outfits={k: dict(zip(["top", "bottom", "shoes", "outer", "accent", "sole"], v)) for k, v in OUTFITS.items()},
                     fixed=FIXED, slotOrder=list(H.SLOTS)),
        impostor=None,
    )
    refs = {}
    w = GW.GlbWriter()
    mat = w.material("humanoid_vat", (1.0, 1.0, 1.0, 1.0), 0.8, extras={"vat": "humanoid-vat.json"})
    kids = []
    for model, F in (("adult", adult), ("child", child)):
        clips = [n for n, c in C.CLIPS.items() if c[4] and (c[5] or model == "adult")]
        baked, table = bake(F, geos[model], clips, child=(model == "child"))
        meta["clips"][model] = table
        meta["models"][model] = dict(child=model == "child", lods={})
        for lod, g in geos[model].items():
            fname = f"humanoid-vat-{model}-lod{lod}.bin"
            info = write_vat(os.path.join(fc.MODELS_OUT, fname), g, baked[lod])
            info["file"] = fname
            info["mesh"] = f"{model}_lod{lod}"
            meta["models"][model]["lods"][str(lod)] = info
            extras = {"vat": fname, "lod": lod, "model": model, "vertexCount": info["vertexCount"]}
            if model == "child":
                extras.update(child=True, noTouch=True)
            kids.append(crowd_mesh(w, f"{model}_lod{lod}", g, mat, extras))
            print(f"[fc] baked {model} LOD{lod}: {info['vertexCount']} verts, {info['triangles']} tris, {info['frames']} frames, "
                  f"{os.path.getsize(os.path.join(fc.MODELS_OUT, fname)) // 1024} KiB")
        ref_variant = next(v for v in VARIANTS if v["model"] == model and (v["id"] in ("partner", "child")))
        clip_frames = [("walk", 6), ("sit", 3), ("talk", 7)] + ([("dive", 12), ("wet_shake", 10)] if model == "adult" else [])
        refs[model] = reference(F, geos[model][0], baked[0], table, ref_variant, clip_frames)
    for v in VARIANTS:
        e = dict(v)
        e.setdefault("child", False)
        e["weights"] = {k: e["weights"].get(k, 0.0) for k in H.KEYS if e["weights"].get(k, 0.0)}
        meta["variants"].append(e)
    w.node("humanoid_crowd", children=kids, root=True,
           extras={"fcActor": "humanoid-crowd", "vat": "humanoid-vat.json", "people": True})
    crowd_path = os.path.join(fc.MODELS_OUT, "humanoid-crowd.glb")
    w.write(crowd_path)
    print(f"[fc] wrote {os.path.relpath(crowd_path, fc.REPO)}: 4 meshes, {os.path.getsize(crowd_path) // 1024} KiB")

    impostor_json = os.path.join(fc.MODELS_OUT, "humanoid-vat.json")
    if os.path.exists(impostor_json):
        with open(impostor_json, encoding="utf-8") as f:
            meta["impostor"] = json.load(f).get("impostor")
    fc.write_json(impostor_json, meta)
    os.makedirs(os.path.dirname(FIXTURE), exist_ok=True)
    fc.write_json(FIXTURE, refs)

    rig, body = build_player(adult, geos["adult"][0])
    check_player(rig, body, adult, geos["adult"][0])
    export_player()


main()
