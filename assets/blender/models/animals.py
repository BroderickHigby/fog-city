"""City animals -> public/models/pigeon.glb, public/models/dog.glb

Tiny instanced meshes with two frames each, stored as one morph target (blend 0 <-> 1):
  pigeon  0.32 m long. Frame 0 standing, morph `peck` = head down to the pavement. Bob it.
  dog     a leashed medium dog, 0.5 m at the shoulder. Frame 0 one stride, morph `stride` =
          the other; ping-pong the weight at the walking cadence (about 2 Hz). Node `leash`
          runs from the collar (extras collar) to a hand loop (extras handle) where a person's
          hand would be: hide it and draw your own between the collar and the walker's hand,
          or keep it for a dog standing beside its person.

Both roots carry extras {"animal": true, "noTouch": true}: water never reaches an animal,
and animals startle away before the stream arrives (design.md). Front faces glTF -Z.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import numpy as np  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import fc  # noqa: E402

BUDGETS = {"pigeon.glb": 300, "dog.glb": 1_000}


def pigeon() -> None:
    fc.reset()
    grey = fc.material("pigeon_grey", "#8a8f99", 0.75)
    dark = fc.material("pigeon_slate", "#4f5560", 0.75)
    neck = fc.material("pigeon_neck_sheen", "#5f7a6e", 0.35, 0.25)
    feet = fc.material("pigeon_feet", "#d7746c", 0.6)
    eye = fc.material("pigeon_eye", "#e0672a", 0.3)
    root = fc.empty("pigeon")
    root["fcActor"] = "pigeon"
    root["animal"] = True
    root["noTouch"] = True
    mb = fc.MeshBuilder()
    # body: an egg leaning forward, tail fan behind, wings folded on the sides
    mb.sphere((0, 0.0, 0.14), 1.0, 8, 5, grey, scale=(0.065, 0.12, 0.07))
    mb.poly_n([(-0.04, -0.1, 0.15), (0.04, -0.1, 0.15), (0.03, -0.2, 0.12), (-0.03, -0.2, 0.12)], dark, (0, 0, 1))
    mb.poly_n([(-0.04, -0.1, 0.15), (0.04, -0.1, 0.15), (0.03, -0.2, 0.12), (-0.03, -0.2, 0.12)], dark, (0, 0, -1))
    for sx in (1, -1):
        mb.poly_n([(sx * 0.066, 0.06, 0.16), (sx * 0.06, -0.12, 0.15), (sx * 0.05, -0.05, 0.11)], dark, (sx, 0, 0.2))
    # head and neck: their own vertices, so the peck frame moves only them
    mb.sphere((0, 0.09, 0.2), 1.0, 6, 4, neck, scale=(0.04, 0.045, 0.05))
    mb.sphere((0, 0.12, 0.25), 0.032, 6, 4, grey)
    mb.poly_n([(-0.006, 0.148, 0.252), (0.006, 0.148, 0.252), (0.0, 0.17, 0.245)], dark, (0, 0.3, 1))
    mb.poly_n([(-0.006, 0.148, 0.252), (0.006, 0.148, 0.252), (0.0, 0.17, 0.245)], dark, (0, 0.3, -1))
    for sx in (1, -1):
        mb.box(sx * 0.028 - 0.004, 0.13, 0.255, sx * 0.028 + 0.004, 0.138, 0.263, eye)
    # legs and feet
    for sx in (1, -1):
        mb.box(sx * 0.02 - 0.005, 0.01, 0.0, sx * 0.02 + 0.005, 0.02, 0.08, feet)
        mb.poly_n([(sx * 0.02 - 0.015, 0.0, 0.002), (sx * 0.02 + 0.015, 0.0, 0.002), (sx * 0.02, 0.05, 0.002)], feet, (0, 0, 1))
    body = mb.build("body", parent=root)

    def peck(P):
        P = np.asarray(P, dtype=np.float64).copy()
        m = (P[:, 1] > 0.05) & (P[:, 2] > 0.17)
        pivot = np.array([0.0, 0.06, 0.17])
        a = math.radians(70)
        d = P[m] - pivot
        y = d[:, 1] * math.cos(a) - d[:, 2] * math.sin(a)
        z = d[:, 1] * math.sin(a) + d[:, 2] * math.cos(a)
        P[m, 1] = pivot[1] + y
        P[m, 2] = pivot[2] + z
        # the tail lifts as it leans in
        t = P[:, 1] < -0.1
        P[t, 2] += 0.03
        return P

    fc.add_deform_keys([("peck", peck)], objects=[body])
    fc.export_glb("pigeon.glb", BUDGETS["pigeon.glb"], morph=True)


def dog() -> None:
    fc.reset()
    coat = fc.material("dog_coat", "#b5844f", 0.8)
    pale = fc.material("dog_coat_pale", "#ead9bf", 0.8)
    nose = fc.material("dog_nose", "#231e1c", 0.4)
    collar = fc.material("dog_collar", "#d1453b", 0.5)
    leash_m = fc.material("leash", "#2f6fd1", 0.5)
    root = fc.empty("dog")
    root["fcActor"] = "dog"
    root["animal"] = True
    root["noTouch"] = True
    root["leashed"] = True
    mb = fc.MeshBuilder()
    H = 0.48  # shoulder height
    # body (a long egg), chest, neck, head with a snout, ears, tail
    mb.sphere((0, 0.02, H - 0.04), 1.0, 10, 6, coat, scale=(0.12, 0.3, 0.13))
    mb.sphere((0, 0.22, H - 0.06), 1.0, 8, 5, pale, scale=(0.1, 0.1, 0.12))
    mb.capsule((0, 0.27, H + 0.02), (0, 0.33, H + 0.15), 0.065, 0.06, coat, seg=8, rings=2)
    mb.sphere((0, 0.36, H + 0.2), 1.0, 8, 6, coat, scale=(0.085, 0.1, 0.085))
    mb.capsule((0, 0.42, H + 0.17), (0, 0.5, H + 0.15), 0.045, 0.035, pale, seg=8, rings=2)
    mb.sphere((0, 0.535, H + 0.155), 0.022, 6, 4, nose)
    for sx in (1, -1):
        mb.poly_n([(sx * 0.05, 0.34, H + 0.27), (sx * 0.09, 0.36, H + 0.24), (sx * 0.1, 0.33, H + 0.12)], coat, (sx, 0, 0.3))
        mb.poly_n([(sx * 0.05, 0.34, H + 0.27), (sx * 0.09, 0.36, H + 0.24), (sx * 0.1, 0.33, H + 0.12)], coat, (-sx, 0, -0.3))
        mb.box(sx * 0.045 - 0.008, 0.425, H + 0.215, sx * 0.045 + 0.008, 0.435, H + 0.23, nose)
    mb.capsule((0, -0.27, H + 0.0), (0, -0.42, H + 0.14), 0.03, 0.018, coat, seg=6, rings=2)
    mb.push(Matrix.Translation((0, 0.3, H + 0.08)) @ Vector((0, 0.35, 1.0)).normalized().to_track_quat("Z", "Y").to_matrix().to_4x4())
    mb.lathe([(0.07, -0.015), (0.072, 0.0), (0.07, 0.015)], 10, collar, smooth=True)
    mb.pop()
    # legs: capsules from shoulder/hip to paw, stance A
    legs = []  # (first vertex, end vertex, pivot, diagonal sign)
    for (y, sy) in ((0.17, 1), (-0.17, -1)):
        for sx in (1, -1):
            top = (sx * 0.07, y, H - 0.08)
            paw = (sx * 0.07, y + 0.02 * sy, 0.03)
            i0 = len(mb.verts)
            mb.capsule(top, paw, 0.035, 0.027, coat if sy < 0 else pale, seg=6, rings=2)
            legs.append((i0, len(mb.verts), np.array(top), sx * sy))
    body = mb.build("body", parent=root)

    def swing(P, deg):
        P = np.asarray(P, dtype=np.float64).copy()
        for i0, i1, pivot, sign in legs:
            a = math.radians(deg) * sign
            d = P[i0:i1] - pivot
            yy = d[:, 1] * math.cos(a) + d[:, 2] * math.sin(a)
            zz = -d[:, 1] * math.sin(a) + d[:, 2] * math.cos(a)
            P[i0:i1, 1] = pivot[1] + yy
            P[i0:i1, 2] = pivot[2] + zz
        return P

    def stride(P):
        """The other half of the gait: diagonal leg pairs swing the other way, a small bounce."""
        P = swing(P, 24.0)
        P[: legs[0][0], 2] += 0.012
        return P

    # frame 0 has the legs swung one way (baked into the base); the key swings them the other
    me = body.data
    co = np.zeros(len(me.vertices) * 3)
    me.vertices.foreach_get("co", co)
    me.vertices.foreach_set("co", swing(co.reshape(-1, 3), -12.0).reshape(-1))
    me.update()
    fc.add_deform_keys([("stride", stride)], objects=[body])

    # the leash: collar to a hand loop up and behind on the dog's left, where a walker's hand is
    collar_pt = Vector((0.0, 0.3, H + 0.1))
    handle = Vector((-0.35, -0.55, 0.92))
    lb = fc.MeshBuilder()
    mid = (collar_pt + handle) / 2 + Vector((0, 0, -0.12))
    pts = [collar_pt * (1 - s) ** 2 + mid * 2 * s * (1 - s) + handle * s * s for s in [k / 8 for k in range(9)]]
    for p0, p1 in zip(pts, pts[1:]):
        lb.cyl_between(tuple(p0), tuple(p1), 0.007, 5, leash_m, caps=False)
    lb.push(Matrix.Translation(tuple(handle)) @ Matrix.Rotation(math.pi / 2, 4, "Y"))
    lb.lathe([(0.04, -0.006), (0.046, 0.0), (0.04, 0.006)], 8, leash_m, smooth=True)
    lb.pop()
    leash = lb.build("leash", parent=root)
    leash["collar"] = [round(collar_pt.x, 3), round(collar_pt.z, 3), round(-collar_pt.y, 3)]
    leash["handle"] = [round(handle.x, 3), round(handle.z, 3), round(-handle.y, 3)]
    fc.export_glb("dog.glb", BUDGETS["dog.glb"], morph=True)


pigeon()
dog()
