"""The Porter (Bramblecot Home's errand robot) -> public/models/errand-robot.glb

A tall, slim original industrial errand humanoid, 1.9 m tall: powder-coated
magnesium casing, machined joints, service-panel seams, replaceable motor shrouds
and a chamfered sensor pod. Its single horizontal status strip is light_face.
This design depicts no existing manufacturer or real robot product. It carries a paper grocery tote in its right hand
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
    shell = fc.material("shell_powder_coat", "#dce1df", 0.38, 0.25, extras={"rustable": True})
    shell_grey = fc.material("shell_cast_alloy", "#9da9ae", 0.4, 0.55, extras={"rustable": True})
    joint = fc.material("joint_graphite", "#2b2f35", 0.45, 0.4, extras={"rustable": True})
    trim = fc.material("trim_machined_alloy", "#71858b", 0.28, 0.75, extras={"rustable": True})
    face = fc.material("light_face", "#ffe7c2", 0.4, emission="#ffd9a0", strength=1.0)
    paper = fc.material("bag_paper", "#b98b58", 0.85)
    green = fc.material("produce_green", "#4f9a3a", 0.7)
    bread = fc.material("produce_bread", "#d39a52", 0.75)
    sole = fc.material("sole", "#1a1c1f", 0.9, extras={"rustable": True})

    root = fc.empty("errand_robot")
    root["fcActor"] = "errand-robot"
    root["robot"] = "porter"
    root["slumpKeys"] = ["seize", "slump", "melt"]

    # ---- torso: tapered manufactured casing with a replaceable front service panel
    t = fc.MeshBuilder()
    t.lathe([(0.0, -0.1), (0.07, -0.095), (0.12, -0.06), (0.135, 0.0), (0.12, 0.06), (0.09, 0.1)], 16, shell_grey, phase=0.2)
    t.cylinder(0.085, 0.09, 0.17, 16, joint, caps=False)
    t.lathe([(0.093, 0.12), (0.093, 0.14)], 16, trim, smooth=True)
    chest = [(0.09, 0.16), (0.13, 0.22), (0.16, 0.32), (0.175, 0.42), (0.17, 0.5), (0.145, 0.56), (0.09, 0.6), (0.05, 0.61)]
    t.push(Matrix.Diagonal((1.0, 0.72, 1.0, 1.0)))
    t.lathe(chest, 16, shell, smooth=True)
    t.lathe([(0.176, 0.40), (0.177, 0.415)], 18, trim, smooth=True)
    t.pop()
    # Recessed front service panel, flush fasteners and a protected intake below it.
    t.box(-0.105, 0.116, 0.265, 0.105, 0.122, 0.47, joint)
    t.box(-0.096, 0.122, 0.276, 0.096, 0.128, 0.459, shell_grey)
    for sx in (-1, 1):
        for z in (0.29, 0.444):
            t.cyl_between((sx * 0.083, 0.127, z), (sx * 0.083, 0.132, z), 0.009, 8, trim)
    for z in (0.2, 0.216, 0.232):
        t.box(-0.065, 0.105, z, 0.065, 0.111, z + 0.007, joint)
    # Rear battery spine: restrained casing and two mounting rails.
    t.box(-0.075, -0.12, 0.24, 0.075, -0.105, 0.47, joint)
    for sx in (-1, 1):
        t.box(sx * 0.067 - 0.007, -0.13, 0.26, sx * 0.067 + 0.007, -0.12, 0.45, trim)
    for sx in (1, -1):
        t.sphere((sx * SHOULDER[0], 0, SHOULDER[2]), 0.058, 12, 6, joint)
        t.sphere((sx * HIP[0], 0, HIP[2]), 0.062, 12, 6, joint)
    t.cylinder(0.04, NECK_Z - 0.02, NECK_Z + 0.02, 12, joint, caps=False)
    torso = t.build("torso", parent=root, location=(0, 0, HIP_Z))

    # ---- head: original chamfered sensor pod, service lid and guarded optical band.
    # The four corner chamfers are geometry rather than an expensive bevel modifier.
    h = fc.MeshBuilder()
    h.cylinder(0.035, 0.0, 0.065, 12, joint, caps=True)
    h.cylinder(0.052, 0.035, 0.075, 12, trim, caps=True)
    profile = [(-0.085, -0.078), (0.085, -0.078), (0.11, -0.053), (0.11, 0.065),
               (0.085, 0.09), (-0.085, 0.09), (-0.11, 0.065), (-0.11, -0.053)]
    h.prism(profile, 0.078, 0.3, shell, top=True, bottom=True, smooth=False)
    h.prism([(x * 1.015, y * 1.015) for x, y in profile], 0.3, 0.316, joint, top=True, bottom=True)
    h.frustum(profile, [(x * .85, y * .85) for x, y in profile], 0.316, 0.345, shell_grey, top=True, bottom=True)
    # Flush camera window and two recessed lenses. The status light stays a single strip.
    h.box(-0.089, 0.09, 0.158, 0.089, 0.097, 0.247, joint)
    for sx in (-1, 1):
        h.cyl_between((sx * 0.043, 0.096, 0.211), (sx * 0.043, 0.101, 0.211), 0.018, 12, trim)
        h.cyl_between((sx * 0.043, 0.101, 0.211), (sx * 0.043, 0.103, 0.211), 0.012, 12, joint)
    h.box(-0.082, 0.097, 0.163, 0.082, 0.102, 0.18, face)
    # Rear heat-exchanger slots and a modest rectangular lidar mast, no ornamental ring.
    for z in (0.16, 0.185, 0.21, 0.235):
        h.box(-0.062, -0.081, z, 0.062, -0.078, z + 0.008, joint)
    h.box(-0.04, -0.026, 0.345, 0.04, 0.026, 0.374, joint)
    h.box(-0.047, -0.032, 0.374, 0.047, 0.032, 0.39, shell_grey)
    h.build("head", parent=torso, location=(0, 0, NECK_Z))

    # ---- arms: replaceable actuator shrouds, exposed piston rails and three-finger grippers
    for side, sx in (("L", -1), ("R", 1)):
        ua = fc.MeshBuilder()
        ua.capsule((sx * 0.008, 0, -0.05), (sx * 0.006, 0, -UPPER_ARM + 0.04), 0.047, 0.04, shell)
        ua.lathe([(0.049, -0.11), (0.049, -0.12)], 12, trim, smooth=True)
        ua.cyl_between((sx * 0.043, 0, -0.09), (sx * 0.043, 0, -0.275), 0.009, 8, trim)
        ua.cyl_between((sx * 0.043, 0, -0.07), (sx * 0.043, 0, -0.16), 0.015, 8, joint)
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
        ul.cyl_between((sx * 0.051, -0.005, -0.09), (sx * 0.051, -0.005, -0.37), 0.01, 8, trim)
        upper = ul.build(f"leg_upper_{side}", parent=torso, location=(sx * HIP[0], 0, HIP[2]))
        ll = fc.MeshBuilder()
        ll.sphere((0, 0, 0), 0.05, 12, 6, joint)
        ll.capsule((0, 0, -0.04), (0, 0, -SHIN + 0.03), 0.05, 0.038, shell)
        ll.sphere((0, 0, -SHIN), 0.034, 10, 5, joint)
        ll.sphere((0, 0.05, -SHIN - 0.03), 1.0, 14, 7, shell_grey, scale=(0.055, 0.115, 0.05))
        ll.box(-0.052, -0.06, -SHIN - 0.075, 0.052, 0.16, -SHIN - 0.055, sole)
        for y in (-0.02, 0.035, 0.09):
            ll.box(-0.053, y, -SHIN - 0.076, 0.053, y + 0.012, -SHIN - 0.07, joint)
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
