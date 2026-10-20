"""Fog City asset helpers for headless Blender (4.5 LTS).

Every model script builds its geometry in code with MeshBuilder, gives it simple PBR
materials, and exports one GLB with export_glb(). Nothing here needs the GUI.

Conventions (checked by tests/assets/):
  - metres; glTF +Y up; the model's FRONT faces glTF -Z. In Blender that means the model
    faces +Y, its right side is +X and up is +Z (the exporter maps Blender +Y to glTF -Z).
  - Ground is z = 0 in Blender (y = 0 in glTF) unless a script says otherwise.
  - Night-switchable emissive parts use materials whose names start with "light_" and
    nothing else is emissive, so the renderer can turn them up at night and down by day.
"""

from __future__ import annotations

import json
import math
import os
import sys

import bpy
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
BLENDER_DIR = os.path.dirname(HERE)
REPO = os.path.dirname(os.path.dirname(BLENDER_DIR))
MODELS_OUT = os.path.join(REPO, "public", "models")


# --------------------------------------------------------------------------- scene


def script_args() -> list[str]:
    """Arguments after the "--" on the Blender command line."""
    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def reset() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _MATS.clear()


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgb(h: str) -> tuple[float, float, float]:
    h = h.lstrip("#")
    return tuple(srgb_to_linear(int(h[i : i + 2], 16) / 255.0) for i in (0, 2, 4))  # type: ignore[return-value]


# ----------------------------------------------------------------------- materials

_MATS: dict[str, bpy.types.Material] = {}


def material(
    name: str,
    color: str = "#cccccc",
    rough: float = 0.6,
    metal: float = 0.0,
    emission: str | None = None,
    strength: float = 1.0,
    image: str | None = None,
    alpha_clip: float | None = None,
    double_sided: bool = False,
    extras: dict | None = None,
) -> bpy.types.Material:
    """A Principled BSDF material the glTF exporter maps 1:1 to metallic-roughness PBR.

    emission: hex colour; only allowed on materials named light_* (night switchable).
    image: path to a PNG used as base colour (and alpha when alpha_clip is set).
    alpha_clip: export as alphaMode MASK with this cutoff (never BLEND).
    """
    if name in _MATS:
        return _MATS[name]
    if emission is not None and not name.startswith("light_"):
        raise ValueError(f"emissive material {name!r} must be named light_*")
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    r, g, b = hex_rgb(color)
    bsdf.inputs["Base Color"].default_value = (r, g, b, 1.0)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if emission is not None:
        er, eg, eb = hex_rgb(emission)
        bsdf.inputs["Emission Color"].default_value = (er, eg, eb, 1.0)
        bsdf.inputs["Emission Strength"].default_value = strength
    if image is not None:
        img = bpy.data.images.load(image, check_existing=True)
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        tex.interpolation = "Linear"
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        if alpha_clip is not None:
            # The glTF exporter reads "alpha > cutoff" (Math GREATER_THAN) as alphaMode MASK.
            gt = nt.nodes.new("ShaderNodeMath")
            gt.operation = "GREATER_THAN"
            gt.inputs[1].default_value = alpha_clip
            nt.links.new(tex.outputs["Alpha"], gt.inputs[0])
            nt.links.new(gt.outputs[0], bsdf.inputs["Alpha"])
    m.use_backface_culling = not double_sided
    m.diffuse_color = (r, g, b, 1.0)
    if extras:
        for k, v in extras.items():
            m[k] = v
    _MATS[name] = m
    return m


# --------------------------------------------------------------------- mesh builder


def _uv_default(n: int) -> list[tuple[float, float]]:
    return [(0.0, 0.0)] * n


class MeshBuilder:
    """Accumulates polygons in Python, then builds one Blender mesh object.

    Every primitive creates its own vertices, so smoothing never bleeds between parts.
    A transform stack (push/pop) places sub-assemblies.
    """

    def __init__(self) -> None:
        self.verts: list[tuple[float, float, float]] = []
        self.faces: list[tuple[int, ...]] = []
        self.face_mat: list[int] = []
        self.face_smooth: list[bool] = []
        self.face_uv: list[list[tuple[float, float]] | None] = []
        self.mats: list[bpy.types.Material] = []
        self.m = Matrix.Identity(4)
        self._stack: list[Matrix] = []

    # transforms -----------------------------------------------------------------
    def push(self, mat: Matrix) -> "MeshBuilder":
        self._stack.append(self.m.copy())
        self.m = self.m @ mat
        return self

    def pop(self) -> None:
        self.m = self._stack.pop()

    def _mi(self, mat: bpy.types.Material) -> int:
        for i, x in enumerate(self.mats):
            if x == mat:
                return i
        self.mats.append(mat)
        return len(self.mats) - 1

    def v(self, co) -> int:
        p = self.m @ Vector(co)
        self.verts.append((p.x, p.y, p.z))
        return len(self.verts) - 1

    def face(self, idx, mat, smooth=False, uv=None) -> None:
        self.faces.append(tuple(idx))
        self.face_mat.append(self._mi(mat))
        self.face_smooth.append(smooth)
        self.face_uv.append(uv)

    def poly(self, pts, mat, smooth=False, uv=None) -> None:
        """One polygon from 3D points (counter-clockwise seen from the front)."""
        self.face([self.v(p) for p in pts], mat, smooth, uv)

    def poly_n(self, pts, mat, normal, smooth=False, uv=None) -> None:
        """One polygon, wound so its normal points along `normal` (local coordinates)."""
        nx = ny = nz = 0.0
        k = len(pts)
        for i in range(k):
            a, b = pts[i], pts[(i + 1) % k]
            nx += (a[1] - b[1]) * (a[2] + b[2])
            ny += (a[2] - b[2]) * (a[0] + b[0])
            nz += (a[0] - b[0]) * (a[1] + b[1])
        if nx * normal[0] + ny * normal[1] + nz * normal[2] < 0:
            pts = list(reversed(pts))
            if uv is not None:
                uv = list(reversed(uv))
        self.poly(pts, mat, smooth, uv)

    def add(self, other: "MeshBuilder") -> None:
        """Append another builder's geometry, transformed by the current matrix."""
        base = len(self.verts)
        for p in other.verts:
            q = self.m @ Vector(p)
            self.verts.append((q.x, q.y, q.z))
        for f, mi, s, uv in zip(other.faces, other.face_mat, other.face_smooth, other.face_uv):
            self.face([base + i for i in f], other.mats[mi], s, uv)

    # primitives -----------------------------------------------------------------
    def box(self, x0, y0, z0, x1, y1, z1, mat, skip=(), uv_scale=None) -> None:
        """Axis-aligned box. skip: subset of {'-x','+x','-y','+y','-z','+z'} faces to omit."""
        if x0 > x1:
            x0, x1 = x1, x0
        if y0 > y1:
            y0, y1 = y1, y0
        if z0 > z1:
            z0, z1 = z1, z0
        P = [
            (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
            (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
        ]
        F = {
            "-z": (0, 3, 2, 1), "+z": (4, 5, 6, 7),
            "-y": (0, 1, 5, 4), "+y": (2, 3, 7, 6),
            "-x": (3, 0, 4, 7), "+x": (1, 2, 6, 5),
        }
        for k, f in F.items():
            if k in skip:
                continue
            self.poly([P[i] for i in f], mat)

    def boxc(self, cx, cy, cz, sx, sy, sz, mat, skip=()) -> None:
        self.box(cx - sx / 2, cy - sy / 2, cz - sz / 2, cx + sx / 2, cy + sy / 2, cz + sz / 2, mat, skip)

    def prism(self, pts2d, z0, z1, mat, top=True, bottom=False, smooth=False) -> None:
        """Extrude a 2D polygon (x, y), counter-clockwise from above, from z0 to z1."""
        n = len(pts2d)
        for i in range(n):
            a = pts2d[i]
            b = pts2d[(i + 1) % n]
            self.poly([(a[0], a[1], z0), (b[0], b[1], z0), (b[0], b[1], z1), (a[0], a[1], z1)], mat, smooth)
        if top:
            self.poly([(x, y, z1) for x, y in pts2d], mat)
        if bottom:
            self.poly([(x, y, z0) for x, y in reversed(pts2d)], mat)

    def frustum(self, pts_bottom, pts_top, z0, z1, mat, top=True, bottom=False) -> None:
        """Loft between two 2D polygons with the same vertex count (a tapered prism)."""
        n = len(pts_bottom)
        for i in range(n):
            a, b = pts_bottom[i], pts_bottom[(i + 1) % n]
            c, d = pts_top[(i + 1) % n], pts_top[i]
            self.poly([(a[0], a[1], z0), (b[0], b[1], z0), (c[0], c[1], z1), (d[0], d[1], z1)], mat)
        if top:
            self.poly([(x, y, z1) for x, y in pts_top], mat)
        if bottom:
            self.poly([(x, y, z0) for x, y in reversed(pts_bottom)], mat)

    def lathe(self, profile, seg, mat, smooth=True, phase=0.0, cap_top=False, cap_bottom=False,
              cap_mat=None, arc=None) -> None:
        """Revolve [(r, z), ...] (bottom to top) about local Z. arc=(a0, a1) for a partial sweep."""
        full = arc is None
        a0, a1 = (0.0, 2 * math.pi) if full else arc
        cols = seg if full else seg + 1
        rings = []
        for (r, z) in profile:
            ring = []
            for j in range(cols):
                a = a0 + (a1 - a0) * j / seg + phase
                ring.append(self.v((r * math.cos(a), r * math.sin(a), z)))
            rings.append(ring)
        for i in range(len(profile) - 1):
            for j in range(seg):
                j2 = (j + 1) % cols if full else j + 1
                q = [rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j]]
                if profile[i][0] == 0 and profile[i + 1][0] == 0:
                    continue
                if profile[i][0] == 0:
                    q = [rings[i][j], rings[i + 1][j2], rings[i + 1][j]]
                elif profile[i + 1][0] == 0:
                    q = [rings[i][j], rings[i][j2], rings[i + 1][j]]
                self.face(q, mat, smooth)
        cm = cap_mat or mat
        if cap_top and profile[-1][0] > 0 and full:
            r, z = profile[-1]
            self.poly([(r * math.cos(a0 + 2 * math.pi * j / seg + phase), r * math.sin(a0 + 2 * math.pi * j / seg + phase), z) for j in range(seg)], cm)
        if cap_bottom and profile[0][0] > 0 and full:
            r, z = profile[0]
            self.poly([(r * math.cos(a0 + 2 * math.pi * j / seg + phase), r * math.sin(a0 + 2 * math.pi * j / seg + phase), z) for j in reversed(range(seg))], cm)

    def cylinder(self, r, z0, z1, seg, mat, smooth=True, caps=True, cap_mat=None, phase=0.0) -> None:
        """Vertical cylinder about local Z."""
        self.lathe([(r, z0), (r, z1)], seg, mat, smooth, phase, cap_top=caps, cap_bottom=caps, cap_mat=cap_mat)

    def cyl_between(self, p0, p1, r, seg, mat, smooth=True, caps=True, r1=None) -> None:
        """Cylinder (or cone when r1 is given) from point p0 to p1."""
        p0, p1 = Vector(p0), Vector(p1)
        d = p1 - p0
        L = d.length
        if L < 1e-9:
            return
        rot = d.normalized().to_track_quat("Z", "Y").to_matrix().to_4x4()
        self.push(Matrix.Translation(p0) @ rot)
        rr = r if r1 is None else r1
        self.lathe([(r, 0.0), (rr, L)], seg, mat, smooth, cap_top=caps, cap_bottom=caps)
        self.pop()

    def sphere(self, c, r, seg, rings, mat, smooth=True, scale=(1, 1, 1)) -> None:
        prof = []
        for i in range(rings + 1):
            t = math.pi * i / rings - math.pi / 2
            prof.append((r * math.cos(t) if 0 < i < rings else 0.0, r * math.sin(t)))
        self.push(Matrix.Translation(c) @ Matrix.Diagonal((*scale, 1)))
        self.lathe(prof, seg, mat, smooth)
        self.pop()

    def loft(self, sections, mat, closed=True, cap_start=False, cap_end=False, smooth=True,
             mats=None, uvs=None) -> None:
        """Skin a list of sections (each a list of 3D points, same count).

        closed: the sections are closed rings. mats[i][j] optionally overrides the material of
        the quad between section i..i+1 and point j..j+1.
        """
        rows = [[self.v(p) for p in s] for s in sections]
        n = len(sections[0])
        segs = n if closed else n - 1
        for i in range(len(rows) - 1):
            for j in range(segs):
                j2 = (j + 1) % n
                q = [rows[i][j], rows[i][j2], rows[i + 1][j2], rows[i + 1][j]]
                mm = mats[i][j] if mats is not None and mats[i][j] is not None else mat
                uv = uvs[i][j] if uvs is not None else None
                self.face(q, mm, smooth, uv)
        if cap_start:
            self.poly(list(reversed(sections[0])), mat)
        if cap_end:
            self.poly(list(sections[-1]), mat)

    # output ---------------------------------------------------------------------
    def build(self, name: str, parent=None, location=(0, 0, 0)) -> bpy.types.Object:
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.verts, [], self.faces)
        for mt in self.mats:
            me.materials.append(mt)
        me.polygons.foreach_set("material_index", self.face_mat)
        me.polygons.foreach_set("use_smooth", self.face_smooth)
        if any(uv is not None for uv in self.face_uv):
            layer = me.uv_layers.new(name="UVMap")
            data = []
            for poly, uv in zip(me.polygons, self.face_uv):
                pts = uv if uv is not None else _uv_default(poly.loop_total)
                if len(pts) != poly.loop_total:
                    raise ValueError(f"{name}: uv count {len(pts)} != loop count {poly.loop_total}")
                for p in pts:
                    data.extend(p)
            layer.data.foreach_set("uv", data)
        me.validate(clean_customdata=False)
        me.update()
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        ob.location = location
        if parent is not None:
            ob.parent = parent
        return ob


def empty(name: str, location=(0, 0, 0), parent=None, rotation=(0, 0, 0)) -> bpy.types.Object:
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_size = 0.3
    bpy.context.scene.collection.objects.link(ob)
    ob.location = location
    ob.rotation_euler = rotation
    if parent is not None:
        ob.parent = parent
    return ob


def set_parent_keep(child: bpy.types.Object, parent: bpy.types.Object) -> None:
    """Parent without moving the child in world space."""
    mw = child.matrix_world.copy()
    child.parent = parent
    child.matrix_parent_inverse = Matrix.Identity(4)
    bpy.context.view_layer.update()
    child.matrix_world = mw


# ------------------------------------------------------------------------- reports


def tri_count(objects=None) -> int:
    """Triangles after modifiers, summed over mesh objects (what the exporter writes)."""
    dg = bpy.context.evaluated_depsgraph_get()
    total = 0
    for ob in objects or bpy.context.scene.objects:
        if ob.type != "MESH":
            continue
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        total += len(me.loop_triangles)
        ev.to_mesh_clear()
    return total


def world_bounds(objects=None):
    dg = bpy.context.evaluated_depsgraph_get()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for ob in objects or bpy.context.scene.objects:
        if ob.type != "MESH":
            continue
        ev = ob.evaluated_get(dg)
        me = ev.to_mesh()
        mw = ob.matrix_world
        for vtx in me.vertices:
            p = mw @ vtx.co
            lo = Vector((min(lo.x, p.x), min(lo.y, p.y), min(lo.z, p.z)))
            hi = Vector((max(hi.x, p.x), max(hi.y, p.y), max(hi.z, p.z)))
        ev.to_mesh_clear()
    return lo, hi


def export_glb(filename: str, budget: int | None = None) -> str:
    """Export the whole scene as public/models/<filename> and print a one-line report."""
    os.makedirs(MODELS_OUT, exist_ok=True)
    path = os.path.join(MODELS_OUT, filename)
    tris = tri_count()
    if budget is not None and tris > budget:
        raise SystemExit(f"{filename}: {tris} triangles exceeds budget {budget}")
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=False,
        export_yup=True,
        export_apply=True,
        export_extras=True,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_draco_mesh_compression_enable=False,
    )
    lo, hi = world_bounds()
    size = hi - lo
    print(
        f"[fc] wrote {os.path.relpath(path, REPO)}: {tris} tris"
        + (f" (budget {budget})" if budget else "")
        + f", size x{size.x:.2f} y(depth){size.y:.2f} z(up){size.z:.2f}, {os.path.getsize(path) // 1024} KiB"
    )
    return path


def write_json(path: str, data) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
