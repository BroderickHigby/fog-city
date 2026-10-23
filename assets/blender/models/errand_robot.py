"""The Porter (Bramblecot Home's errand robot) -> public/models/errand-robot.glb

A tall, slim errand humanoid, 1.9 m to the top of its lantern: an opaque glazed-ceramic
shell (no translucent face plate or torso), graphite joints, and a lantern-shaped head (a
barrel with a cap, a collar and a carrying ring) whose soft face light is one horizontal
strip across the front (light_face). It carries a paper grocery tote in its right hand
(node "bag", a child of the right forearm) with the groceries as the child node
"bag_contents" (hide it for an empty bag).

Rigid parts are nodes whose origins are the joints they turn about (procedural animation):

  errand_robot (root, ground)
    torso (hip centre)
      head (neck base)
      arm_upper_L/R (shoulder) -> arm_lower_L/R (elbow) [-> bag -> bag_contents on R]
      leg_upper_L/R (hip joint) -> leg_lower_L/R (knee)

Melt hooks: every part carries three shape keys, seize -> slump -> melt (morph targets,
authored at rest), and a per-vertex _RUST_MASK (0 rusts first at the joints and seams, 1
last; 2 never: the face light and the groceries). See assets/blender/README.md, "Melting and
rust".

L/R are the robot's own left/right: left is -X. Rest pose: standing, arms down. Rotating a
limb node about its local X swings it forward. Front faces glTF -Z. Budget: 6k tris.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

from mathutils import Matrix  # noqa: E402

import fc  # noqa: E402
import melt  # noqa: E402

BUDGET = 6_000
HIP_Z = 0.95
SHOULDER = (0.2, 0.0, 0.48)  # relative to the torso origin
NECK_Z = 0.58  # relative to the torso origin
UPPER_ARM = 0.33
FOREARM = 0.3
HIP = (0.095, 0.0, -0.04)
THIGH = 0.45
SHIN = HIP_Z - 0.04 - THIGH - 0.075  # knee to ankle


def main() -> None:
    fc.reset()
    shell = fc.material("shell_ceramic", "#f3f1ec", 0.24, 0.0, extras={"rustable": True})
    shell_grey = fc.material("shell_ceramic_grey", "#d9dcdf", 0.3, 0.0, extras={"rustable": True})
    joint = fc.material("joint_graphite", "#2b2f35", 0.45, 0.4, extras={"rustable": True})
    trim = fc.material("trim_bronze", "#9a7b55", 0.35, 0.7, extras={"rustable": True})
    face = fc.material("light_face", "#ffe7c2", 0.4, emission="#ffd9a0", strength=1.0)
    paper = fc.material("bag_paper", "#b98b58", 0.85)
    green = fc.material("produce_green", "#4f9a3a", 0.7)
    bread = fc.material("produce_bread", "#d39a52", 0.75)
    sole = fc.material("sole", "#1a1c1f", 0.9, extras={"rustable": True})

    root = fc.empty("errand_robot")
    root["fcActor"] = "errand-robot"
    root["robot"] = "porter"
    root["slumpKeys"] = ["seize", "slump", "melt"]

    # ---- torso: a slim glazed vase (pelvis, waist ring, chest) with a bronze seam
    t = fc.MeshBuilder()
    t.lathe([(0.0, -0.1), (0.07, -0.095), (0.12, -0.06), (0.135, 0.0), (0.12, 0.06), (0.09, 0.1)], 16, shell_grey, phase=0.2)
    t.cylinder(0.085, 0.09, 0.17, 16, joint, caps=False)
    t.lathe([(0.093, 0.12), (0.093, 0.14)], 16, trim, smooth=True)
    chest = [(0.09, 0.16), (0.13, 0.22), (0.16, 0.32), (0.175, 0.42), (0.17, 0.5), (0.145, 0.56), (0.09, 0.6), (0.05, 0.61)]
    t.push(Matrix.Diagonal((1.0, 0.72, 1.0, 1.0)))
    t.lathe(chest, 18, shell, smooth=True)
    t.lathe([(0.176, 0.40), (0.177, 0.415)], 18, trim, smooth=True)
    t.pop()
    for sx in (1, -1):
        t.sphere((sx * SHOULDER[0], 0, SHOULDER[2]), 0.058, 12, 6, joint)
        t.sphere((sx * HIP[0], 0, HIP[2]), 0.062, 12, 6, joint)
    t.cylinder(0.04, NECK_Z - 0.02, NECK_Z + 0.02, 12, joint, caps=False)
    torso = t.build("torso", parent=root, location=(0, 0, HIP_Z))

    # ---- head: a lantern. Collar, gently bulging barrel, cap, finial and carrying ring
    h = fc.MeshBuilder()
    h.cylinder(0.035, 0.0, 0.05, 12, joint, caps=False)
    h.lathe([(0.0, 0.04), (0.075, 0.045), (0.085, 0.06), (0.08, 0.075)], 16, trim, smooth=True)
    barrel = [(0.08, 0.075), (0.098, 0.105), (0.108, 0.16), (0.108, 0.215), (0.098, 0.27), (0.082, 0.3)]
    h.lathe(barrel, 18, shell, smooth=True, phase=math.pi / 18)
    # vertical ribs, like a lantern's frame (none across the face)
    for k in range(6):
        a = math.pi / 2 + (k + 0.5) * math.pi / 3
        h.push(Matrix.Rotation(a, 4, "Z"))
        h.box(0.103, -0.006, 0.09, 0.111, 0.006, 0.29, trim)
        h.pop()
    h.lathe([(0.082, 0.3), (0.105, 0.305), (0.11, 0.315), (0.07, 0.34), (0.02, 0.355), (0.0, 0.358)], 16, trim, smooth=True)
    h.cylinder(0.012, 0.355, 0.372, 8, trim, caps=True)
    # the carrying ring (bail) on top, across the head from side to side
    ring_r, tube = 0.035, 0.007
    pts = [(ring_r * math.cos(math.pi * k / 12), 0.0, 0.372 + ring_r * math.sin(math.pi * k / 12)) for k in range(13)]
    for p0, p1 in zip(pts, pts[1:]):
        h.cyl_between(p0, p1, tube, 6, trim, caps=False)
    # the face light: one soft horizontal strip wrapping the front of the barrel
    z0, z1 = 0.178, 0.203
    seg = 10
    for k in range(seg):
        a0 = math.radians(35 + 110 * k / seg)
        a1 = math.radians(35 + 110 * (k + 1) / seg)
        r = 0.1105
        h.poly_n([(r * math.cos(a0), r * math.sin(a0), z0), (r * math.cos(a1), r * math.sin(a1), z0),
                  (r * math.cos(a1), r * math.sin(a1), z1), (r * math.cos(a0), r * math.sin(a0), z1)],
                 face, (math.cos((a0 + a1) / 2), math.sin((a0 + a1) / 2), 0.0), smooth=True)
    h.build("head", parent=torso, location=(0, 0, NECK_Z))

    # ---- arms: long tapered ceramic segments, graphite elbows and wrists, three-finger hands
    for side, sx in (("L", -1), ("R", 1)):
        ua = fc.MeshBuilder()
        ua.capsule((sx * 0.008, 0, -0.05), (sx * 0.006, 0, -UPPER_ARM + 0.04), 0.047, 0.04, shell)
        ua.lathe([(0.049, -0.11), (0.049, -0.12)], 12, trim, smooth=True)
        upper = ua.build(f"arm_upper_{side}", parent=torso, location=(sx * SHOULDER[0], 0, SHOULDER[2]))
        la = fc.MeshBuilder()
        la.sphere((0, 0, 0), 0.04, 12, 6, joint)
        la.capsule((0, 0, -0.04), (0, 0.004, -FOREARM + 0.04), 0.04, 0.032, shell)
        la.sphere((0, 0.004, -FOREARM), 0.028, 10, 5, joint)
        # hand: a palm and three soft fingers, palm toward the leg, and a thumb
        la.sphere((0, 0.006, -FOREARM - 0.045), 1.0, 10, 6, joint, scale=(0.026, 0.045, 0.045))
        for dy in (-0.025, 0.0, 0.025):
            la.capsule((0, 0.006 + dy, -FOREARM - 0.07), (-sx * 0.006, 0.01 + dy, -FOREARM - 0.11), 0.011, 0.009, joint, seg=6, rings=2)
        la.capsule((-sx * 0.02, 0.04, -FOREARM - 0.035), (-sx * 0.022, 0.055, -FOREARM - 0.07), 0.011, 0.009, joint, seg=6, rings=2)
        lower = la.build(f"arm_lower_{side}", parent=upper, location=(sx * 0.006, 0, -UPPER_ARM))
        if side == "R":
            build_bag(lower, paper, green, bread, joint)

    # ---- legs: long slim segments, a graphite knee, rounded ceramic boots
    for side, sx in (("L", -1), ("R", 1)):
        ul = fc.MeshBuilder()
        ul.capsule((0, 0, -0.05), (0, 0.005, -THIGH + 0.045), 0.062, 0.05, shell)
        ul.lathe([(0.064, -0.16), (0.064, -0.172)], 12, trim, smooth=True)
        upper = ul.build(f"leg_upper_{side}", parent=torso, location=(sx * HIP[0], 0, HIP[2]))
        ll = fc.MeshBuilder()
        ll.sphere((0, 0, 0), 0.05, 12, 6, joint)
        ll.capsule((0, 0, -0.04), (0, 0, -SHIN + 0.03), 0.05, 0.038, shell)
        ll.sphere((0, 0, -SHIN), 0.034, 10, 5, joint)
        ll.sphere((0, 0.05, -SHIN - 0.03), 1.0, 14, 7, shell_grey, scale=(0.055, 0.115, 0.05))
        ll.box(-0.052, -0.06, -SHIN - 0.075, 0.052, 0.16, -SHIN - 0.055, sole)
        ll.build(f"leg_lower_{side}", parent=upper, location=(0, 0, -THIGH))

    top = HIP_Z + NECK_Z + 0.42
    fc.add_deform_keys(melt.keys(height=top, neck_z=HIP_Z + NECK_Z, heap_r=0.48, heap_h=0.42))
    seams = [(0, 0, HIP_Z + 0.13), (0, 0, HIP_Z + NECK_Z), (0, 0, HIP_Z + 0.41), (0, 0, HIP_Z + NECK_Z + 0.06)]
    for sx in (1, -1):
        seams += [(sx * SHOULDER[0], 0, HIP_Z + SHOULDER[2]), (sx * 0.21, 0, HIP_Z + SHOULDER[2] - UPPER_ARM),
                  (sx * 0.21, 0, HIP_Z + SHOULDER[2] - UPPER_ARM - FOREARM), (sx * HIP[0], 0, HIP_Z + HIP[2]),
                  (sx * HIP[0], 0, HIP_Z + HIP[2] - THIGH), (sx * HIP[0], 0, 0.1)]
    fc.add_rust_mask(seams, reach=0.22, first=("joint_graphite",), never=("light_", "bag_", "produce_"))
    fc.export_glb("errand-robot.glb", BUDGET, morph=True, attributes=True)


def build_bag(parent, paper, green, bread, handle_mat):
    """A paper tote hanging from the right hand; origin at the grip."""
    b = fc.MeshBuilder()
    w, d, top, bottom = 0.15, 0.075, -0.13, -0.42  # half width (y), half depth (x)
    x0 = 0.035  # hangs a little outboard of the hand
    b.box(x0 - d, -w, bottom, x0 + d, w, top, paper, skip=("+z",))
    b.box(x0 - d + 0.01, -w + 0.01, top - 0.06, x0 + d - 0.01, w - 0.01, top - 0.005, paper, skip=("+z", "-z"))
    b.poly_n([(x0 - d + 0.01, -w + 0.01, top - 0.06), (x0 + d - 0.01, -w + 0.01, top - 0.06),
              (x0 + d - 0.01, w - 0.01, top - 0.06), (x0 - d + 0.01, w - 0.01, top - 0.06)], paper, (0, 0, 1))
    for sy in (1, -1):
        b.cyl_between((x0, sy * 0.08, top), (0.0, sy * 0.012, -0.01), 0.008, 5, handle_mat, caps=False)
    bag = b.build("bag", parent=parent, location=(0.0, 0.006, -FOREARM - 0.08))
    bag["carried"] = True
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
