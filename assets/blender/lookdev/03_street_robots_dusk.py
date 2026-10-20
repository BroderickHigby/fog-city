"""Look-dev 03: a street at dusk with the robotaxi, two errand robots carrying groceries, a
sidewalk bot and three unnamed storefronts (a bar with a beer-shaped neon, a cafe with a
blank A-frame, a barber pole) -> assets/blender/lookdev/03-street-robots-dusk.png

Storefronts carry no names or words: iconography only, sign slots left blank. The set is
built here for the render; the robots and the robotaxi are the exported GLBs, posed through
their joint nodes (which proves the pivots work).
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import fc  # noqa: E402
import lookdev as L  # noqa: E402

FACADE_Y = 9.5
CURB_Y = 5.0


def mat(name, color, rough=0.7, metal=0.0, emission=None, strength=1.0):
    return L.flat_material(name, color, rough, metal, emission, strength)


def pole_material():
    """Barber-pole spiral from the UVs: u around, v up."""
    m = bpy.data.materials.new("barber_stripes")
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    uv = nt.nodes.new("ShaderNodeUVMap")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    mul.inputs[1].default_value = 2.2
    add = nt.nodes.new("ShaderNodeMath")
    add.operation = "ADD"
    fr = nt.nodes.new("ShaderNodeMath")
    fr.operation = "FRACT"
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "CONSTANT"
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, (*fc.hex_rgb("#c8102e"), 1)
    els[1].position, els[1].color = 0.25, (*fc.hex_rgb("#f4f4f4"), 1)
    e = els.new(0.5)
    e.color = (*fc.hex_rgb("#1d3f9a"), 1)
    e = els.new(0.75)
    e.color = (*fc.hex_rgb("#f4f4f4"), 1)
    nt.links.new(uv.outputs["UV"], sep.inputs[0])
    nt.links.new(sep.outputs["Y"], mul.inputs[0])
    nt.links.new(sep.outputs["X"], add.inputs[0])
    nt.links.new(mul.outputs[0], add.inputs[1])
    nt.links.new(add.outputs[0], fr.inputs[0])
    nt.links.new(fr.outputs[0], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Emission Color"])
    b.inputs["Emission Strength"].default_value = 0.6
    b.inputs["Roughness"].default_value = 0.25
    return m


def uv_cylinder(mb, c, r, z0, z1, seg, m, turns=1.0):
    for j in range(seg):
        a0, a1 = 2 * math.pi * j / seg, 2 * math.pi * (j + 1) / seg
        p = [(c[0] + r * math.cos(a0), c[1] + r * math.sin(a0), z0), (c[0] + r * math.cos(a1), c[1] + r * math.sin(a1), z0),
             (c[0] + r * math.cos(a1), c[1] + r * math.sin(a1), z1), (c[0] + r * math.cos(a0), c[1] + r * math.sin(a0), z1)]
        u0, u1 = j / seg * turns, (j + 1) / seg * turns
        mb.poly(p, m, smooth=True, uv=[(u0, 0.0), (u1, 0.0), (u1, 1.0), (u0, 1.0)])


def storefront(mb, x0, x1, wall, awning_m, interior, frame_m, sign_m, door_side=1):
    """Ground-floor shop in a facade at FACADE_Y (facing -Y): display window, door, awning,
    blank sign slot. Returns the display window's centre."""
    y = FACADE_Y
    w = x1 - x0
    dx0, dx1 = (x1 - 1.5, x1 - 0.4) if door_side > 0 else (x0 + 0.4, x0 + 1.5)
    wx0, wx1 = (x0 + 0.5, dx0 - 0.3) if door_side > 0 else (dx1 + 0.3, x1 - 0.5)
    # wall pieces around the window and door
    mb.poly_n([(x0, y, 0), (x1, y, 0), (x1, y, 0.6), (x0, y, 0.6)], wall, (0, -1, 0))
    mb.poly_n([(x0, y, 3.1), (x1, y, 3.1), (x1, y, 4.2), (x0, y, 4.2)], wall, (0, -1, 0))
    for a, b in ((x0, wx0), (wx1, dx0) if door_side > 0 else (dx1, wx0), (dx1, x1) if door_side > 0 else (wx1, x1)):
        if b > a:
            mb.poly_n([(a, y, 0.6), (b, y, 0.6), (b, y, 3.1), (a, y, 3.1)], wall, (0, -1, 0))
    # recessed lit interior behind the window and the glazed door
    depth = 2.2
    mb.box(wx0, y, 0.6, wx1, y + depth, 3.1, interior, skip=("-y",))
    mb.box(dx0, y, 0.0, dx1, y + depth, 2.6, interior, skip=("-y",))
    mb.poly_n([(dx0, y, 2.6), (dx1, y, 2.6), (dx1, y, 3.1), (dx0, y, 3.1)], wall, (0, -1, 0))
    # frames and mullions
    for xa, xb, za, zb in ((wx0 - 0.08, wx1 + 0.08, 0.52, 0.6), (wx0 - 0.08, wx1 + 0.08, 3.1, 3.18), (dx0 - 0.08, dx1 + 0.08, 2.6, 2.68)):
        mb.box(xa, y - 0.08, za, xb, y, zb, frame_m)
    for xx in (wx0, wx1, (wx0 + wx1) / 2, dx0, dx1):
        mb.box(xx - 0.04, y - 0.06, 0.0 if xx in (dx0, dx1) else 0.6, xx + 0.04, y, 3.1 if xx not in (dx0, dx1) else 2.6, frame_m)
    # awning: sloped fabric with a valance
    mb.poly_n([(x0 + 0.2, y, 3.55), (x1 - 0.2, y, 3.55), (x1 - 0.2, y - 1.3, 3.05), (x0 + 0.2, y - 1.3, 3.05)], awning_m, (0, -0.4, 1))
    mb.box(x0 + 0.2, y - 1.34, 2.82, x1 - 0.2, y - 1.28, 3.07, awning_m)
    for xx in (x0 + 0.2, x1 - 0.2):
        mb.poly_n([(xx, y, 3.55), (xx, y - 1.3, 3.05), (xx, y - 1.3, 2.82), (xx, y, 3.3)], awning_m, (1 if xx > x0 + 1 else -1, 0, 0))
    # blank sign slot reserved above the awning
    mb.box(x0 + 0.6, y - 0.12, 3.68, x1 - 0.6, y, 4.12, sign_m)
    return Vector(((wx0 + wx1) / 2, y, 1.85))


def building(mb, x0, x1, h, wall, trim, win, lit_win, seed):
    """Upper storeys: a facade with a window grid, a cornice; some windows lit."""
    y = FACADE_Y
    mb.poly_n([(x0, y, 4.2), (x1, y, 4.2), (x1, y, h), (x0, y, h)], wall, (0, -1, 0))
    n = max(2, int((x1 - x0) / 2.0))
    for k in range(n):
        cx = x0 + (x1 - x0) * (k + 0.5) / n
        for zb in (4.8, 7.6) if h > 8 else (4.8,):
            m = lit_win if (k * 7 + seed * 3 + int(zb)) % 5 == 0 else win
            mb.box(cx - 0.5, y - 0.04, zb, cx + 0.5, y, zb + 1.7, m)
            mb.box(cx - 0.62, y - 0.1, zb - 0.12, cx + 0.62, y, zb, trim)
            mb.box(cx - 0.62, y - 0.1, zb + 1.7, cx + 0.62, y, zb + 1.85, trim)
    mb.box(x0, y - 0.45, h - 0.2, x1, y, h + 0.25, trim)
    mb.box(x0, y, 0, x1, y + 12, h, wall, skip=("-y", "-z"))
    mb.box(x0, y - 0.06, 4.15, x1, y, 4.3, trim)


def neon_mug(mb, c, m_glass, m_foam, scale=1.0):
    """A beer mug drawn in neon tube: glass outline, handle, foam crown, bubbles."""
    r = 0.022 * scale
    s = scale
    x, y, z = c

    def P(px, pz):
        return (x + px * s, y, z + pz * s)

    body = [P(-0.32, 0.45), P(-0.30, -0.42), P(-0.24, -0.5), P(0.24, -0.5), P(0.30, -0.42), P(0.32, 0.45)]
    for a, b in zip(body, body[1:]):
        mb.cyl_between(a, b, r, 6, m_glass, caps=False)
    hp = [P(0.32 + 0.22 * math.sin(math.pi * k / 8), 0.25 - 0.5 * k / 8 - 0.03 * math.sin(math.pi * k / 8)) for k in range(9)]
    for a, b in zip(hp, hp[1:]):
        mb.cyl_between(a, b, r, 6, m_glass, caps=False)
    foam = []
    for k in range(25):
        t = k / 24
        px = -0.36 + 0.72 * t
        pz = 0.5 + 0.09 * abs(math.sin(t * math.pi * 3)) + 0.03
        foam.append(P(px, pz))
    for a, b in zip(foam, foam[1:]):
        mb.cyl_between(a, b, r, 6, m_foam, caps=False)
    for (bx, bz, br) in ((-0.1, -0.2, 0.05), (0.08, 0.0, 0.04), (-0.05, 0.22, 0.035), (0.12, -0.32, 0.03)):
        ring = [P(bx + br * math.cos(2 * math.pi * k / 10), bz + br * math.sin(2 * math.pi * k / 10)) for k in range(11)]
        for a, b in zip(ring, ring[1:]):
            mb.cyl_between(a, b, r * 0.7, 5, m_foam, caps=False)


def a_frame(mb, c, wood, board):
    x, y, _ = c
    for s in (1, -1):
        # two boards leaning together, blank chalkboard faces
        mb.poly_n([(x - 0.32, y + s * 0.34, 0.0), (x + 0.32, y + s * 0.34, 0.0), (x + 0.32, y + 0.02 * s, 1.0), (x - 0.32, y + 0.02 * s, 1.0)],
                  board, (0, s, 0.4))
        mb.poly_n([(x - 0.32, y + s * 0.34, 0.0), (x + 0.32, y + s * 0.34, 0.0), (x + 0.32, y + 0.02 * s, 1.0), (x - 0.32, y + 0.02 * s, 1.0)],
                  board, (0, -s, -0.4))
        for xx in (x - 0.35, x + 0.35):
            mb.cyl_between((xx, y + s * 0.36, 0.0), (xx, y + 0.02 * s, 1.03), 0.025, 6, wood, caps=True)
        mb.cyl_between((x - 0.35, y + s * 0.36 * 0.12, 0.92), (x + 0.35, y + s * 0.36 * 0.12, 0.92), 0.025, 6, wood)


def pose_walk(objs, phase):
    """Swing legs and arms about their joints' local X (forward is +Y in Blender)."""
    a = math.radians(24) * math.sin(phase)
    rot = {"leg_upper_L": a, "leg_upper_R": -a, "arm_upper_L": -a * 0.7, "arm_upper_R": a * 0.25,
           "leg_lower_L": -abs(a) * 0.6 if a < 0 else -0.05, "leg_lower_R": -abs(a) * 0.6 if a > 0 else -0.05,
           "arm_lower_L": math.radians(-12), "arm_lower_R": math.radians(-4)}
    for o in objs.values():
        base = o.name.split(".")[0]
        if base in rot:
            o.rotation_mode = "XYZ"
            o.rotation_euler.x += rot[base]


def main() -> None:
    fc.reset()
    L.setup(samples=int(os.environ.get("LOOKDEV_SAMPLES", "64")), exposure=0.2)

    asphalt = L.noisy_material("asphalt", "#262729", "#333436", scale=2.0, rough=0.88, bump=0.05)
    sidewalk = L.noisy_material("sidewalk", "#8d8983", "#a29e97", scale=1.2, rough=0.8, bump=0.02)
    curb = mat("curb", "#b5b0a8", 0.8)
    paint_w = mat("road_white", "#d9d6cf", 0.6)
    paint_y = mat("road_yellow", "#d7a92c", 0.6)
    trim = mat("trim_white", "#efebe2", 0.6)
    win = mat("window_dark", "#1f262d", 0.15, 0.2)
    lit_win = mat("light_window_warm", "#3a2f22", 0.4, emission="#ffcf8a", strength=2.2)
    walls = [mat("wall_teal", "#3e5f66", 0.85), mat("wall_cream", "#e4d6b4", 0.85), mat("wall_rose", "#c48c87", 0.85),
             mat("wall_sage", "#8ea08a", 0.85), mat("wall_slate", "#6d7480", 0.85)]
    awnings = [mat("awning_oxblood", "#6e1f24", 0.9), mat("awning_green", "#28503b", 0.9), mat("awning_navy", "#1f2e52", 0.9)]
    frame_m = mat("shop_frame", "#1b1d20", 0.4, 0.5)
    sign_m = mat("sign_blank", "#22252a", 0.5)
    interiors = [mat("light_interior_bar", "#2a1a12", 0.8, emission="#a0522a", strength=0.18),
                 mat("light_interior_cafe", "#3b2a1a", 0.8, emission="#ffd9a0", strength=1.3),
                 mat("light_interior_barber", "#30343a", 0.8, emission="#e9f0ff", strength=0.9)]
    neon_glass = mat("light_neon_amber", "#ffb21f", 0.3, emission="#ffaa1a", strength=28.0)
    neon_foam = mat("light_neon_white", "#ffffff", 0.3, emission="#fff6e8", strength=24.0)
    wood = mat("wood", "#6b4a2f", 0.7)
    board = mat("chalkboard_blank", "#1d2320", 0.9)
    chrome = mat("chrome", "#d8dde2", 0.15, 1.0)
    iron = mat("lamp_iron", "#26292d", 0.5, 0.6)
    lamp_glass = mat("light_streetlamp", "#fff3dd", 0.3, emission="#ffd8a8", strength=18.0)

    mb = fc.MeshBuilder()
    # road, curbs, sidewalks, markings
    mb.poly([(-60, -CURB_Y, 0), (60, -CURB_Y, 0), (60, CURB_Y, 0), (-60, CURB_Y, 0)], asphalt)
    for s in (1, -1):
        y0, y1 = s * CURB_Y, s * (FACADE_Y + 0.0)
        mb.box(-60, min(y0, y1), 0.0, 60, max(y0, y1), 0.15, sidewalk, skip=("-z",))
        mb.box(-60, s * CURB_Y - 0.15, 0.0, 60, s * CURB_Y + 0.15, 0.16, curb, skip=("-z",))
    for yy in (-0.08, 0.08):
        mb.box(-60, yy - 0.05, 0.0, 60, yy + 0.05, 0.005, paint_y)
    for s in (1, -1):  # lane edge lines
        mb.box(-60, s * 4.55 - 0.05, 0.0, 60, s * 4.55 + 0.05, 0.005, paint_w)
    # crosswalk at the left of frame
    for k in range(10):
        y0 = -4.6 + k * 0.95
        mb.box(-11.5, y0, 0.0, -8.5, y0 + 0.5, 0.006, paint_w)

    # three unnamed storefronts: bar, cafe, barber
    xs = [(-9.0, -3.0), (-3.0, 3.0), (3.0, 9.0)]
    centres = []
    for i, (x0, x1) in enumerate(xs):
        centres.append(storefront(mb, x0, x1, walls[i], awnings[i], interiors[i], frame_m, sign_m, door_side=1 if i != 1 else -1))
        building(mb, x0, x1, (8.4, 6.9, 8.0)[i], walls[i], trim, win, lit_win, seed=i)
    for (x0, x1, wi) in ((-30, -9, 3), (9, 30, 4)):
        mb.poly_n([(x0, FACADE_Y, 0), (x1, FACADE_Y, 0), (x1, FACADE_Y, 4.2), (x0, FACADE_Y, 4.2)], walls[wi], (0, -1, 0))
        building(mb, x0, x1, 9.6, walls[wi], trim, win, lit_win, seed=wi)
    # bar: neon beer mug hanging in the window
    c = centres[0]
    neon_mug(mb, (c.x, FACADE_Y + 0.25, 1.95), neon_glass, neon_foam, scale=1.15)
    # cafe: blank A-frame on the sidewalk, a small table and two stools
    a_frame(mb, (centres[1].x + 0.4, 7.0, 0.15), wood, board)
    mb.push(Matrix.Translation((0, 0, 0.15)))
    mb.push(Matrix.Translation((centres[1].x - 2.0, 8.3, 0)))
    mb.cylinder(0.32, 0.72, 0.76, 14, wood)
    mb.cylinder(0.04, 0.0, 0.72, 8, iron)
    for sx in (-0.6, 0.6):
        mb.cylinder(0.17, 0.45, 0.48, 10, wood)
        mb.push(Matrix.Translation((sx, 0, 0)))
        mb.cylinder(0.17, 0.45, 0.48, 10, wood)
        mb.cylinder(0.03, 0.0, 0.45, 6, iron)
        mb.pop()
    mb.pop()
    mb.pop()
    # barber pole beside the barber's door
    pole_x = 9.0 - 0.15
    mb.push(Matrix.Translation((pole_x - 0.35, FACADE_Y - 0.28, 1.4)))
    mb.cylinder(0.13, 0.0, 0.08, 14, chrome)
    mb.cylinder(0.13, 1.0, 1.08, 14, chrome)
    mb.sphere((0, 0, 1.17), 0.1, 12, 6, chrome)
    mb.box(-0.05, 0.0, 0.45, 0.05, 0.3, 0.6, chrome)
    mb.pop()
    stripes = pole_material()
    pb = fc.MeshBuilder()
    uv_cylinder(pb, (pole_x - 0.35, FACADE_Y - 0.28), 0.11, 1.48, 2.4, 24, stripes, turns=1.0)
    pb.build("barber_pole_stripes")
    # street lamps on both sidewalks
    lamp_pts = [(-12.5, 5.6), (4.2, 5.6), (-4.0, -5.6), (16.0, -5.6)]
    for (lx, ly) in lamp_pts:
        s = 1 if ly > 0 else -1
        mb.cyl_between((lx, ly, 0.15), (lx, ly, 6.2), 0.08, 8, iron)
        mb.cyl_between((lx, ly, 6.2), (lx, ly - s * 1.4, 6.4), 0.05, 6, iron)
        mb.box(lx - 0.25, ly - s * 1.4 - 0.15, 6.25, lx + 0.25, ly - s * 1.4 + 0.15, 6.42, iron)
        mb.box(lx - 0.22, ly - s * 1.4 - 0.12, 6.22, lx + 0.22, ly - s * 1.4 + 0.12, 6.25, lamp_glass)
        L.point_light((lx, ly - s * 1.4, 6.1), 700.0, "#ffcf98", kind="SPOT", radius=0.3, spot=(2.2, 0.6),
                      rot=(0.0, 0.0, 0.0))
    mb.build("street_set", sharp_angle=40)

    # actors from the exported GLBs
    taxi, tobjs = L.import_glb("robotaxi.glb", x=4.7, y=2.35, heading_deg=263.0)
    r1, r1objs = L.import_glb("errand-robot.glb", x=-5.4, y=6.1, z=0.15, heading_deg=98.0)
    pose_walk(r1objs, 0.9)
    r2, r2objs = L.import_glb("errand-robot.glb", x=-0.4, y=6.6, z=0.15, heading_deg=250.0)
    pose_walk(r2objs, -1.6)
    bot, bobjs = L.import_glb("sidewalk-bot.glb", x=-2.6, y=7.3, z=0.15, heading_deg=272.0)
    for o in list(tobjs.values()):
        if o.name.startswith("sensor_dome"):
            o.rotation_euler.z += 0.7
    actors = list(tobjs.values()) + list(r1objs.values()) + list(r2objs.values()) + list(bobjs.values())
    L.emission(actors, 6.0, prefix="light_status")
    L.emission(actors, 8.0, prefix="light_headlight")
    L.emission(actors, 5.0, prefix="light_taillight")
    L.emission(actors, 5.0, prefix="light_face")
    L.emission(actors, 4.0, prefix="light_eyes")
    # headlight throw from the robotaxi
    for dy in (-0.55, 0.55):
        L.point_light((4.7 - 2.45, 2.35 + dy, 0.75), 900.0, "#eaf2ff", kind="SPOT", radius=0.1, spot=(0.9, 0.5),
                      rot=(Vector((-1.0, -0.14, -0.1))).to_track_quat("-Z", "Y").to_euler())

    _, to_sun = L.sun(280, 1.5, 0.6, "#ff9a5a", angle_deg=3.0)
    L.world_gradient([(0.0, "#141218"), (0.5, "#e58f58"), (0.535, "#c4708a"), (0.62, "#5c5b8f"), (1.0, "#1d2a52")],
                     strength=0.7, sun_dir=to_sun, sun_color=(1.0, 0.55, 0.3), sun_glow=1.5)
    L.compositor(mist=(18.0, 220.0, "#5a4c62", 0.3), glare=1.6)
    # soft dusk fill from the open sky over the street, so white shells read
    L.point_light((0.0, 2.0, 9.0), 2500.0, "#9fb0ff", kind="AREA", size=(30.0, 8.0))
    L.camera((0.3, -4.0, 2.75), (0.6, FACADE_Y, 1.9), lens=17.0)
    L.render("03-street-robots-dusk.png")


main()
