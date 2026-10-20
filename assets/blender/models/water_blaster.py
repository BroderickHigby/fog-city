"""The water blaster -> public/models/water-blaster.glb

A cartoon garden sprayer, plainly a water toy: a bright yellow backpack tank with a red pump
handle on top, orange straps, a green hose, and a blue spray wand with a thumb lever on top
and a big orange adjustable nozzle. Nothing about it is shaped like a firearm: no magazine,
no stock, no pistol grip, no trigger guard, and every part is a bright toy colour.

It is laid out as worn by the player (public/models/player.glb, origin on the ground between
the feet, facing -Z), and each attachable part's origin is its attach point:

  water_blaster (root)
    tank          origin where the tank sits on the back; attach to the player's `chest` bone
      pump_handle
      water_level the visible fill strip: origin at its bottom, scale local +Y by the tank's
                  fill fraction (0..1)
    hose          static loop from the tank to the wand (or draw your own between the extras
                  hoseStart on tank and hoseEnd on wand)
    wand          origin at the grip; attach to the player's `hand_R` bone
      nozzle      origin at the nozzle tip; the stream leaves along local -Z (glTF), which is
                  the wand's forward direction

Front faces glTF -Z. Budget: 2.5k triangles.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

from mathutils import Matrix, Vector  # noqa: E402

import fc  # noqa: E402

BUDGET = 2_500
TANK_AT = (0.0, -0.13, 1.22)  # Blender: on the player's back
GRIP_AT = (0.226, 0.02, 0.8)  # the right hand at rest


def main() -> None:
    fc.reset()
    yellow = fc.material("toy_yellow", "#ffcc1a", 0.38)
    red = fc.material("toy_red", "#ee3b2f", 0.4)
    orange = fc.material("toy_orange", "#ff8a1f", 0.45)
    green = fc.material("toy_green", "#3cc45a", 0.45)
    blue = fc.material("toy_blue", "#2f8cff", 0.35)
    water = fc.material("water_blue", "#3fb6ff", 0.15)
    slot = fc.material("slot_white", "#f5f5f0", 0.5)

    root = fc.empty("water_blaster")
    root["fcActor"] = "water-blaster"
    root["toy"] = True
    root["wornBy"] = "player.glb"

    # ---- tank: a rounded yellow canister, its front (toward the player's back) at the origin
    t = fc.MeshBuilder()
    t.push(Matrix.Translation((0, -0.085, 0)) @ Matrix.Diagonal((1.0, 0.62, 1.0, 1.0)))
    t.lathe([(0.0, -0.2), (0.1, -0.198), (0.13, -0.18), (0.14, -0.12), (0.14, 0.12), (0.125, 0.17), (0.08, 0.195), (0.0, 0.2)], 18, yellow, smooth=True)
    t.pop()
    # a white window slot on the outside face, where the water level shows
    t.box(-0.03, -0.172, -0.15, 0.03, -0.165, 0.13, slot)
    # straps: two orange loops over the shoulders, and a waist band
    for sx in (1, -1):
        pts = [(sx * 0.09, 0.0, 0.17), (sx * 0.1, 0.08, 0.26), (sx * 0.11, 0.2, 0.22), (sx * 0.12, 0.25, 0.05), (sx * 0.12, 0.22, -0.18), (sx * 0.1, 0.02, -0.18)]
        for p0, p1 in zip(pts, pts[1:]):
            t.cyl_between(p0, p1, 0.014, 6, orange, caps=False)
    tank = t.build("tank", parent=root, location=TANK_AT)
    tank["attachBone"] = "chest"
    tank["hoseStart"] = [0.1, -0.19, 0.08]  # glTF frame, the hose's socket at the tank's bottom
    tank["capacityL"] = 8

    # the pump: a red rod and a T handle on top
    p = fc.MeshBuilder()
    p.cylinder(0.012, 0.0, 0.12, 8, red)
    p.cyl_between((-0.08, 0.0, 0.12), (0.08, 0.0, 0.12), 0.02, 8, red)
    p.sphere((-0.08, 0.0, 0.12), 0.022, 8, 4, red)
    p.sphere((0.08, 0.0, 0.12), 0.022, 8, 4, red)
    p.build("pump_handle", parent=tank, location=(0.0, -0.085, 0.19))

    lv = fc.MeshBuilder()
    lv.box(-0.022, -0.004, 0.0, 0.022, 0.0, 0.27, water)
    level = lv.build("water_level", parent=tank, location=(0.0, -0.172, -0.145))
    level["levelAxis"] = [0, 1, 0]

    # ---- wand: grip at the origin, a short handle with a thumb lever on top, a long blue
    # tube forward and a wide orange bell nozzle
    w = fc.MeshBuilder()
    w.capsule((0, -0.06, 0), (0, 0.07, 0), 0.026, 0.026, blue, seg=10, rings=2)
    w.box(-0.012, -0.03, 0.022, 0.012, 0.05, 0.034, orange)  # thumb lever, on top
    w.cyl_between((0, 0.07, 0), (0, 0.5, 0.025), 0.012, 8, blue)
    w.push(Matrix.Translation((0, 0.5, 0.025)) @ Vector((0, 1, 0.058)).normalized().to_track_quat("Z", "Y").to_matrix().to_4x4())
    w.lathe([(0.016, 0.0), (0.022, 0.03), (0.045, 0.07), (0.05, 0.085), (0.0, 0.088)], 14, orange, smooth=True)
    for k in range(4):  # the adjustable ring's grip ridges
        w.push(Matrix.Rotation(k * math.pi / 2, 4, "Z"))
        w.box(0.044, -0.006, 0.05, 0.054, 0.006, 0.075, yellow)
        w.pop()
    w.pop()
    wand = w.build("wand", parent=root, location=GRIP_AT)
    wand["attachBone"] = "hand_R"
    wand["hoseEnd"] = [0.0, 0.0, 0.06]  # glTF frame, the back end of the handle
    nozzle_tip = Vector((0, 0.5, 0.025)) + Vector((0, 1, 0.058)).normalized() * 0.088
    nz = fc.empty("nozzle", location=tuple(nozzle_tip), parent=wand)
    nz["sprayOrigin"] = True

    # ---- the hose: a green loop from the bottom of the tank round the hip to the wand
    hb = fc.MeshBuilder()
    a = Vector(TANK_AT) + Vector((0.1, -0.08, -0.19))
    b = Vector(GRIP_AT) + Vector((0.0, -0.06, 0.0))
    c1 = a + Vector((0.12, -0.05, -0.25))
    c2 = b + Vector((0.08, -0.25, -0.15))
    pts = []
    for k in range(13):
        s = k / 12
        pts.append(a * (1 - s) ** 3 + c1 * 3 * s * (1 - s) ** 2 + c2 * 3 * s * s * (1 - s) + b * s**3)
    for p0, p1 in zip(pts, pts[1:]):
        hb.cyl_between(tuple(p0), tuple(p1), 0.013, 6, green, caps=False)
    hb.build("hose", parent=root)

    fc.export_glb("water-blaster.glb", BUDGET)


main()
