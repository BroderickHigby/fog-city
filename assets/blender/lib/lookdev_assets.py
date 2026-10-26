"""Look-dev helpers for the wave-2 assets: a neutral studio set, the rust preview (the same
formula the renderer should use with _RUST_MASK), the melt keys, and crowd bodies decoded
from the vertex-animation textures exactly as the shader decodes them.
"""

from __future__ import annotations

import json
import math
import os

import bpy
import numpy as np

import fc
import lookdev as L

RUST_COLORS = ("#7a3418", "#b4561f")


def studio(res=(1600, 720), samples=48, warm=True, ground="#a8a39b"):
    sc = L.setup(res=res, samples=samples, look="AgX - Medium High Contrast")
    sc.render.threads = 2
    sc.cycles.seed = 11
    _, to_sun = L.sun(215 if warm else 160, 32, 3.2, "#ffe2bd" if warm else "#ffffff", angle_deg=4.0)
    L.world_gradient([(0.0, "#6f6a66"), (0.5, "#d9cfc4"), (0.56, "#c9d3dd"), (1.0, "#8fa6c2")], strength=0.75,
                     sun_dir=to_sun, sun_color=(1.0, 0.8, 0.6), sun_glow=0.4)
    L.point_light((0.0, -8.0, 7.0), 1800.0, "#dfe8ff", kind="AREA", size=(14.0, 6.0),
                  rot=(math.radians(50), 0.0, 0.0))
    g = L.flat_material("studio_floor", ground, 0.85)
    L.quad("floor", -60, -60, 60, 60, 0.0, g)
    return sc


def mesh_objs(objs):
    return [o for o in objs if getattr(o, "type", "") == "MESH"]


def set_keys(objs, **weights):
    for o in mesh_objs(objs):
        keys = o.data.shape_keys
        if not keys:
            continue
        for kb in keys.key_blocks[1:]:
            kb.value = float(weights.get(kb.name, 0.0))


def rust_preview(objs, rust: float, tag: str):
    """Rust the rustable materials by the mask: rusted = smoothstep(m - 0.1, m + 0.1, 1.1 * rust)."""
    for o in mesh_objs(objs):
        if "_RUST_MASK" not in o.data.attributes:
            continue
        for i, m in enumerate(o.data.materials):
            if m is None or not m.get("rustable"):
                continue
            key = f"{m.name}__rust_{tag}"
            mm = bpy.data.materials.get(key)
            if mm is None:
                mm = m.copy()
                mm.name = key
                nt = mm.node_tree
                bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
                base_in = bsdf.inputs["Base Color"]
                attr = nt.nodes.new("ShaderNodeAttribute")
                attr.attribute_type = "GEOMETRY"
                attr.attribute_name = "_RUST_MASK"
                lo = nt.nodes.new("ShaderNodeMath")
                lo.operation = "SUBTRACT"
                lo.inputs[1].default_value = 0.1
                hi = nt.nodes.new("ShaderNodeMath")
                hi.operation = "ADD"
                hi.inputs[1].default_value = 0.1
                nt.links.new(attr.outputs["Fac"], lo.inputs[0])
                nt.links.new(attr.outputs["Fac"], hi.inputs[0])
                mr = nt.nodes.new("ShaderNodeMapRange")
                mr.interpolation_type = "SMOOTHSTEP"
                mr.inputs["Value"].default_value = 1.1 * rust
                nt.links.new(lo.outputs[0], mr.inputs["From Min"])
                nt.links.new(hi.outputs[0], mr.inputs["From Max"])
                noise = nt.nodes.new("ShaderNodeTexNoise")
                noise.inputs["Scale"].default_value = 18.0
                ramp = nt.nodes.new("ShaderNodeValToRGB")
                ramp.color_ramp.elements[0].color = (*fc.hex_rgb(RUST_COLORS[0]), 1)
                ramp.color_ramp.elements[1].color = (*fc.hex_rgb(RUST_COLORS[1]), 1)
                nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
                mix = nt.nodes.new("ShaderNodeMix")
                mix.data_type = "RGBA"
                nt.links.new(mr.outputs["Result"], mix.inputs["Factor"])
                if base_in.links:
                    nt.links.new(base_in.links[0].from_socket, mix.inputs["A"])
                else:
                    mix.inputs["A"].default_value = base_in.default_value
                nt.links.new(ramp.outputs["Color"], mix.inputs["B"])
                nt.links.new(mix.outputs["Result"], base_in)
                rough = nt.nodes.new("ShaderNodeMix")
                rough.data_type = "FLOAT"
                rough.inputs["A"].default_value = bsdf.inputs["Roughness"].default_value
                rough.inputs["B"].default_value = 0.9
                nt.links.new(mr.outputs["Result"], rough.inputs["Factor"])
                if not bsdf.inputs["Roughness"].links:
                    nt.links.new(rough.outputs["Result"], bsdf.inputs["Roughness"])
            o.data.materials[i] = mm


def rest_pose(objs):
    """Clear any animation the glTF importer applied (the player's clips), back to rest."""
    for o in objs:
        ad = getattr(o, "animation_data", None)
        if ad is None:
            continue
        ad.action = None
        for t in list(ad.nla_tracks):
            ad.nla_tracks.remove(t)
        if o.type == "ARMATURE":
            for pb in o.pose.bones:
                pb.location = (0, 0, 0)
                pb.rotation_quaternion = (1, 0, 0, 0)
                pb.rotation_euler = (0, 0, 0)
                pb.scale = (1, 1, 1)


def player_looks(objs):
    """The player rig's looks (extras looks, defaultLook), as imported from player.glb."""
    for o in objs:
        if o.get("fcActor") == "player":
            looks = o["looks"].to_dict() if hasattr(o["looks"], "to_dict") else dict(o["looks"])
            return looks, o.get("defaultLook")
    raise KeyError("no player rig among the objects")


def default_look(objs, look_id=None):
    """Put an imported player.glb in one of its looks (its default unless look_id): the look's
    morph weights (the glTF default weights for the default look) and, for any other look, its
    palette row on the tint materials."""
    objs = list(objs)
    looks, default = player_looks(objs)
    look = looks[look_id or default]
    set_keys(objs, **{k: float(v) for k, v in look["morphs"].items()})
    if look_id and look_id != default:
        for o in mesh_objs(objs):
            for i, m in enumerate(o.data.materials):
                slot = m.get("tintSlot") if m else None
                if slot is None or slot not in look["palette"]:
                    continue
                mm = m.copy()
                mm.name = f"{m.name}__{look_id}"
                b = next(n for n in mm.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
                b.inputs["Base Color"].default_value = (*fc.hex_rgb(look["palette"][slot]), 1.0)
                o.data.materials[i] = mm


def lights_on(objs, strength=3.0):
    L.emission(objs, strength, prefix="light_")


def place(root, x, y=0.0, heading_deg=0.0, z=0.0):
    root.location = (x, y, z)
    root.rotation_mode = "XYZ"
    root.rotation_euler = (0.0, 0.0, -math.radians(heading_deg))


# ------------------------------------------------------------------- VAT-decoded crowds


class Vat:
    """The crowd bake, read the way the shader reads it (numpy)."""

    def __init__(self, model="adult", lod="0"):
        self.meta = json.load(open(os.path.join(fc.MODELS_OUT, "humanoid-vat.json"), encoding="utf-8"))
        self.lod = self.meta["models"][model]["lods"][lod]
        self.model = model
        raw = open(os.path.join(fc.MODELS_OUT, self.lod["file"]), "rb").read()
        W, V = self.lod["width"], self.lod["vertexCount"]
        rpf = self.lod["rowsPerFrame"]

        def sect(s, dtype, n):
            a = np.frombuffer(raw[s["byteOffset"] : s["byteOffset"] + s["byteLength"]], dtype=dtype).reshape(-1, 4)
            return a

        pos = sect(self.lod["position"], "<f2", 4).astype(np.float64)
        rot = sect(self.lod["rotation"], "u1", 4).astype(np.float64) / 255.0 * 2.0 - 1.0
        mor = sect(self.lod["morph"], "<f2", 4).astype(np.float64)
        idx = np.arange(V)
        col, row = idx % W, idx // W

        def at(a, r):
            return a[(r * rpf + row) * W + col]

        self.pos = lambda f: at(pos, f)[:, :3]
        self.rot = lambda f: at(rot, f)
        self.mor = lambda r: at(mor, r)[:, :3]
        self.clips = {c["name"]: c for c in self.meta["clips"][model]}
        self.keys = self.meta["morphs"]
        # topology and slots from the crowd GLB
        self.T, self.S = _crowd_topology(self.lod["mesh"])

    def positions(self, clip, local_frame, weights):
        f = self.clips[clip]["startFrame"] + local_frame
        p = self.pos(f)
        q = self.rot(f)
        q = q / np.linalg.norm(q, axis=1)[:, None]
        d = np.zeros_like(p)
        for k, key in enumerate(self.keys):
            w = weights.get(key, 0.0)
            if w:
                d += w * self.mor(2 * k)
        u, w4 = q[:, :3], q[:, 3:4]
        t = 2 * np.cross(u, d)
        d = d + w4 * t + np.cross(u, t)
        g = p + d
        return np.stack([g[:, 0], -g[:, 2], g[:, 1]], axis=1)  # glTF -> Blender

    def body(self, name, clip, frame, variant_id, colors, scale=1.0):
        v = next(x for x in self.meta["variants"] if x["id"] == variant_id)
        P = self.positions(clip, frame, v["weights"]) * scale
        me = bpy.data.meshes.new(name)
        me.from_pydata([tuple(p) for p in P], [], [tuple(int(i) for i in t) for t in self.T])
        for i, c in enumerate(colors):
            rough = 0.5 if i == 1 else 0.3 if i in (8, 9) else 0.75
            me.materials.append(L.flat_material(f"{name}_s{i}", c, rough))
        me.polygons.foreach_set("material_index", [int(self.S[t[0]]) for t in self.T])
        me.polygons.foreach_set("use_smooth", [True] * len(self.T))
        me.update()
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        return ob

    def colors(self, outfit, hair, skin):
        pal = self.meta["palette"]
        o = pal["outfits"][outfit]
        return [pal["skinTones"][skin], pal["hair"][hair], o["top"], o["bottom"], o["shoes"], o["outer"], o["accent"], o["sole"],
                pal["fixed"]["eyes"], pal["fixed"]["badge"]]


def _crowd_topology(mesh_name):
    """Triangles and slots of one crowd mesh, read from humanoid-crowd.glb (our own writer)."""
    raw = open(os.path.join(fc.MODELS_OUT, "humanoid-crowd.glb"), "rb").read()
    n = int.from_bytes(raw[12:16], "little")
    j = json.loads(raw[20 : 20 + n])
    binary = raw[20 + n + 8 :]
    mesh = next(m for m in j["meshes"] if m["name"] == mesh_name)
    prim = mesh["primitives"][0]

    def read(acc_i, dtype, width):
        acc = j["accessors"][acc_i]
        view = j["bufferViews"][acc["bufferView"]]
        off = view["byteOffset"] + acc.get("byteOffset", 0)
        a = np.frombuffer(binary[off : off + view["byteLength"]], dtype=dtype)
        return a[: acc["count"] * width].reshape(acc["count"], width) if width > 1 else a[: acc["count"]]

    comp = j["accessors"][prim["indices"]]["componentType"]
    idx = read(prim["indices"], "<u2" if comp == 5123 else "<u4", 1).reshape(-1, 3)
    slot = read(prim["attributes"]["_SLOT"], "<f4", 1).astype(np.int64)
    return idx, slot
