"""Derive the CC0 base figure for R-Evolution from MakeHuman's hm08 base mesh.

  python3 assets/blender/tools/fetch_sources.py      # caches the MakeHuman files (network)
  "$BLENDER" -b --factory-startup -noaudio -P assets/blender/tools/make_base_female.py

Reads assets/blender/.cache/makehuman/ and writes assets/blender/data/makehuman-female.ply
(committed, so the asset build needs no network). The MakeHuman base mesh and targets are
released under CC0 1.0 (github.com/makehumancommunity/makehuman, LICENSE.md section C).

What it does: applies the female-young targets (equal mix of the three race variants), a
little extra muscle, ideal proportions, extra height and a modest bust, keeps only the
"body" group (drops eyes, teeth, tongue, joints and clothing helpers), converts MakeHuman's
decimetres, Y-up, +Z-forward frame to Blender metres, Z-up, +Y-forward, and stands the feet
on z = 0.
"""

import json
import os
import struct
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
BLENDER_DIR = os.path.dirname(HERE)
SRC = os.path.join(BLENDER_DIR, ".cache", "makehuman")
OUT = os.path.join(BLENDER_DIR, "data", "makehuman-female.ply")

TARGETS = [
    ("targets/macrodetails/african-female-young.target", 1 / 3),
    ("targets/macrodetails/asian-female-young.target", 1 / 3),
    ("targets/macrodetails/caucasian-female-young.target", 1 / 3),
    ("targets/macrodetails/universal-female-young-maxmuscle-averageweight.target", 0.35),
    ("targets/macrodetails/proportions/female-young-averagemuscle-averageweight-idealproportions.target", 0.7),
    ("targets/macrodetails/height/female-young-averagemuscle-averageweight-maxheight.target", 0.35),
    ("targets/breast/female-young-averagemuscle-averageweight-maxcup-averagefirmness.target", 0.25),
]


JOINTS = [
    "pelvis", "spine-1", "spine-2", "spine-3", "spine-4", "neck", "head", "head-2",
    "l-clavicle", "l-shoulder", "l-elbow", "l-hand", "r-clavicle", "r-shoulder", "r-elbow", "r-hand",
    "l-upper-leg", "l-knee", "l-ankle", "l-foot-1", "l-foot-2",
    "r-upper-leg", "r-knee", "r-ankle", "r-foot-1", "r-foot-2",
]


def load_obj(path):
    verts, faces = [], []
    joints: dict[str, set] = {}
    group = None
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("v "):
                verts.append([float(t) for t in line.split()[1:4]])
            elif line.startswith("g "):
                group = line.split()[1]
            elif line.startswith("f "):
                idx = [int(t.split("/")[0]) - 1 for t in line.split()[1:]]
                if group == "body":
                    faces.append(idx)
                elif group and group.startswith("joint-"):
                    joints.setdefault(group[len("joint-"):], set()).update(idx)
    return np.array(verts, dtype=np.float64), faces, joints


def apply_target(v, path, w):
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip() or line.startswith("#"):
                continue
            i, dx, dy, dz = line.split()
            v[int(i)] += w * np.array([float(dx), float(dy), float(dz)])


def main():
    v, faces, jgroups = load_obj(os.path.join(SRC, "3dobjs", "base.obj"))
    for rel, w in TARGETS:
        apply_target(v, os.path.join(SRC, rel), w)
    jc = {name: v[sorted(jgroups[name])].mean(axis=0) for name in JOINTS}
    used = sorted({i for f in faces for i in f})
    remap = {old: new for new, old in enumerate(used)}
    v = v[used]
    faces = [[remap[i] for i in f] for f in faces]

    # MakeHuman is right-handed: x = the figure's left, y up, z forward, decimetres.
    # Blender (ours): x = the figure's right, y forward, z up, metres. A proper rotation.
    def conv(a):
        a = np.atleast_2d(a)
        return np.stack([-a[:, 0], a[:, 2], a[:, 1]], axis=1) * 0.1

    b = conv(v)
    shift = np.array([-(b[:, 0].min() + b[:, 0].max()) / 2, 0.0, -b[:, 2].min()])
    b += shift
    feet = b[b[:, 2] < 0.1]
    shift[1] = -feet[:, 1].mean()
    b[:, 1] += shift[1]
    joints = {k: [round(float(c), 5) for c in (conv(p)[0] + shift)] for k, p in jc.items()}
    with open(OUT.replace(".ply", "-joints.json"), "w", encoding="utf-8") as f:
        json.dump({"note": "Joint centres of the MakeHuman hm08 rig (CC0), same frame as the PLY. "
                   "l- is the figure's left (-x).", "joints": joints}, f, indent=1)
        f.write("\n")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as f:
        head = (
            "ply\nformat binary_little_endian 1.0\n"
            "comment MakeHuman hm08 body, female-young targets applied (CC0 1.0). See tools/make_base_female.py\n"
            f"element vertex {len(b)}\nproperty float x\nproperty float y\nproperty float z\n"
            f"element face {len(faces)}\nproperty list uchar int vertex_indices\nend_header\n"
        )
        f.write(head.encode("ascii"))
        f.write(b.astype("<f4").tobytes())
        for fc_ in faces:
            f.write(struct.pack("<B", len(fc_)) + struct.pack(f"<{len(fc_)}i", *fc_))
    print(f"[fc] wrote {OUT}: {len(b)} verts, {len(faces)} faces, height {b[:, 2].max():.3f} m")


main()
sys.stdout.flush()
