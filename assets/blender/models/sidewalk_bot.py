"""The Trundle (sidewalk delivery robot) -> public/models/sidewalk-bot.glb

A knee-high, four-wheeled delivery bot shaped like a bread bin: a cream ceramic body whose
front top is a quarter-round, closed by a sage-green roll-top (tambour) lid that rolls back
into the body to open, a graphite bumper band, one soft light strip along the front lip
under the lid (light_face, the same face-light name as the Porter's) and a camera slot in
the bumper. No flag, no whip antenna, not a cooler, and no pair of "eye" lights: the nearest
real sidewalk robots wear two round front lights as eyes, so the Trundle does not.

Nodes: sidewalk_bot (root, ground)
  body
  lid        roll-top; origin on the roll axis. Rotating it about local +X by extras
             lidOpenRad (+1.57) rolls it back into the body and opens the front.
  cargo      what it is delivering (two foil-wrapped burritos and a paper bag), inside the
             bin, origin on the bin floor; hide it for an empty bin (extras cargo: true)
  wheel_L1, wheel_L2, wheel_R1, wheel_R2   (1 = front; origin at the hub, spin about local X,
             extras radius)

Melt hooks: shape keys seize -> slump -> melt on every part and a per-vertex _RUST_MASK, as
on the Porter (assets/blender/README.md, "Melting and rust").
Front faces glTF -Z. Budget: 3k triangles.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

from mathutils import Matrix  # noqa: E402

import fc  # noqa: E402
import melt  # noqa: E402
import vehicle as V  # noqa: E402

BUDGET = 3_000
L, W = 0.72, 0.52
Z0, ZTOP = 0.1, 0.56
Y_REAR = -L / 2
R = 0.3  # the front quarter-round
Y_A = L / 2 - R  # where the round starts (its centre's y)
Z_C = ZTOP - R  # the round's centre height (the roll axis)
WR = 0.085
INSET = 0.016
LID_R = R - 0.03  # the lid runs inside the profile, under the top panel when open
ARC_SEG = 10


def profile(inset=0.0, arc=True):
    """Side profile (y, z), counter-clockwise seen from +X, from the rear bottom corner."""
    pts = [(Y_REAR + inset, Z0 + inset), (Y_REAR + inset, ZTOP - inset), (Y_A, ZTOP - inset)]
    if arc:
        for k in range(1, ARC_SEG + 1):
            a = math.pi / 2 - (math.pi / 2) * k / ARC_SEG
            pts.append((Y_A + (R - inset) * math.cos(a), Z_C + (R - inset) * math.sin(a)))
    else:
        pts.append((Y_A + R - inset, Z_C))
    pts.append((Y_A + R - inset, Z0 + inset))
    return pts


def main() -> None:
    fc.reset()
    shell = fc.material("shell_cream", "#efe9df", 0.3, extras={"rustable": True})
    lid_m = fc.material("lid_sage", "#9cb59a", 0.38, extras={"rustable": True})
    band = fc.material("bumper_graphite", "#2b2f35", 0.55, 0.2, extras={"rustable": True})
    inside = fc.material("bin_interior", "#4a4f55", 0.8, double_sided=True, extras={"rustable": True})
    lens = fc.material("camera_lens", "#0b0d10", 0.08, 0.4)
    tire = fc.material("tire", "#161616", 0.85)
    hub = fc.material("hub", "#9aa0a6", 0.4, 0.6, extras={"rustable": True})
    face = fc.material("light_face", "#fff2d6", 0.3, emission="#ffe6b8", strength=1.0)
    foil = fc.material("cargo_foil", "#c9ccd1", 0.25, 0.9)
    paper = fc.material("cargo_paper", "#b98b58", 0.85)

    root = fc.empty("sidewalk_bot")
    root["fcActor"] = "sidewalk-bot"
    root["robot"] = "trundle"
    root["slumpKeys"] = ["seize", "slump", "melt"]
    hx = W / 2

    mb = fc.MeshBuilder()
    outer = profile()
    # side walls: the whole bread-bin profile on both sides
    # (subdivided so the slump and melt shape keys can bend them)
    for sx in (1, -1):
        mb.concentric([(sx * hx, y, z) for y, z in outer], 3, shell, (sx, 0, 0))
    # rear wall, bottom, the flat top panel and the front wall; the quarter-round is open (lid)
    mb.grid_quad((-hx, Y_REAR, Z0), (hx, Y_REAR, Z0), (hx, Y_REAR, ZTOP), (-hx, Y_REAR, ZTOP), 4, 4, shell, (0, -1, 0))
    mb.grid_quad((-hx, Y_REAR, Z0), (hx, Y_REAR, Z0), (hx, L / 2, Z0), (-hx, L / 2, Z0), 2, 3, band, (0, 0, -1))
    mb.grid_quad((-hx, Y_REAR, ZTOP), (hx, Y_REAR, ZTOP), (hx, Y_A, ZTOP), (-hx, Y_A, ZTOP), 4, 3, shell, (0, 0, 1))
    mb.grid_quad((-hx, L / 2, Z0), (hx, L / 2, Z0), (hx, L / 2, Z_C), (-hx, L / 2, Z_C), 4, 2, shell, (0, 1, 0))
    # the bin inside: inset walls, open where the lid rolls
    inner = profile(INSET)
    ihx = hx - INSET
    for sx in (1, -1):
        mb.poly_n([(sx * ihx, y, z) for y, z in inner], inside, (-sx, 0, 0))
    mb.poly_n([(-ihx, Y_REAR + INSET, Z0 + INSET), (ihx, Y_REAR + INSET, Z0 + INSET), (ihx, Y_REAR + INSET, ZTOP - INSET), (-ihx, Y_REAR + INSET, ZTOP - INSET)], inside, (0, 1, 0))
    mb.poly_n([(-ihx, Y_REAR + INSET, Z0 + INSET), (ihx, Y_REAR + INSET, Z0 + INSET), (ihx, L / 2 - INSET, Z0 + INSET), (-ihx, L / 2 - INSET, Z0 + INSET)], inside, (0, 0, 1))
    mb.poly_n([(-ihx, Y_REAR + INSET, ZTOP - INSET), (ihx, Y_REAR + INSET, ZTOP - INSET), (ihx, Y_A, ZTOP - INSET), (-ihx, Y_A, ZTOP - INSET)], inside, (0, 0, -1))
    mb.poly_n([(-ihx, L / 2 - INSET, Z0 + INSET), (ihx, L / 2 - INSET, Z0 + INSET), (ihx, L / 2 - INSET, Z_C), (-ihx, L / 2 - INSET, Z_C)], inside, (0, -1, 0))
    # lips where the opening meets the walls
    mb.poly_n([(-hx, Y_A, ZTOP), (hx, Y_A, ZTOP), (ihx, Y_A, ZTOP - INSET), (-ihx, Y_A, ZTOP - INSET)], shell, (0, 1, 0.3))
    mb.poly_n([(-hx, L / 2, Z_C), (hx, L / 2, Z_C), (ihx, L / 2 - INSET, Z_C), (-ihx, L / 2 - INSET, Z_C)], shell, (0, 0.3, 1))
    # graphite bumper band and fender skirts round the base
    mb.box(-hx - 0.012, Y_REAR - 0.012, Z0 - 0.01, hx + 0.012, L / 2 + 0.012, Z0 + 0.06, band, skip=("-z",))
    for sx in (1, -1):
        for y in (0.24, -0.24):
            mb.push(Matrix.Translation((sx * (hx + 0.016), y, WR)) @ Matrix.Rotation(math.pi / 2, 4, "Y"))
            mb.lathe([(WR + 0.025, -0.035), (WR + 0.025, 0.035)], 10, band, smooth=False, arc=(math.pi * 0.62, math.pi * 1.38))
            mb.pop()
    # front: one soft light strip along the lip under the lid (a bread bin's handle line),
    # half sunk into the front wall, and a camera slot in the bumper below
    mb.capsule((-0.19, L / 2 - 0.002, Z_C - 0.024), (0.19, L / 2 - 0.002, Z_C - 0.024), 0.009, 0.009, face, seg=8, rings=2)
    mb.box(-0.08, L / 2 + 0.012, 0.112, 0.08, L / 2 + 0.017, 0.127, lens)
    # a small charging contact plate on the rear
    mb.box(-0.06, Y_REAR - 0.006, 0.3, 0.06, Y_REAR, 0.36, band)
    mb.build("body", parent=root, sharp_angle=35)

    # ---- the roll-top lid: a slatted arc round the roll axis, set between the side walls
    # (recessed inside the profile, so rolled back it slides under the top panel), with a
    # graphite pull near its lip
    lb = fc.MeshBuilder()
    slats = 14
    lw = ihx - 0.004
    a0, a1 = math.radians(-3), math.radians(90)
    rings = []
    for k in range(slats * 2 + 1):
        a = a0 + (a1 - a0) * k / (slats * 2)
        r = LID_R + (0.004 if k % 2 == 0 else 0.009)
        rings.append((r * math.cos(a), r * math.sin(a)))
    for (y0, z0), (y1, z1) in zip(rings, rings[1:]):
        lb.grid_quad((-lw, y0, z0), (lw, y0, z0), (lw, y1, z1), (-lw, y1, z1), 4, 1, lid_m, (0, (y0 + y1) / 2, (z0 + z1) / 2))
    # the lid continues a little under the top panel so no gap shows at rest
    yb, zb = (LID_R + 0.004) * math.cos(a1 + 0.12), (LID_R + 0.004) * math.sin(a1 + 0.12)
    lb.poly_n([(-lw, rings[-1][0], rings[-1][1]), (lw, rings[-1][0], rings[-1][1]), (lw, yb, zb), (-lw, yb, zb)], lid_m, (0, 0, 1))
    # side edges of the lid
    for sx in (1, -1):
        for (y0, z0), (y1, z1) in zip(rings, rings[1:]):
            q = [(sx * lw, y0, z0), (sx * lw, y1, z1), (sx * lw, y1 * 0.96, z1 * 0.96), (sx * lw, y0 * 0.96, z0 * 0.96)]
            lb.poly_n(q, lid_m, (sx, 0, 0))
    pa = math.radians(14)
    lb.push(Matrix.Translation((0, (LID_R + 0.012) * math.cos(pa), (LID_R + 0.012) * math.sin(pa))))
    lb.box(-0.07, -0.008, -0.01, 0.07, 0.012, 0.01, band)
    lb.pop()
    lid = lb.build("lid", parent=root, location=(0, Y_A, Z_C))
    lid["lidAxis"] = [1, 0, 0]
    lid["lidOpenRad"] = 1.57

    # ---- cargo: two foil burritos and a paper bag in the bin
    cb = fc.MeshBuilder()
    cb.capsule((-0.12, -0.06, 0.05), (-0.12, 0.16, 0.06), 0.045, 0.045, foil, seg=8, rings=2)
    cb.capsule((-0.02, -0.1, 0.05), (0.0, 0.12, 0.055), 0.045, 0.045, foil, seg=8, rings=2)
    cb.box(0.05, -0.2, 0.0, 0.2, -0.02, 0.24, paper)
    cargo = cb.build("cargo", parent=root, location=(0, 0, Z0 + INSET))
    cargo["cargo"] = True

    for side, sx in (("L", -1), ("R", 1)):
        for k, y in ((1, 0.24), (2, -0.24)):
            V.wheel(f"wheel_{side}{k}", WR, 0.05, tire, hub, hub=band, seg=12, spokes=4, side=sx,
                    parent=root, location=(sx * (hx + 0.016), y, WR))

    fc.add_deform_keys(melt.keys(height=0.62, neck_z=None, heap_r=0.42, heap_h=0.28))
    seams = [(sx * hx, y, z) for sx in (1, -1) for y in (Y_REAR, L / 2) for z in (Z0, ZTOP)]
    seams += [(sx * (hx + 0.016), y, WR) for sx in (1, -1) for y in (0.24, -0.24)]
    seams += [(sx * hx, Y_A + R * math.cos(math.radians(a)), Z_C + R * math.sin(math.radians(a))) for sx in (1, -1, 0) for a in (6, 50, 90)]
    fc.add_rust_mask(seams, reach=0.22, first=("bumper_graphite",), never=("light_", "cargo_"))
    fc.export_glb("sidewalk-bot.glb", BUDGET, morph=True, attributes=True)


main()
