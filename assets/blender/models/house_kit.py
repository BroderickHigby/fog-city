"""San Francisco house kit: instanced prototypes for the house features the world QA found
missing (house-kit-spec.md K6, K7, K8; world QA W-49, W-50, W-38, W-33)
-> public/models/house-kit/*.glb, house-kit/stair-treads.png and house-kit/house-kit.json

  bay-italianate.glb   angled bay (1860s-1890s), segmental window heads   nodes storey, cap
  bay-queen-anne.glb   angled bay with a shingled apron and a hipped cap  nodes storey, cap
  bay-edwardian.glb    square bay (1900s-1920s), wide sashes              nodes storey, cap
  bay-turret.glb       octagonal corner turret with a conical roof        nodes storey, cap
  stoop.glb            parametric entry stair: step, landing, cheek, rail, door
  roof-water-tank.glb  a timber water tank on a steel stand
  roof-mech-box.glb    a rooftop mechanical unit (louvres, fan grille), scaled per roof
  roof-penthouse.glb   a stair or elevator penthouse with its door
  cornice-italianate.glb, cornice-edwardian.glb, parapet-coping.glb
                       1 m segments of the roofline mouldings, instanced along front walls
  stair-flight.glb     a public stairway's parts: step, landing, curb, handrail
  stair-treads.png     a tileable stair-tread texture for drawing steps on a path ribbon

Every prototype is ONE mesh per node with ONE material (`house_kit`, base colour from the
vertex colours), so all instances of a node draw in one call. A per-vertex `_SLOT` attribute
(three.js `_slot`) names what each face is, for recolouring per instance:
  0 body (the house's wall colour), 1 trim (its trim colour), 2 glass, 3 roof and metal,
  4 stone and concrete, 5 dark (doors, shadow).
COLOR_0 holds a default colour per slot, so a plain vertex-coloured material shows something
sensible before the shader recolours. The layout maths (how many storeys, steps, segments,
where) is in assets/blender/runtime/house-kit.ts; house-kit.json holds every number it uses.

Frames (all metres, glTF +Y up, front = -Z = out of the wall):
- Bays and the door: origin on the wall plane, at the floor line, centred; they project
  toward -Z. `storey` is one storey of 3.2 m (scale y by storeyM / 3.2); `cap` sits on top
  of the last storey.
- Stoop and stair parts are unit blocks the layout scales and shears (runtime/house-kit.ts).
- Roof props: origin on the roof at the prop's centre.
- Roofline segments: origin on the wall's outer face at the roof line (the collider's topY),
  1 m along +X; nothing rises more than 0.1 m above the roof line (house-kit-spec K8).
No text, signs, logos or brand marks anywhere.
"""

import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix  # noqa: E402

import fc  # noqa: E402

OUT = os.path.join(fc.MODELS_OUT, "house-kit")
STOREY = 3.2
SLOTS = [
    ("body", "#d9c6a6"),
    ("trim", "#f2efe6"),
    ("glass", "#36434c"),
    ("roof", "#5b5e60"),
    ("stone", "#bcb6aa"),
    ("dark", "#3a2f2a"),
]
BUDGETS = {
    "bay-italianate.glb": 260,
    "bay-queen-anne.glb": 280,
    "bay-edwardian.glb": 220,
    "bay-turret.glb": 420,
    "stoop.glb": 160,
    "roof-water-tank.glb": 420,
    "roof-mech-box.glb": 140,
    "roof-penthouse.glb": 90,
    "cornice-italianate.glb": 120,
    "cornice-edwardian.glb": 110,
    "parapet-coping.glb": 40,
    "stair-flight.glb": 90,
}

_SLOT_MATS: list = []


def slot_mats():
    """Tag materials, one per slot; replaced by the single house_kit material on export."""
    global _SLOT_MATS
    _SLOT_MATS = [fc.material(f"_slot_{name}", col, 0.7) for name, col in SLOTS]
    return _SLOT_MATS


def house_kit_material():
    m = bpy.data.materials.get("house_kit")
    if m is not None:
        return m
    m = bpy.data.materials.new("house_kit")
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    col = nt.nodes.new("ShaderNodeVertexColor")
    col.layer_name = "Col"
    nt.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.75
    m["slots"] = [name for name, _ in SLOTS]
    return m


def finish(ob) -> None:
    """Turn a part built with the slot tag materials into one material + COLOR_0 + _SLOT."""
    me = ob.data
    names = [m.name for m in me.materials]
    slot_of = []
    for n in names:
        if not n.startswith("_slot_"):
            raise ValueError(f"{ob.name}: material {n} is not a slot")
        slot_of.append([s for s, _ in SLOTS].index(n[len("_slot_"):]))
    nv = len(me.vertices)
    vslot = np.zeros(nv, dtype=np.float32)
    for p in me.polygons:
        for vi in p.vertices:
            vslot[vi] = slot_of[p.material_index]
    attr = me.attributes.new("_SLOT", "FLOAT", "POINT")
    attr.data.foreach_set("value", vslot)
    ca = me.color_attributes.new("Col", "BYTE_COLOR", "POINT")
    rgba = np.zeros((nv, 4), dtype=np.float32)
    for i, (_, hexcol) in enumerate(SLOTS):
        r, g, b = fc.hex_rgb(hexcol)
        rgba[vslot == i] = (r, g, b, 1.0)
    ca.data.foreach_set("color", rgba.ravel())
    me.materials.clear()
    me.materials.append(house_kit_material())
    for p in me.polygons:
        p.material_index = 0


def part(mb: fc.MeshBuilder, name: str, parent, **extras):
    ob = mb.build(name, parent=parent, sharp_angle=40)
    finish(ob)
    for k, v in extras.items():
        ob[k] = v
    return ob


def export(filename: str) -> None:
    fc.export_glb(filename, BUDGETS[filename], out_dir=OUT, attributes=True)


def kit_root(name: str, kind: str, **extras):
    r = fc.empty(name)
    r["houseKit"] = kind
    r["slots"] = [n for n, _ in SLOTS]
    for k, v in extras.items():
        r[k] = v
    return r


# ------------------------------------------------------------------------------- helpers

def window(mb, pts_wall, normal, S, sill=True, head="flat", inset=0.06):
    """A window on a planar face: glass quad set back by `inset`, a trim surround, a sill.
    pts_wall: (a, b, c, d) the opening's corners bottom-left, bottom-right, top-right, top-left."""
    body, trim, glass = S[0], S[1], S[2]
    a, b, c, d = [np.array(p, dtype=float) for p in pts_wall]
    n = np.array(normal, dtype=float)
    back = -n * inset
    mb.poly_n([tuple(a + back), tuple(b + back), tuple(c + back), tuple(d + back)], glass, tuple(n))
    # reveal (the opening's sides, top and bottom)
    for p, q in ((a, b), (b, c), (c, d), (d, a)):
        mb.poly_n([tuple(p), tuple(q), tuple(q + back), tuple(p + back)], trim, tuple(-((p + q) / 2 - (a + c) / 2)))
    # surround: a thin frame proud of the wall
    out = n * 0.03
    w = 0.09
    u = (b - a) / np.linalg.norm(b - a)
    v = (d - a) / np.linalg.norm(d - a)
    for (p0, p1, du, dv) in ((a, b, 0, -1), (d, c, 0, 1), (a, d, -1, 0), (b, c, 1, 0)):
        q0 = p0 + (u * du + v * dv) * w
        q1 = p1 + (u * du + v * dv) * w
        mb.poly_n([tuple(p0 + out), tuple(p1 + out), tuple(q1 + out), tuple(q0 + out)], trim, tuple(n))
    if head == "segmental":
        apex = (d + c) / 2 + v * 0.22
        mb.poly_n([tuple(d + out + v * w), tuple(c + out + v * w), tuple(apex + out + v * w)], trim, tuple(n))
    if sill:
        s0 = a - u * 0.12 - v * 0.02
        s1 = b + u * 0.12 - v * 0.02
        lo = -v * 0.07
        mb.poly_n([tuple(s0 + n * 0.08), tuple(s1 + n * 0.08), tuple(s1 + n * 0.08 + lo), tuple(s0 + n * 0.08 + lo)], trim, tuple(n))
        mb.poly_n([tuple(s0), tuple(s1), tuple(s1 + n * 0.08), tuple(s0 + n * 0.08)], trim, (0, 0, 1))


def face_wall(mb, p0, p1, z0, z1, mat, normal):
    mb.poly_n([(p0[0], p0[1], z0), (p1[0], p1[1], z0), (p1[0], p1[1], z1), (p0[0], p0[1], z1)], mat, normal)


def outward(plan, p0, p1, centre=None):
    """The outward unit normal of plan edge p0-p1: away from `centre` (default the plan's centroid)."""
    dx, dy = p1[0] - p0[0], p1[1] - p0[1]
    L = math.hypot(dx, dy)
    nx, ny = dy / L, -dx / L
    if centre is None:
        cx = sum(p[0] for p in plan) / len(plan)
        cy = sum(p[1] for p in plan) / len(plan)
    else:
        cx, cy = centre
    mx, my = (p0[0] + p1[0]) / 2 - cx, (p0[1] + p1[1]) / 2 - cy
    if nx * mx + ny * my < 0:
        nx, ny = -nx, -ny
    return nx, ny, L


def faceted_bay(mb, plan, S, head="flat", sash=0.62, apron_mat=None, band=None, centre=None, blank=()):
    """One storey of a bay whose plan is a polyline from the wall (left) to the wall (right).
    Each face gets its wall below the sill, a window, and wall above; plan points are (x, y)
    in Blender (y = out of the wall). Returns nothing; draws into mb."""
    body, trim = S[0], S[1]
    z_sill, z_head = 0.85, 2.55
    for i in range(len(plan) - 1):
        p0, p1 = plan[i], plan[i + 1]
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        nx, ny, L = outward(plan, p0, p1, centre)
        n = (nx, ny, 0.0)
        if i in blank:  # a half face against the house's wall: no window
            face_wall(mb, p0, p1, 0.0, STOREY, body, n)
            continue
        face_wall(mb, p0, p1, 0.0, z_sill, apron_mat or body, n)
        face_wall(mb, p0, p1, z_head, STOREY, band or body, n)
        # the window takes `sash` of the face; the piers either side are wall
        m = (1 - sash) / 2
        q0 = (p0[0] + dx * m, p0[1] + dy * m)
        q1 = (p0[0] + dx * (1 - m), p0[1] + dy * (1 - m))
        face_wall(mb, p0, q0, z_sill, z_head, body, n)
        face_wall(mb, q1, p1, z_sill, z_head, body, n)
        window(mb, ((q0[0], q0[1], z_sill), (q1[0], q1[1], z_sill), (q1[0], q1[1], z_head), (q0[0], q0[1], z_head)), n, S, head=head)
    # floor slab edge band between storeys (trim) and the soffit underneath
    outline = [(x, y) for x, y in plan]
    mb.poly_n([(x, y, 0.0) for x, y in outline], trim, (0, 0, -1))


def angled_plan(width, depth, front):
    """Wall-left, front-left, front-right, wall-right (Blender: y out of the wall)."""
    return [(-width / 2, -0.05), (-front / 2, depth), (front / 2, depth), (width / 2, -0.05)]


def cap_cornice(mb, plan, S, depth_out=0.28, h=0.55, brackets=0, centre=None):
    """A moulded cornice following the bay's plan, with optional brackets, and a flat top."""
    trim = S[1]
    for i in range(len(plan) - 1):
        p0, p1 = plan[i], plan[i + 1]
        dx, dy = p1[0] - p0[0], p1[1] - p0[1]
        nx, ny, L = outward(plan, p0, p1, centre)
        o = (nx * depth_out, ny * depth_out)
        # frieze (vertical), soffit (under the projection), fascia (front)
        face_wall(mb, p0, p1, 0.0, h * 0.45, S[0], (nx, ny, 0))
        a0, a1 = (p0[0] + o[0], p0[1] + o[1]), (p1[0] + o[0], p1[1] + o[1])
        mb.poly_n([(p0[0], p0[1], h * 0.45), (p1[0], p1[1], h * 0.45), (a1[0], a1[1], h * 0.6), (a0[0], a0[1], h * 0.6)], trim, (nx, ny, -1))
        face_wall(mb, a0, a1, h * 0.6, h, trim, (nx, ny, 0))
        for k in range(brackets):
            t = (k + 0.5) / brackets
            bx, by = p0[0] + dx * t, p0[1] + dy * t
            mb.push(Matrix.Translation((bx, by, 0)) @ Matrix.Rotation(math.atan2(ny, nx) - math.pi / 2, 4, "Z"))
            mb.box(-0.06, 0.0, h * 0.15, 0.06, depth_out * 0.9, h * 0.6, trim)
            mb.pop()
    return [(p[0], p[1]) for p in plan]


def flat_top(mb, plan, z, mat, grow=0.28):
    """Close the top of a bay over its plan, grown outward by `grow` on the outer faces."""
    cx = sum(p[0] for p in plan) / len(plan)
    pts = []
    for (x, y) in plan:
        if y <= 0:
            pts.append((x, y))
        else:
            dx, dy = x - cx, y
            L = math.hypot(dx, dy) or 1
            pts.append((x + dx / L * grow, y + dy / L * grow))
    mb.poly_n([(x, y, z) for x, y in pts], mat, (0, 0, 1))


# ----------------------------------------------------------------------------------- bays

def bay_italianate() -> dict:
    fc.reset()
    S = slot_mats()
    root = kit_root("bay_italianate", "bay", style="italianate", era=[1860, 1895], widthM=2.7, depthM=0.9)
    plan = angled_plan(2.7, 0.9, 1.3)
    st = fc.MeshBuilder()
    faceted_bay(st, plan, S, head="segmental", sash=0.6)
    part(st, "storey", root, storeyM=STOREY)
    cp = fc.MeshBuilder()
    cap_cornice(cp, plan, S, depth_out=0.32, h=0.7, brackets=2)
    flat_top(cp, plan, 0.7, S[3], grow=0.32)
    part(cp, "cap", root)
    export("bay-italianate.glb")
    return {"kind": "bay", "style": "italianate", "era": [1860, 1895], "widthM": 2.7, "depthM": 0.9, "capM": 0.7, "shape": "angled"}


def bay_queen_anne() -> dict:
    fc.reset()
    S = slot_mats()
    root = kit_root("bay_queen_anne", "bay", style="queen-anne", era=[1885, 1905], widthM=2.9, depthM=0.95)
    plan = angled_plan(2.9, 0.95, 1.4)
    st = fc.MeshBuilder()
    # the shingled apron under the sills reads as trim colour
    faceted_bay(st, plan, S, head="flat", sash=0.58, apron_mat=S[1])
    part(st, "storey", root, storeyM=STOREY)
    cp = fc.MeshBuilder()
    cap_cornice(cp, plan, S, depth_out=0.3, h=0.45)
    # a hipped cap: from the cornice up to a short ridge against the wall
    g = 0.3
    cx = 0.0
    pts = []
    for (x, y) in plan:
        if y <= 0:
            pts.append((x, y))
        else:
            dx, dy = x - cx, y
            L = math.hypot(dx, dy)
            pts.append((x + dx / L * g, y + dy / L * g))
    apex = (0.0, 0.05, 1.45)
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i + 1]
        cp.poly_n([(a[0], a[1], 0.45), (b[0], b[1], 0.45), apex], S[3], ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 0.6))
    cp.cylinder(0.04, 1.45, 1.8, 6, S[3], smooth=False)
    part(cp, "cap", root)
    export("bay-queen-anne.glb")
    return {"kind": "bay", "style": "queen-anne", "era": [1885, 1905], "widthM": 2.9, "depthM": 0.95, "capM": 1.8, "shape": "angled"}


def bay_edwardian() -> dict:
    fc.reset()
    S = slot_mats()
    root = kit_root("bay_edwardian", "bay", style="edwardian", era=[1900, 1925], widthM=2.6, depthM=0.75)
    plan = [(-1.3, -0.05), (-1.3, 0.75), (1.3, 0.75), (1.3, -0.05)]
    st = fc.MeshBuilder()
    faceted_bay(st, plan, S, head="flat", sash=0.78)
    part(st, "storey", root, storeyM=STOREY)
    cp = fc.MeshBuilder()
    cap_cornice(cp, plan, S, depth_out=0.22, h=0.45)
    flat_top(cp, plan, 0.45, S[3], grow=0.22)
    part(cp, "cap", root)
    export("bay-edwardian.glb")
    return {"kind": "bay", "style": "edwardian", "era": [1900, 1925], "widthM": 2.6, "depthM": 0.75, "capM": 0.45, "shape": "square"}


def bay_turret() -> dict:
    """A corner turret: an octagon of 2.8 m, its back three faces inside the corner."""
    fc.reset()
    S = slot_mats()
    root = kit_root("bay_turret", "bay", style="turret", era=[1885, 1905], widthM=2.8, depthM=1.4, corner=True)
    R = 1.4 / math.cos(math.pi / 8)
    ring = [(R * math.cos(math.pi / 8 + k * math.pi / 4), R * math.sin(math.pi / 8 + k * math.pi / 4)) for k in range(8)]
    # centred on the building's corner: the front wall runs off to -X, the side wall back (-Y
    # in Blender, +Z in glTF); six faces show, the two over the house's own corner do not
    mid = lambda a, b: ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)  # noqa: E731 (on the wall planes)
    plan = [mid(ring[5], ring[6]), ring[6], ring[7], ring[0], ring[1], ring[2], ring[3], mid(ring[3], ring[4])]
    st = fc.MeshBuilder()
    faceted_bay(st, plan, S, head="flat", sash=0.55, centre=(0.0, 0.0), blank=(0, len(plan) - 2))
    part(st, "storey", root, storeyM=STOREY)
    cp = fc.MeshBuilder()
    cap_cornice(cp, plan, S, depth_out=0.25, h=0.45, centre=(0.0, 0.0))
    cp.push(Matrix.Translation((0.0, 0.0, 0.45)))
    cp.lathe([(R + 0.25, 0.0), (R * 0.55, 1.2), (0.06, 3.0), (0.0, 3.05)], 8, S[3], smooth=False, phase=math.pi / 8)
    cp.cylinder(0.035, 3.0, 3.6, 6, S[3], smooth=False)
    cp.pop()
    part(cp, "cap", root)
    export("bay-turret.glb")
    return {"kind": "bay", "style": "turret", "era": [1885, 1905], "widthM": 2.8, "depthM": 1.4, "capM": 4.05, "shape": "octagon", "corner": True}


# ---------------------------------------------------------------------------------- stoop

STOOP = {"riseM": 0.18, "goingM": 0.28, "landingM": 1.2, "minRisers": 2, "maxRisers": 16, "cheekM": 0.25, "cheekTopM": 0.9,
         "doorWidthM": 1.1, "doorHeightM": 2.45, "railM": 0.9}


def unit_block(mb, mat_top, mat_side, front_mat=None):
    """x -0.5..0.5, y (out of the wall, Blender) 0..1 -> glTF z -1..0, z (up) -1..0."""
    mb.box(-0.5, 0.0, -1.0, 0.5, 1.0, 0.0, mat_side, skip=("+z", "-z"))
    mb.poly_n([(-0.5, 0.0, 0.0), (0.5, 0.0, 0.0), (0.5, 1.0, 0.0), (-0.5, 1.0, 0.0)], mat_top, (0, 0, 1))


def stoop() -> dict:
    fc.reset()
    S = slot_mats()
    root = kit_root("stoop", "stoop", **{k: v for k, v in STOOP.items()})
    st = fc.MeshBuilder()
    unit_block(st, S[4], S[4])
    part(st, "step", root, unit=True)
    la = fc.MeshBuilder()
    unit_block(la, S[4], S[4])
    part(la, "landing", root, unit=True)
    ch = fc.MeshBuilder()
    # cheek wall: a unit block with a cap moulding; the layout shears its top along the stair
    ch.box(-0.5, 0.0, -1.0, 0.5, 1.0, 0.0, S[0], skip=("-z",))
    part(ch, "cheek", root, unit=True)
    rl = fc.MeshBuilder()
    # a unit run of railing: handrail at the top, two balusters; sheared along the stair
    rl.box(-0.03, 0.0, -0.05, 0.03, 1.0, 0.0, S[3])
    for t in (0.25, 0.75):
        rl.box(-0.015, t - 0.015, -1.0, 0.015, t + 0.015, -0.05, S[3], skip=("-z", "+z"))
    part(rl, "rail", root, unit=True)
    dr = fc.MeshBuilder()
    w, h = STOOP["doorWidthM"], STOOP["doorHeightM"]
    # door leaf set back 0.12 in the wall, panelled; surround and transom
    dr.poly_n([(-w / 2, -0.12, 0.0), (w / 2, -0.12, 0.0), (w / 2, -0.12, h), (-w / 2, -0.12, h)], S[5], (0, 1, 0))
    for (x0, x1, z0, z1) in ((-w / 2 + 0.12, -0.04, 0.25, 1.05), (0.04, w / 2 - 0.12, 0.25, 1.05), (-w / 2 + 0.12, -0.04, 1.25, 2.05), (0.04, w / 2 - 0.12, 1.25, 2.05)):
        dr.poly_n([(x0, -0.11, z0), (x1, -0.11, z0), (x1, -0.11, z1), (x0, -0.11, z1)], S[1], (0, 1, 0))
    for (p, q) in (((-w / 2, 0.0), (-w / 2, -0.12)), ((w / 2, -0.12), (w / 2, 0.0))):
        inward = (1, 0, 0) if p[0] < 0 else (-1, 0, 0)  # the reveal faces into the doorway
        dr.poly_n([(p[0], p[1], 0.0), (q[0], q[1], 0.0), (q[0], q[1], h + 0.55), (p[0], p[1], h + 0.55)], S[1], inward)
    dr.poly_n([(-w / 2, -0.12, h + 0.05), (w / 2, -0.12, h + 0.05), (w / 2, -0.12, h + 0.5), (-w / 2, -0.12, h + 0.5)], S[2], (0, 1, 0))
    dr.box(-w / 2 - 0.18, 0.0, 0.0, -w / 2, 0.06, h + 0.62, S[1])
    dr.box(w / 2, 0.0, 0.0, w / 2 + 0.18, 0.06, h + 0.62, S[1])
    dr.box(-w / 2 - 0.25, 0.0, h + 0.55, w / 2 + 0.25, 0.14, h + 0.72, S[1])
    part(dr, "door", root, widthM=w, heightM=h)
    export("stoop.glb")
    return {"kind": "stoop", **STOOP}


# ------------------------------------------------------------------------------ roof kit

def roof_water_tank() -> dict:
    fc.reset()
    S = slot_mats()
    root = kit_root("roof_water_tank", "roof", footprintM=[3.4, 3.4], heightM=7.2)
    mb = fc.MeshBuilder()
    for (x, y) in ((-1.3, -1.3), (1.3, -1.3), (1.3, 1.3), (-1.3, 1.3)):
        mb.box(x - 0.1, y - 0.1, 0.0, x + 0.1, y + 0.1, 2.6, S[3], skip=("-z",))
    mb.box(-1.5, -1.5, 2.6, 1.5, 1.5, 2.8, S[3])
    mb.cylinder(1.55, 2.8, 6.0, 12, S[0], smooth=True, caps=False)
    for z in (3.3, 4.4, 5.5):
        mb.cylinder(1.58, z, z + 0.08, 12, S[3], smooth=True, caps=False)
    mb.lathe([(1.65, 6.0), (1.65, 6.08), (0.1, 7.1), (0.0, 7.2)], 12, S[3], smooth=False)
    part(mb, "tank", root)
    export("roof-water-tank.glb")
    return {"kind": "roof", "footprintM": [3.4, 3.4], "heightM": 7.2, "uses": ["commercial", "multi-family over 4 storeys", "pre-1950"]}


def roof_mech_box() -> dict:
    fc.reset()
    S = slot_mats()
    root = kit_root("roof_mech_box", "roof", footprintM=[2.4, 1.4], heightM=1.45, scalable=True)
    mb = fc.MeshBuilder()
    mb.box(-1.2, -0.7, 0.0, 1.2, 0.7, 0.15, S[3], skip=("-z",))
    mb.box(-1.15, -0.65, 0.15, 1.15, 0.65, 1.3, S[4], skip=("-z",))
    # louvres on the long faces, a fan grille on top
    for side in (-1, 1):
        y = side * 0.655
        for k in range(5):
            z = 0.35 + k * 0.17
            mb.poly_n([(-1.0, y, z), (1.0, y, z), (1.0, y + side * 0.03, z + 0.08), (-1.0, y + side * 0.03, z + 0.08)], S[5], (0, side, 0.5))
    mb.push(Matrix.Translation((0.55, 0.0, 0.0)))
    mb.cylinder(0.45, 1.3, 1.45, 10, S[3], smooth=False)
    mb.pop()
    part(mb, "unit", root)
    export("roof-mech-box.glb")
    return {"kind": "roof", "footprintM": [2.4, 1.4], "heightM": 1.45, "scalable": True, "uses": ["commercial", "multi-family"]}


def roof_penthouse() -> dict:
    fc.reset()
    S = slot_mats()
    root = kit_root("roof_penthouse", "roof", footprintM=[4.0, 4.0], heightM=3.4, scalable=True)
    mb = fc.MeshBuilder()
    mb.box(-2.0, -2.0, 0.0, 2.0, 2.0, 3.2, S[0], skip=("-z",))
    mb.box(-2.1, -2.1, 3.2, 2.1, 2.1, 3.4, S[1])
    mb.poly_n([(-0.5, 2.02, 0.0), (0.5, 2.02, 0.0), (0.5, 2.02, 2.2), (-0.5, 2.02, 2.2)], S[5], (0, 1, 0))
    part(mb, "unit", root)
    export("roof-penthouse.glb")
    return {"kind": "roof", "footprintM": [4.0, 4.0], "heightM": 3.4, "scalable": True, "uses": ["any flat roof over 3 storeys"]}


# --------------------------------------------------------------------------- roofline kit

# Profiles in the wall's vertical section: (out of the wall, up from the roof line), metres.
PROFILES = {
    "cornice-italianate": [(0.0, -0.95), (0.06, -0.95), (0.06, -0.8), (0.12, -0.78), (0.12, -0.45), (0.2, -0.42), (0.55, -0.2), (0.62, -0.18), (0.62, -0.06), (0.66, -0.05), (0.66, 0.0), (0.0, 0.0)],
    "cornice-edwardian": [(0.0, -0.6), (0.05, -0.6), (0.05, -0.45), (0.15, -0.42), (0.38, -0.12), (0.42, -0.1), (0.42, 0.0), (0.0, 0.0)],
    "parapet-coping": [(0.0, -0.3), (0.03, -0.3), (0.03, -0.12), (0.08, -0.12), (0.08, 0.0), (0.0, 0.0)],
}


def profile_segment(mb, prof, mat_face, mat_under):
    """Extrude a profile 1 m along +X (Blender), out of the wall = -Y in glTF = +Y Blender."""
    n = len(prof)
    for i in range(n - 1):
        (o0, u0), (o1, u1) = prof[i], prof[i + 1]
        if o0 == 0.0 and o1 == 0.0:
            continue
        # the outward normal of this profile edge in (out, up)
        no, nu = (u1 - u0), -(o1 - o0)
        mat = mat_under if nu < -1e-6 else mat_face
        mb.poly_n([(0.0, o0, u0), (1.0, o0, u0), (1.0, o1, u1), (0.0, o1, u1)], mat, (0.0, no, nu))


def cornice(name: str, brackets: int, dentils: int) -> dict:
    fc.reset()
    S = slot_mats()
    prof = PROFILES[name]
    root = kit_root(name.replace("-", "_"), "roofline", lengthM=1.0)
    mb = fc.MeshBuilder()
    profile_segment(mb, prof, S[1], S[1])
    for k in range(brackets):
        x = (k + 0.5) / brackets
        mb.box(x - 0.06, 0.06, -0.9, x + 0.06, 0.5, -0.22, S[1], skip=("-y", "+z"))
    for k in range(dentils):
        x = (k + 0.5) / dentils
        mb.box(x - 0.05, 0.05, -0.45, x + 0.05, 0.12, -0.36, S[1], skip=("-y", "+z"))
    part(mb, "segment", root)
    # the profile's end, both ways, for the two ends of a run
    en = fc.MeshBuilder()
    en.poly_n([(0.0, o, u) for o, u in prof], S[1], (-1, 0, 0))
    en.poly_n([(0.0, o, u) for o, u in prof], S[1], (1, 0, 0))
    part(en, "end", root)
    export(f"{name}.glb")
    out = max(o for o, _ in prof)
    return {"kind": "roofline", "lengthM": 1.0, "projectionM": out, "dropM": -min(u for _, u in prof), "profile": [list(p) for p in prof]}


# --------------------------------------------------------------------------------- stairs

STAIRS = {"riseM": 0.165, "goingM": 0.3, "maxRisersPerFlight": 16, "landingM": 1.5, "minGrade": 0.12, "curbM": 0.3, "railM": 0.95,
          "texture": "house-kit/stair-treads.png", "textureRunM": 0.3}


def stair_flight() -> dict:
    fc.reset()
    S = slot_mats()
    root = kit_root("stair_flight", "stairs", **{k: v for k, v in STAIRS.items() if k != "texture"})
    st = fc.MeshBuilder()
    unit_block(st, S[4], S[4])
    # a dark nosing strip on the tread's front edge (unit space: the first 6% of the going)
    st.poly_n([(-0.5, 0.94, 0.002), (0.5, 0.94, 0.002), (0.5, 1.0, 0.002), (-0.5, 1.0, 0.002)], S[5], (0, 0, 1))
    part(st, "step", root, unit=True)
    la = fc.MeshBuilder()
    unit_block(la, S[4], S[4])
    part(la, "landing", root, unit=True)
    cb = fc.MeshBuilder()
    cb.box(-0.5, 0.0, -1.0, 0.5, 1.0, 0.0, S[4], skip=("-z",))
    part(cb, "curb", root, unit=True)
    hr = fc.MeshBuilder()
    hr.box(-0.025, 0.0, -0.06, 0.025, 1.0, 0.0, S[3])
    hr.box(-0.02, 0.48, -1.0, 0.02, 0.52, -0.06, S[3], skip=("-z", "+z"))
    part(hr, "handrail", root, unit=True)
    export("stair-flight.glb")
    return {"kind": "stairs", **STAIRS}


def stair_texture() -> dict:
    """256 x 256, tileable: one tread per tile in v (bottom = the tread's front edge), concrete
    speckle, a dark nosing line and the riser's shadow."""
    size = 256
    v = (np.arange(size, dtype=np.float32) + 0.5) / size
    u = (np.arange(size, dtype=np.float32) + 0.5) / size
    V, U = np.meshgrid(v, u, indexing="ij")
    base = 0.62 + 0.04 * np.sin(U * 37.0 + V * 11.0) * np.sin(U * 13.0 - V * 29.0)
    h = np.sin((U * 127.1 + V * 311.7) * 43758.5453)
    h = h - np.floor(h)
    base = base + 0.05 * (h - 0.5)
    shade = np.where(V < 0.06, 0.28, np.where(V < 0.14, 0.62 - (0.14 - V) * 2.0, 1.0))
    lum = np.clip(base * shade, 0.0, 1.0)
    rgba = np.stack([lum * 0.98, lum * 0.96, lum * 0.92, np.ones_like(lum)], axis=-1)
    path = os.path.join(OUT, "stair-treads.png")
    img = bpy.data.images.new("stair_treads", size, size, alpha=False)
    img.pixels.foreach_set(rgba.ravel().astype(np.float32))
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    print(f"[fc] wrote {os.path.relpath(path, fc.REPO)}")
    return {"file": "house-kit/stair-treads.png", "sizePx": size, "runM": STAIRS["textureRunM"], "layout": "one tread per tile, repeating along the run every runM metres; the bottom row of the image is the tread's front edge (the dark nosing), the image's top the back of the tread under the next riser"}


# ------------------------------------------------------------------------------- contract

def main() -> None:
    os.makedirs(OUT, exist_ok=True)
    protos = {}
    for fn, file in ((bay_italianate, "bay-italianate"), (bay_queen_anne, "bay-queen-anne"), (bay_edwardian, "bay-edwardian"), (bay_turret, "bay-turret"),
                     (stoop, "stoop"), (roof_water_tank, "roof-water-tank"), (roof_mech_box, "roof-mech-box"), (roof_penthouse, "roof-penthouse"),
                     (lambda: cornice("cornice-italianate", 2, 0), "cornice-italianate"), (lambda: cornice("cornice-edwardian", 0, 5), "cornice-edwardian"),
                     (lambda: cornice("parapet-coping", 0, 0), "parapet-coping"), (stair_flight, "stair-flight")):
        spec = fn()
        spec["file"] = f"house-kit/{file}.glb"
        spec["budget"] = BUDGETS[f"{file}.glb"]
        protos[file] = spec
    tex = stair_texture()
    doc = {
        "$comment": "Generated by assets/blender/models/house_kit.py (do not edit). The contract for the house-kit prototypes: frames, slots, the numbers runtime/house-kit.ts lays them out with. See assets/blender/README.md, House kit.",
        "version": 1,
        "storeyM": STOREY,
        "slots": [{"id": i, "name": n, "default": c} for i, (n, c) in enumerate(SLOTS)],
        "frames": {
            "bay": "origin on the wall plane at the floor line, centred; projects toward -Z; node storey = one 3.2 m storey (scale y by storeyM / 3.2), node cap on top of the last storey; bays start on the second floor",
            "stoop": "unit blocks x -0.5..0.5, y -1..0, z -1..0 (top at y 0, the wall side at z 0), placed by runtime/house-kit.ts stoopLayout; door: origin on the wall plane at the threshold",
            "roof": "origin on the roof at the prop's centre; front -Z",
            "roofline": "origin on the wall's outer face at the roof line (collider topY), 1 m along +X, projecting toward -Z; never above +0.1 m",
            "stairs": "unit blocks as the stoop's, placed by runtime/house-kit.ts stairLayout along a path profile",
        },
        "rules": {
            "bayEveryM": 7.5,
            "bayMinFrontM": 4.5,
            "bayMaxYear": 1925,
            "stoopMinRiseM": 1.0,
            "rooflineMaxAboveM": 0.1,
        },
        "prototypes": protos,
        "stairTexture": tex,
    }
    path = os.path.join(OUT, "house-kit.json")
    fc.write_json(path, doc)
    print(f"[fc] wrote {os.path.relpath(path, fc.REPO)}")


if __name__ == "__main__":
    main()
