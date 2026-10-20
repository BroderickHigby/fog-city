"""An original errand robot -> public/models/errand-robot.glb

A 1.6 m humanoid helper with a clean white pebble-smooth shell, graphite joints, a dark visor
with one soft face light (light_face, emissive) and a small battery pack. It carries a paper
grocery tote (node "bag", a child of the right forearm) with its groceries as a child node
"bag_contents" (hide it for an empty bag). Designed for procedural animation:
every rigid part is its own node with its origin at the joint it turns about.

  errand_robot (root, ground)
    torso (hip centre)
      head (neck base)
      arm_upper_L/R (shoulder) -> arm_lower_L/R (elbow) [-> bag -> bag_contents on R]
      leg_upper_L/R (hip joint) -> leg_lower_L/R (knee)

L/R are the robot's own left/right: left is -X. Rest pose: standing, arms down. Rotating a
limb node about its local X swings it forward/back. Front faces glTF -Z. Budget: 6k tris.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

from mathutils import Matrix  # noqa: E402

import fc  # noqa: E402

BUDGET = 6_000
HIP_Z = 0.90
SHOULDER = (0.235, 0.0, 0.47)  # relative to torso
UPPER_ARM = 0.29
FOREARM = 0.25
HIP = (0.10, 0.0, -0.04)  # relative to torso
THIGH = 0.41
SHIN_TO_SOLE = HIP_Z - 0.04 - THIGH  # knee height above the ground


def main() -> None:
    fc.reset()
    shell = fc.material("shell_white", "#f2f2ef", 0.32, 0.0)
    joint = fc.material("joint_graphite", "#2b2f35", 0.5, 0.35)
    visor = fc.material("visor", "#0c1015", 0.08, 0.25)
    accent = fc.material("accent_teal", "#2fa89a", 0.45, 0.1)
    face = fc.material("light_face", "#9ff7ff", 0.3, emission="#7ff4ff", strength=1.0)
    paper = fc.material("bag_paper", "#b98b58", 0.85)
    green = fc.material("produce_green", "#4f9a3a", 0.7)
    bread = fc.material("produce_bread", "#d39a52", 0.75)
    sole = fc.material("sole", "#1a1c1f", 0.9)

    root = fc.empty("errand_robot")
    root["fcActor"] = "errand-robot"

    # ---- torso: pelvis, waist, chest shell, battery pack
    t = fc.MeshBuilder()
    t.sphere((0, 0, 0.0), 1.0, 14, 7, shell, scale=(0.16, 0.115, 0.1))
    t.cylinder(0.105, 0.04, 0.16, 14, joint, caps=False)
    t.lathe([(0.112, 0.085), (0.112, 0.115)], 16, accent, smooth=True)
    t.sphere((0, 0.0, 0.33), 1.0, 16, 9, shell, scale=(0.205, 0.13, 0.215))
    t.box(-0.11, -0.19, 0.22, 0.11, -0.10, 0.46, joint)  # battery pack
    t.box(-0.085, -0.195, 0.27, 0.085, -0.185, 0.42, accent)
    for sx in (1, -1):
        t.sphere((sx * SHOULDER[0], 0, SHOULDER[2]), 0.062, 12, 6, joint)  # shoulder sockets
        t.sphere((sx * HIP[0], 0, HIP[2]), 0.06, 12, 6, joint)  # hip sockets
    torso = t.build("torso", parent=root, location=(0, 0, HIP_Z))

    # ---- head: neck, rounded shell, visor, one face light
    h = fc.MeshBuilder()
    h.cylinder(0.045, 0.0, 0.08, 12, joint, caps=False)
    h.sphere((0, 0, 0.19), 1.0, 18, 10, shell, scale=(0.125, 0.12, 0.125))
    h.sphere((0, 0.028, 0.195), 1.0, 18, 10, visor, scale=(0.112, 0.105, 0.082))
    # face light: a gently curved band on the visor
    pts = []
    for k in range(9):
        a = math.radians(-34 + 68 * k / 8)
        pts.append((0.1065 * math.sin(a) * 1.0, 0.028 + 0.1065 * math.cos(a) * 1.0, 0.203 - 0.012 * math.cos(a * 2.2)))
    for p0, p1 in zip(pts, pts[1:]):
        h.cyl_between(p0, p1, 0.011, 6, face, smooth=True, caps=False)
    h.sphere(pts[0], 0.011, 6, 4, face)
    h.sphere(pts[-1], 0.011, 6, 4, face)
    # ear pods
    for sx in (1, -1):
        h.push(Matrix.Translation((sx * 0.125, 0, 0.19)) @ Matrix.Rotation(math.pi / 2, 4, "Y"))
        h.cylinder(0.04, -0.015, 0.015, 12, accent)
        h.pop()
    h.build("head", parent=torso, location=(0, 0, 0.53))

    # ---- arms
    for side, sx in (("L", -1), ("R", 1)):
        ua = fc.MeshBuilder()
        ua.capsule((sx * 0.012, 0, -0.04), (sx * 0.008, 0, -UPPER_ARM + 0.035), 0.055, 0.047, shell)
        upper = ua.build(f"arm_upper_{side}", parent=torso, location=(sx * SHOULDER[0], 0, SHOULDER[2]))
        la = fc.MeshBuilder()
        la.sphere((0, 0, 0), 0.045, 12, 6, joint)
        la.capsule((0, 0, -0.03), (0, 0.004, -FOREARM + 0.035), 0.046, 0.038, shell)
        # hand: a soft mitten with a thumb, palm facing the leg
        la.sphere((0, 0.005, -FOREARM - 0.035), 1.0, 10, 6, joint, scale=(0.032, 0.05, 0.06))
        la.capsule((-sx * 0.02, 0.035, -FOREARM - 0.02), (-sx * 0.02, 0.055, -FOREARM - 0.06), 0.014, 0.012, joint, seg=6, rings=2)
        lower = la.build(f"arm_lower_{side}", parent=upper, location=(sx * 0.008, 0, -UPPER_ARM))
        if side == "R":
            build_bag(lower, paper, green, bread, joint)

    # ---- legs
    for side, sx in (("L", -1), ("R", 1)):
        ul = fc.MeshBuilder()
        ul.capsule((0, 0, -0.045), (0, 0.005, -THIGH + 0.04), 0.07, 0.058, shell)
        upper = ul.build(f"leg_upper_{side}", parent=torso, location=(sx * HIP[0], 0, HIP[2]))
        ll = fc.MeshBuilder()
        ll.sphere((0, 0, 0), 0.055, 12, 6, joint)
        ll.capsule((0, 0, -0.035), (0, 0, -SHIN_TO_SOLE + 0.13), 0.058, 0.045, shell)
        ll.sphere((0, 0, -SHIN_TO_SOLE + 0.1), 0.04, 10, 5, joint)  # ankle
        # foot: rounded shell with a dark sole, toe forward (+Y)
        ll.sphere((0, 0.045, -SHIN_TO_SOLE + 0.05), 1.0, 12, 6, shell, scale=(0.06, 0.12, 0.05))
        ll.box(-0.058, -0.07, -SHIN_TO_SOLE, 0.058, 0.16, -SHIN_TO_SOLE + 0.02, sole)
        ll.build(f"leg_lower_{side}", parent=upper, location=(0, 0, -THIGH))

    fc.export_glb("errand-robot.glb", BUDGET)


def build_bag(parent, paper, green, bread, handle_mat):
    """A paper tote hanging from the right hand; origin at the grip."""
    b = fc.MeshBuilder()
    w, d, top, bottom = 0.15, 0.075, -0.13, -0.42  # half width (y), half depth (x)
    x0 = 0.03  # hangs a little outboard of the hand
    b.box(x0 - d, -w, bottom, x0 + d, w, top, paper, skip=("+z",))
    # inside walls so the open top does not show through
    b.box(x0 - d + 0.01, -w + 0.01, top - 0.06, x0 + d - 0.01, w - 0.01, top - 0.005, paper, skip=("+z", "-z"))
    b.poly_n([(x0 - d + 0.01, -w + 0.01, top - 0.06), (x0 + d - 0.01, -w + 0.01, top - 0.06),
              (x0 + d - 0.01, w - 0.01, top - 0.06), (x0 - d + 0.01, w - 0.01, top - 0.06)], paper, (0, 0, 1))
    # handles from the rim up to the grip
    for sy in (1, -1):
        b.cyl_between((x0, sy * 0.08, top), (0.0, sy * 0.012, -0.01), 0.008, 5, handle_mat, caps=False)
    bag = b.build("bag", parent=parent, location=(0.0, 0.005, -FOREARM - 0.05))
    bag["carried"] = True
    # groceries: leafy greens and a baguette, their own node (origin at the bag's mouth) so the
    # renderer can show an empty bag by hiding bag_contents
    g = fc.MeshBuilder()
    g.push(Matrix.Translation((-x0, 0.0, -top)))
    g.sphere((x0, 0.06, top + 0.01), 0.06, 10, 5, green)
    g.sphere((x0 - 0.02, 0.0, top + 0.03), 0.05, 10, 5, green)
    g.capsule((x0 + 0.02, -0.09, top - 0.05), (x0 + 0.03, -0.12, top + 0.17), 0.028, 0.026, bread, seg=8, rings=2)
    g.pop()
    contents = g.build("bag_contents", parent=bag, location=(x0, 0.0, top))
    contents["bagContents"] = True
    return bag


main()
