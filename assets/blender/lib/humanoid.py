"""The Fog City humanoid: one parametric body, one rig, one clip library. Pure numpy (no bpy),
so the geometry, the skinning and the vertex-animation bake can be checked outside Blender.

Frame: Blender metres, +Y forward (the front), +X the person's right, +Z up, origin on the
ground between the feet. Export to glTF maps (x, y, z) -> (x, z, -y), so the front faces -Z.

The body is generated, not sculpted. `build(frame, params, res)` returns the same topology
(vertex order, triangles, slots, skin weights) for every `params`, so a body variant is just
build(variant params) - build(base params): that difference is a shape key. Clothing and hair
layers (fleece vest, hood, lanyard, skirt, long hair, bun) always exist; with their key at 0
they sit just inside the body and are hidden, at 1 they sit on the surface.

The rig is 20 bones whose rest frames are world-aligned (no rest rotation), so a pose is a set
of plain rotations about each joint: +X rotation swings a hanging limb forward, leans the
spine back and lifts the toes; +Y rotation swings a hanging limb to the person's left (-X) and
leans the spine to the right; +Z turns to the left (counter-clockwise from above).
"""

from __future__ import annotations

import math

import numpy as np

# Tint slots: every vertex belongs to one. The renderer colours a vertex with the palette
# entry for its slot (see assets/blender/README.md, "Humanoid line").
SLOTS = ["skin", "hair", "top", "bottom", "shoes", "outer", "accent", "sole", "eyes", "badge"]
SLOT = {n: i for i, n in enumerate(SLOTS)}

BONES = [
    ("root", None),
    ("hips", "root"),
    ("spine", "hips"),
    ("chest", "spine"),
    ("neck", "chest"),
    ("head", "neck"),
    ("shoulder_L", "chest"),
    ("upper_arm_L", "shoulder_L"),
    ("forearm_L", "upper_arm_L"),
    ("hand_L", "forearm_L"),
    ("shoulder_R", "chest"),
    ("upper_arm_R", "shoulder_R"),
    ("forearm_R", "upper_arm_R"),
    ("hand_R", "forearm_R"),
    ("thigh_L", "hips"),
    ("shin_L", "thigh_L"),
    ("foot_L", "shin_L"),
    ("thigh_R", "hips"),
    ("shin_R", "thigh_R"),
    ("foot_R", "shin_R"),
]
BONE_INDEX = {b: i for i, (b, _) in enumerate(BONES)}

# Shape keys (morph targets) in a fixed order: the VAT morph texture and the player GLB use it.
KEYS = [
    "build_slim",
    "build_broad",
    "build_heavy",
    "curvy",
    "older",
    "hair_none",
    "hair_long",
    "hair_bun",
    "vest",
    "hoodie",
    "lanyard",
    "skirt",
]

BASE_PARAMS = dict(
    girth=1.0, limb=1.0, shoulders=0.0, belly=0.0, bust=0.0, hips=0.0, waist=1.0, stoop=0.0,
    jaw=1.0, arm_out=0.0, hair=0.012, hair_long=0.0, bun=0.0, vest=0.0, hood=0.0, lanyard=0.0, skirt=0.0,
)

# Each key's parameter change from the base (key weight 1).
KEY_PARAMS = {
    "build_slim": dict(girth=0.88, limb=0.86, shoulders=-0.012, hips=-0.012),
    "build_broad": dict(girth=1.07, limb=1.13, shoulders=0.028, arm_out=0.02),
    "build_heavy": dict(girth=1.16, limb=1.2, belly=0.065, hips=0.03, jaw=1.12, arm_out=0.055),
    "curvy": dict(bust=0.034, hips=0.034, waist=0.9, arm_out=0.03),
    "older": dict(stoop=1.0, belly=0.02, limb=0.95),
    "hair_none": dict(hair=-0.01),
    "hair_long": dict(hair_long=1.0),
    "hair_bun": dict(bun=1.0),
    "vest": dict(vest=1.0),
    "hoodie": dict(hood=1.0),
    "lanyard": dict(lanyard=1.0),
    "skirt": dict(skirt=1.0),
}


# ------------------------------------------------------------------------------- frames


def adult_frame() -> dict:
    """Joint positions and body tables for the adult (1.77 m before the height scale)."""
    J = {
        "root": (0.0, 0.0, 0.0),
        "hips": (0.0, 0.0, 0.95),
        "spine": (0.0, 0.0, 1.05),
        "chest": (0.0, 0.0, 1.22),
        "neck": (0.0, 0.0, 1.47),
        "head": (0.0, 0.005, 1.56),
        "shoulder_L": (-0.03, 0.0, 1.43),
        "upper_arm_L": (-0.188, -0.005, 1.415),
        "forearm_L": (-0.212, -0.02, 1.13),
        "hand_L": (-0.224, 0.0, 0.875),
        "thigh_L": (-0.095, 0.0, 0.92),
        "shin_L": (-0.1, 0.012, 0.5),
        "foot_L": (-0.1, -0.02, 0.088),
    }
    for k in list(J):
        if k.endswith("_L"):
            x, y, z = J[k]
            J[k[:-2] + "_R"] = (-x, y, z)
    tips = {"head": (0.0, 0.005, 1.775), "hand_L": (-0.228, 0.014, 0.705), "foot_L": (-0.1, 0.15, 0.02)}
    tips["hand_R"] = (-tips["hand_L"][0],) + tips["hand_L"][1:]
    tips["foot_R"] = (-tips["foot_L"][0],) + tips["foot_L"][1:]
    # torso rings: z, half width, front depth, back depth
    torso = [
        (0.835, 0.12, 0.075, 0.085),
        (0.88, 0.16, 0.088, 0.105),
        (0.94, 0.172, 0.094, 0.112),
        (1.0, 0.163, 0.094, 0.098),
        (1.08, 0.148, 0.094, 0.088),
        (1.16, 0.156, 0.1, 0.09),
        (1.24, 0.168, 0.108, 0.094),
        (1.31, 0.177, 0.11, 0.096),
        (1.37, 0.18, 0.104, 0.096),
        (1.415, 0.182, 0.088, 0.09),
        (1.45, 0.15, 0.072, 0.078),
        (1.478, 0.085, 0.062, 0.064),
        (1.52, 0.056, 0.05, 0.052),
        (1.59, 0.05, 0.047, 0.05),
    ]
    return dict(
        J=J, tips=tips, torso=torso,
        waist_z=1.0, collar_z=1.478, belly_z=1.12, bust_z=1.29, hip_z=0.94,
        head_c=(0.0, 0.012, 1.658), head_r=(0.077, 0.095, 0.107),
        arm_r=[(-0.1, 0.0), (-0.075, 0.032), (-0.035, 0.046), (0.0, 0.05), (0.15, 0.048), (0.32, 0.044),
               (0.45, 0.041), (0.5, 0.039), (0.56, 0.041), (0.7, 0.04), (0.88, 0.034), (0.97, 0.033),
               (1.0, 0.037)],
        leg_r=[(-0.16, 0.088), (0.0, 0.086), (0.18, 0.08), (0.36, 0.07), (0.48, 0.06), (0.52, 0.057),
               (0.6, 0.058), (0.7, 0.056), (0.82, 0.05), (0.92, 0.048), (0.97, 0.05), (1.0, 0.052)],
        hand=dict(len=0.17, width=0.078, thick=0.03),
        shoe=dict(heel=-0.075, toe=0.185, width=0.098, height=0.105, sole=0.02),
        hair_long_z=1.4, skirt_z=(1.0, 0.56), vest_z=(0.99, 1.3, 1.445), lanyard_z=(1.47, 1.275),
        badge=(0.058, 0.082, 1.235), scale=1.0, child=False,
    )


def child_frame() -> dict:
    """A child of about seven (1.17 m): a bigger head for the height, shorter legs."""
    a = adult_frame()
    # remap heights through body landmarks: ground, knee, hip, waist, shoulder, neck, head top
    src = [0.0, 0.5, 0.92, 1.0, 1.415, 1.56, 1.775]
    dst = [0.0, 0.31, 0.56, 0.62, 0.88, 0.955, 1.17]

    def mz(z):
        return float(np.interp(z, src, dst))

    def mx(x):
        return x * 0.72

    J = {k: (mx(v[0]), v[1] * 0.75, mz(v[2])) for k, v in a["J"].items()}
    tips = {k: (mx(v[0]), v[1] * 0.75, mz(v[2])) for k, v in a["tips"].items()}
    tips["foot_L"] = (tips["foot_L"][0], 0.105, 0.016)
    tips["foot_R"] = (tips["foot_R"][0], 0.105, 0.016)
    torso = [(mz(z), w * 0.7, f * 0.74, b * 0.74) for (z, w, f, b) in a["torso"]]
    hc = a["head_c"]
    f = dict(a)
    f.update(
        J=J, tips=tips, torso=torso,
        waist_z=mz(1.0), collar_z=mz(1.478), belly_z=mz(1.12), bust_z=mz(1.29), hip_z=mz(0.94),
        head_c=(0.0, hc[1] * 0.8, 1.17 - 0.093), head_r=(0.07, 0.084, 0.093),
        arm_r=[(s, r * 0.68) for s, r in a["arm_r"]],
        leg_r=[(s, r * 0.68) for s, r in a["leg_r"]],
        hand=dict(len=0.12, width=0.058, thick=0.024),
        shoe=dict(heel=-0.055, toe=0.13, width=0.074, height=0.08, sole=0.016),
        hair_long_z=mz(1.4), skirt_z=(mz(1.0), mz(0.6)), vest_z=(mz(0.99), mz(1.3), mz(1.445)),
        lanyard_z=(mz(1.47), mz(1.275)), badge=(0.045, 0.062, mz(1.235)), scale=0.66, child=True,
    )
    return f


# ----------------------------------------------------------------------------- geometry


def _smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _gauss(x, c, s):
    return math.exp(-((x - c) / s) ** 2)


class Geo:
    """Vertices with a slot and up to four bone weights each, and triangles."""

    def __init__(self) -> None:
        self.P: list = []
        self.slot: list[int] = []
        self.W: list[dict] = []
        self.T: list[tuple] = []
        self.parts: list[tuple[str, int, int, int, int]] = []  # name, v0, v1, t0, t1
        self._part = None

    def begin(self, name: str) -> None:
        self._part = (name, len(self.P), len(self.T))

    def end(self, inside) -> None:
        """Close a part. inside(p) -> a point inside the part near p; faces are flipped so they
        face away from it (outward), decided by the majority of the part's faces."""
        name, v0, t0 = self._part
        P = np.asarray(self.P[v0:], dtype=float)
        tris = self.T[t0:]
        if tris:
            score = 0.0
            for (a, b, c) in tris:
                pa, pb, pc = P[a - v0], P[b - v0], P[c - v0]
                n = np.cross(pb - pa, pc - pa)
                ctr = (pa + pb + pc) / 3
                score += float(np.dot(n, ctr - np.asarray(inside(ctr))))
            if score < 0:
                self.T[t0:] = [(a, c, b) for (a, b, c) in tris]
        self.parts.append((name, v0, len(self.P), t0, len(self.T)))
        self._part = None

    def vert(self, p, slot: str, w: dict) -> int:
        self.P.append(tuple(float(c) for c in p))
        self.slot.append(SLOT[slot])
        tot = sum(w.values())
        self.W.append({k: v / tot for k, v in w.items() if v > 1e-6})
        return len(self.P) - 1

    def quad(self, a, b, c, d) -> None:
        self.T.append((a, b, c))
        self.T.append((a, c, d))

    def grid(self, idx, closed: bool) -> None:
        """Quads between consecutive rows of vertex indices (rows the same length)."""
        for r in range(len(idx) - 1):
            n = len(idx[r])
            for c in range(n if closed else n - 1):
                c2 = (c + 1) % n
                self.quad(idx[r][c], idx[r][c2], idx[r + 1][c2], idx[r + 1][c])

    def fan(self, ring, centre: int) -> None:
        n = len(ring)
        for c in range(n):
            self.T.append((ring[c], ring[(c + 1) % n], centre))


def _ring_angles(n):
    return [2 * math.pi * i / n for i in range(n)]


class Body:
    """Analytic body surfaces for one frame + params (the torso, used by every layer)."""

    def __init__(self, F: dict, prm: dict) -> None:
        self.F = F
        self.p = prm
        zs = [r[0] for r in F["torso"]]
        self.zs = zs

    def torso_dims(self, z):
        F, p = self.F, self.p
        t = F["torso"]
        zs = self.zs
        a = float(np.interp(z, zs, [r[1] for r in t]))
        bf = float(np.interp(z, zs, [r[2] for r in t]))
        bb = float(np.interp(z, zs, [r[3] for r in t]))
        k = F["scale"]
        neckish = _smooth(F["collar_z"] - 0.01 * k, F["collar_z"] + 0.03 * k, z)
        g = 1.0 + (p["girth"] - 1.0) * (1.0 - 0.6 * neckish)
        a, bf, bb = a * g, bf * g, bb * g
        sh = _smooth(F["torso"][7][0], F["torso"][9][0], z) * (1 - _smooth(F["torso"][9][0], F["torso"][11][0], z))
        a += p["shoulders"] * sh
        a *= 1.0 + (p["waist"] - 1.0) * _gauss(z, F["waist_z"] + 0.08 * k, 0.07 * k)
        a += p["hips"] * _gauss(z, F["hip_z"], 0.07 * k)
        bb += p["hips"] * 0.8 * _gauss(z, F["hip_z"] - 0.02 * k, 0.06 * k)
        bf += p["belly"] * _gauss(z, F["belly_z"], 0.085 * k)
        a += p["belly"] * 0.35 * _gauss(z, F["belly_z"], 0.1 * k)
        bust = p["bust"] * _gauss(z, F["bust_z"], 0.05 * k)
        return a, bf, bb, bust

    def torso_point(self, z, th, off=0.0):
        """Surface point at height z and angle th (0 = +X, pi/2 = front), pushed out by off."""
        a, bf, bb, bust = self.torso_dims(z)
        c, s = math.cos(th), math.sin(th)
        e = 2.4
        x = a * math.copysign(abs(c) ** (2 / e), c)
        y = (bf if s > 0 else bb) * math.copysign(abs(s) ** (2 / e), s)
        if s > 0:
            y += bust * (s ** 4) * 1.0
        # outward direction: the ring normal, approximated from the ellipse gradient
        nx, ny = x / max(a, 1e-4) ** 2, y / max(bf if s > 0 else bb, 1e-4) ** 2
        ln = math.hypot(nx, ny) or 1.0
        return (x + off * nx / ln, y + off * ny / ln, z)


def _torso_weights(F, z, x):
    J = F["J"]
    k = F["scale"]
    # (centre of the blend, half width, lower bone, upper bone)
    blends = [
        (J["hips"][2] + 0.05 * k, 0.045 * k, "hips", "spine"),
        (J["chest"][2] - 0.1 * k, 0.05 * k, "spine", "chest"),
        (J["neck"][2] + 0.005 * k, 0.025 * k, "chest", "neck"),
    ]
    w = {"hips": 1.0}
    for zc, hw, lower, upper in blends:
        t = float(np.clip((z - (zc - hw)) / (2 * hw), 0.0, 1.0))
        if t <= 0.0:
            break
        val = w.pop(lower, 0.0)
        w[lower] = val * (1 - t)
        w[upper] = w.get(upper, 0.0) + val * t
    w = {b: v for b, v in w.items() if v > 1e-6}
    # shoulder region follows the clavicle (shrugs) and a little of the upper arm
    side = "L" if x < 0 else "R"
    sh = float(_smooth(0.07 * k, 0.15 * k, abs(x)) * _smooth(J["chest"][2] + 0.1 * k, J["upper_arm_L"][2] - 0.01 * k, z))
    if sh > 0 and "chest" in w:
        c = w.pop("chest")
        w["chest"] = c * (1 - sh)
        w[f"shoulder_{side}"] = c * sh * 0.75
        w[f"upper_arm_{side}"] = c * sh * 0.25
    return w


def _frame_for(d):
    """Two unit vectors perpendicular to direction d (u leans toward +Y, the front)."""
    d = np.asarray(d, float)
    d = d / np.linalg.norm(d)
    ref = np.array([0.0, 1.0, 0.0]) if abs(d[1]) < 0.9 else np.array([0.0, 0.0, 1.0])
    u = ref - np.dot(ref, d) * d
    u /= np.linalg.norm(u)
    v = np.cross(d, u)
    return d, u, v


def build(F: dict, prm: dict, res: int = 0) -> Geo:
    """The whole body for frame F and params prm at resolution res (0 = LOD0, 1 = LOD1)."""
    p = dict(BASE_PARAMS)
    p.update(prm)
    B = Body(F, p)
    g = Geo()
    J = F["J"]
    k = F["scale"]
    lo = res > 0

    # ---- torso: three slot bands (trousers, top, neck skin) with duplicated boundary rings
    n_t = 8 if lo else 16
    rows_all = [r[0] for r in F["torso"]]
    if lo:
        rows_all = [rows_all[i] for i in (0, 2, 3, 5, 7, 9, 10, 11, 13)]
    bands = [("bottom", None, F["waist_z"]), ("top", F["waist_z"], F["collar_z"]), ("skin", F["collar_z"], None)]
    angles = _ring_angles(n_t)
    g.begin("torso")
    bottom_ring = None
    for slot, z0, z1 in bands:
        zz = [z for z in rows_all if (z0 is None or z > z0 + 1e-6) and (z1 is None or z < z1 - 1e-6)]
        if z0 is not None:
            zz = [z0] + zz
        if z1 is not None:
            zz = zz + [z1]
        idx = []
        for z in zz:
            row = []
            for th in angles:
                pt = B.torso_point(z, th)
                row.append(g.vert(pt, slot, _torso_weights(F, z, pt[0])))
            idx.append(row)
        g.grid(idx, closed=True)
        if bottom_ring is None:
            bottom_ring = idx[0]
    zc = rows_all[0] - 0.012 * k
    g.fan(bottom_ring, g.vert((0.0, -0.005, zc), "bottom", {"hips": 1.0}))
    g.end(lambda c: (0.0, 0.0, c[2]))

    # ---- head, face, ears
    hc, hr = np.asarray(F["head_c"]), np.asarray(F["head_r"])
    jaw = p["jaw"]

    def head_point(th, ph, off=0.0):
        c, s = math.cos(th), math.sin(th)
        cp, sp = math.cos(ph), math.sin(ph)
        rx, ry, rz = hr
        below = max(0.0, -sp)
        rx *= 1.0 - 0.2 * below / jaw ** 0.5 + 0.06 * (jaw - 1.0)
        ry_f = ry * (1.0 + 0.04 * below) if s > 0 else ry * (1.0 + 0.08 * max(0.0, sp + 0.2))
        x = (rx + off) * cp * c
        y = (ry_f + off) * cp * s
        z = (rz + off) * sp
        if s > 0 and sp < -0.3:
            y += 0.012 * k * (-sp - 0.3)  # chin forward
        return hc + np.array([x, y, z])

    hw = {"head": 1.0}
    g.begin("head")
    n_h, r_h = (8, 5) if lo else (12, 8)
    head_angles = [math.pi / 2 + 2 * math.pi * i / n_h for i in range(n_h)]  # start at the front
    rows = []
    for j in range(1, r_h):
        ph = -math.pi / 2 + math.pi * j / r_h
        rows.append([g.vert(head_point(th, ph), "skin", {"head": 1.0} if ph > -0.9 else {"head": 0.7, "neck": 0.3})
                     for th in head_angles])
    g.grid(rows, closed=True)
    g.fan(list(reversed(rows[0])), g.vert(head_point(0, -math.pi / 2), "skin", {"head": 0.6, "neck": 0.4}))
    g.fan(rows[-1], g.vert(head_point(0, math.pi / 2), "skin", hw))
    g.end(lambda c: tuple(hc))

    # nose: a small wedge on the face
    g.begin("nose")
    nb = [head_point(math.pi / 2 + dx, ph, -0.003) for dx, ph in ((-0.16, -0.12), (0.16, -0.12), (0.0, 0.18))]
    tip = head_point(math.pi / 2, -0.06, 0.018 * k / 0.95)
    ids = [g.vert(q, "skin", hw) for q in nb] + [g.vert(tip, "skin", hw)]
    g.T += [(ids[0], ids[1], ids[3]), (ids[1], ids[2], ids[3]), (ids[2], ids[0], ids[3])]
    g.end(lambda c: tuple(hc))

    # ears: flat ovals on the sides
    g.begin("ears")
    for sx in (-1, 1):
        ctr = hc + np.array([sx * (hr[0] - 0.004), -0.008, -0.004])
        ring = []
        for i in range(6):
            a = 2 * math.pi * i / 6
            ring.append(g.vert(ctr + np.array([sx * 0.012, 0.022 * math.cos(a) * k / 0.95, 0.03 * math.sin(a) * k / 0.95]), "skin", hw))
        g.fan(ring, g.vert(ctr + np.array([sx * 0.02, 0.0, 0.0]), "skin", hw))
    g.end(lambda c: tuple(hc))

    # eyes and brows: small dark ovals and hair-coloured bars, just proud of the face
    g.begin("eyes")
    for sx in (-1, 1):
        th = math.pi / 2 - sx * 0.42
        c0 = head_point(th, 0.1, 0.002)
        q = [head_point(th + du, 0.1 + dv, 0.003) for du, dv in ((-0.07, -0.045), (0.07, -0.045), (0.07, 0.045), (-0.07, 0.045))]
        ids = [g.vert(x, "eyes", hw) for x in q]
        g.quad(*ids)
        del c0
    g.end(lambda c: tuple(hc))
    g.begin("brows")
    for sx in (-1, 1):
        th = math.pi / 2 - sx * 0.42
        q = [head_point(th + du, 0.27 + dv, 0.004) for du, dv in ((-0.13, -0.03), (0.13, -0.01), (0.13, 0.03), (-0.13, 0.03))]
        ids = [g.vert(x, "hair", hw) for x in q]
        g.quad(*ids)
    g.end(lambda c: tuple(hc))

    # ---- hair cap: a shell over the skull; the hairline is lower at the back than the front
    def hairline(th):
        s = math.sin(th)
        return 0.62 * max(s, 0) ** 1.5 - 0.55 * max(-s, 0) ** 1.2 + 0.08

    n_c, r_c = (8, 2) if lo else (12, 4)
    off = p["hair"]
    g.begin("hair")
    rows = []
    for j in range(r_c + 1):
        t = j / (r_c + 1)
        row = []
        for th in head_angles if not lo else [math.pi / 2 + 2 * math.pi * i / n_c for i in range(n_c)]:
            ph = hairline(th) + (math.pi / 2 - hairline(th)) * t
            o = off * (0.45 if j == 0 else 1.0)
            row.append(g.vert(head_point(th, ph, o), "hair", hw))
        rows.append(row)
    g.grid(rows, closed=True)
    g.fan(rows[-1], g.vert(head_point(0, math.pi / 2, off), "hair", hw))
    g.end(lambda c: tuple(hc))

    # ---- long hair: a thick curtain from the hairline at the back to the shoulders
    hl = p["hair_long"]
    n_l = 5 if lo else 9
    r_l = 2 if lo else 4
    g.begin("hair_long")
    outer, inner = [], []
    for j in range(r_l + 1):
        t = j / r_l
        orow, irow = [], []
        for i in range(n_l):
            th = math.radians(150 + 240 * i / (n_l - 1))
            top = head_point(th, hairline(th) + 0.05, off + 0.002)
            zb = F["hair_long_z"]
            r_b = 1.0 + 0.25 * t
            bot = np.array([hc[0] + (hr[0] + 0.035 * k) * r_b * math.cos(th), hc[1] - 0.01 + (hr[1] + 0.02 * k) * r_b * math.sin(th) * 0.95, zb])
            if math.sin(th) > -0.2:  # the front-most columns fall behind the shoulders
                bot[1] -= 0.03 * k
            pt = top + (bot - top) * (t * hl)
            nz = hc - np.array([hc[0], hc[1], pt[2]])
            ins = pt + (np.array([hc[0], hc[1], pt[2]]) - pt) * (0.18 if hl > 0 else 0.05)
            wv = {"head": 1.0} if pt[2] > J["neck"][2] + 0.06 * k else {"head": 0.5, "neck": 0.3, "chest": 0.2}
            orow.append(g.vert(pt, "hair", wv))
            irow.append(g.vert(ins, "hair", wv))
            del nz
        outer.append(orow)
        inner.append(irow)
    g.grid(outer, closed=False)
    g.grid([list(reversed(r)) for r in inner], closed=False)
    g.grid([outer[-1], inner[-1]], closed=False)
    g.end(lambda c: (hc[0], hc[1], c[2]))

    # ---- bun at the back of the head
    bun = p["bun"]
    g.begin("bun")
    b_c = hc + np.array([0.0, -hr[1] * 0.75, hr[2] * 0.55])
    b_r = 0.008 + 0.04 * k / 0.95 * bun
    b_c = b_c + np.array([0.0, -0.03 * bun * k, 0.01 * bun * k])
    nb_s, nb_r = (5, 2) if lo else (8, 4)
    rows = []
    for j in range(1, nb_r):
        ph = -math.pi / 2 + math.pi * j / nb_r
        rows.append([g.vert(b_c + b_r * np.array([math.cos(ph) * math.cos(a), math.cos(ph) * math.sin(a), math.sin(ph)]), "hair", hw)
                     for a in _ring_angles(nb_s)])
    g.grid(rows, closed=True)
    g.fan(list(reversed(rows[0])), g.vert(b_c - np.array([0, 0, b_r]), "hair", hw))
    g.fan(rows[-1], g.vert(b_c + np.array([0, 0, b_r]), "hair", hw))
    g.end(lambda c: tuple(b_c))

    # ---- arms and hands
    for side, sx in (("L", -1), ("R", 1)):
        js, je, jw = (np.asarray(J[f"{b}_{side}"]) for b in ("upper_arm", "forearm", "hand"))
        tip = np.asarray(F["tips"][f"hand_{side}"])
        n_a = 6 if lo else 10
        prof = F["arm_r"] if not lo else [F["arm_r"][i] for i in (1, 3, 5, 7, 9, 12)]
        g.begin(f"arm_{side}")
        rows = []
        top = None
        for s, r0 in prof:
            r = r0 * p["limb"]
            if s < 0.5:
                d = je - js
                c = js + d * s
            else:
                d = jw - je
                c = je + d * (s - 0.5) / 0.5
            dd, u, v = _frame_for(d)
            if s < 0.42:
                w = {f"upper_arm_{side}": 1.0}
                if s < 0.02:
                    w = {f"upper_arm_{side}": 0.65, f"shoulder_{side}": 0.35}
            elif s < 0.58:
                t = (s - 0.42) / 0.16
                w = {f"upper_arm_{side}": 1 - t, f"forearm_{side}": t}
            elif s < 0.96:
                w = {f"forearm_{side}": 1.0}
            else:
                w = {f"forearm_{side}": 0.8, f"hand_{side}": 0.2}
            if r < 1e-6:
                top = g.vert(c, "top", w)
                continue
            rows.append([g.vert(c + r * (math.cos(a) * u * 0.92 + math.sin(a) * v), "top", w) for a in _ring_angles(n_a)])
        g.grid(rows, closed=True)
        if top is not None:
            g.fan(list(reversed(rows[0])), top)
        g.end(lambda c, js=js, je=je, jw=jw: _closest_on_polyline(c, [js + (js - je) * 0.4, je, jw]))

        # hand: a mitten paddle, palm toward the thigh, and a thumb
        h = F["hand"]
        g.begin(f"hand_{side}")
        dh, u, v = _frame_for(tip - jw)
        # u leans forward (+Y): the hand's width; v across: the hand's thickness
        secs = [(0.0, 0.42, 0.75), (0.12, 0.5, 0.85), (0.35, 0.5, 1.0), (0.6, 0.48, 0.95), (0.82, 0.45, 0.85), (0.95, 0.35, 0.6)]
        if lo:
            secs = [secs[0], secs[2], secs[4]]
        n_hs = 6 if lo else 8
        rows = []
        for t, wf, tf in secs:
            c = jw + dh * h["len"] * t
            wv = {f"hand_{side}": 1.0} if t > 0.05 else {f"hand_{side}": 0.7, f"forearm_{side}": 0.3}
            rows.append([g.vert(c + u * (h["width"] * wf * math.cos(a)) + v * (h["thick"] * 0.5 * tf * math.sin(a)) * 1.0, "skin", wv)
                         for a in _ring_angles(n_hs)])
        g.grid(rows, closed=True)
        g.fan(rows[-1], g.vert(jw + dh * h["len"] * 1.0, "skin", {f"hand_{side}": 1.0}))
        g.fan(list(reversed(rows[0])), g.vert(jw + dh * 0.01, "skin", {f"hand_{side}": 0.7, f"forearm_{side}": 0.3}))
        if not lo:
            # thumb: a small tapered prism on the front edge, angled down and in
            base = jw + dh * h["len"] * 0.25 + u * h["width"] * 0.42
            tipp = base + dh * h["len"] * 0.38 + u * h["width"] * 0.1 - v * 0.0
            dt, ut, vt = _frame_for(tipp - base)
            rr = []
            for t, r in ((0.0, 0.013), (1.0, 0.009)):
                cc = base + (tipp - base) * t
                rr.append([g.vert(cc + r * (math.cos(a) * ut + math.sin(a) * vt) * k / 0.95 * 1.05, "skin", {f"hand_{side}": 1.0})
                           for a in _ring_angles(5)])
            g.grid(rr, closed=True)
            g.fan(rr[-1], g.vert(tipp + dt * 0.008, "skin", {f"hand_{side}": 1.0}))
        g.end(lambda c, jw=jw, dh=dh: jw + dh * float(np.clip(np.dot(np.asarray(c) - jw, dh), 0.0, h["len"])))

    # ---- legs (trousers) and shoes
    for side, sx in (("L", -1), ("R", 1)):
        jh, jk, ja = (np.asarray(J[f"{b}_{side}"]) for b in ("thigh", "shin", "foot"))
        n_l2 = 7 if lo else 12
        prof = F["leg_r"] if not lo else [F["leg_r"][i] for i in (0, 2, 4, 6, 8, 11)]
        g.begin(f"leg_{side}")
        rows = []
        for s, r0 in prof:
            r = r0 * (1.0 + (p["limb"] - 1.0) * 0.8)
            if s < 0:
                c = jh + (jh - jk) * (-s) * 0.5
                d = jk - jh
            elif s < 0.5:
                d = jk - jh
                c = jh + d * s / 0.5
            else:
                d = ja - jk
                c = jk + d * (s - 0.5) / 0.5
            if s >= 0.97:
                c = c + np.array([0, 0, 0.012 * k])
            dd, u, v = _frame_for(d)
            if s < 0.03:
                w = {f"thigh_{side}": 0.6, "hips": 0.4}
            elif s < 0.44:
                w = {f"thigh_{side}": 1.0}
            elif s < 0.56:
                t = (s - 0.44) / 0.12
                w = {f"thigh_{side}": 1 - t, f"shin_{side}": t}
            else:
                w = {f"shin_{side}": 1.0}
            hipwide = p["hips"] * 1.2 * max(0.0, 1 - max(s, 0) / 0.35)
            rows.append([g.vert(c + (r + hipwide * 0.5) * (math.cos(a) * u + math.sin(a) * v), "bottom", w)
                         for a in _ring_angles(n_l2)])
        g.grid(rows, closed=True)
        g.fan(rows[-1], g.vert(ja + np.array([0, 0, 0.012 * k]), "bottom", {f"shin_{side}": 1.0}))
        g.end(lambda c, jh=jh, jk=jk, ja=ja: _closest_on_polyline(c, [jh + (jh - jk) * 0.2, jk, ja]))

        sh = F["shoe"]
        g.begin(f"shoe_{side}")
        cx, cy = ja[0], ja[1]
        ys = [sh["heel"], sh["heel"] * 0.6, 0.0, 0.05, 0.1, 0.145, sh["toe"] * 0.97] if not lo else [sh["heel"], 0.0, 0.1, sh["toe"] * 0.95]
        ys = [y * (1.0 if not F["child"] else 1.0) for y in ys]
        n_up = 4 if lo else 6

        def section(y):
            t = (y - sh["heel"]) / (sh["toe"] - sh["heel"])
            wdt = sh["width"] * (0.78 + 0.22 * math.sin(math.pi * min(1.0, t * 1.15))) * 0.5
            top = sh["height"] * (1.0 - 0.62 * _smooth(0.25, 0.95, t)) if t > 0.1 else sh["height"] * (0.85 + 1.5 * t)
            top = max(top, sh["sole"] + 0.03 * k)
            return wdt, top

        def wfoot(y):
            return {f"foot_{side}": 1.0} if y > -0.02 * k else {f"foot_{side}": 0.75, f"shin_{side}": 0.25}

        sole_rows, up_rows = [], []
        for y in ys:
            wd, top = section(y)
            yy = cy + y
            # sole: from the left edge at sole height, down, across the bottom, up the right edge
            srow = [(cx - wd, yy, sh["sole"]), (cx - wd, yy, 0.002), (cx - wd * 0.6, yy, 0.0), (cx + wd * 0.6, yy, 0.0), (cx + wd, yy, 0.002), (cx + wd, yy, sh["sole"])]
            if lo:
                srow = [srow[0], srow[2], srow[3], srow[5]]
            sole_rows.append([g.vert(q, "sole", wfoot(y)) for q in srow])
            urow = []
            for i in range(n_up + 1):
                a = math.pi * i / n_up  # 0 = right edge, pi = left edge, over the top
                urow.append((cx + wd * math.cos(a) * 1.0, yy, sh["sole"] + (top - sh["sole"]) * math.sin(a) ** 0.7))
            up_rows.append([g.vert(q, "shoes", wfoot(y)) for q in urow])
        g.grid(sole_rows, closed=False)
        g.grid(up_rows, closed=False)
        # heel and toe caps
        for rows_, slot in ((sole_rows, "sole"), (up_rows, "shoes")):
            for end, y in ((0, ys[0]), (-1, ys[-1])):
                ring = rows_[end]
                c_id = g.vert((cx, cy + y + (0.012 if end == -1 else -0.008) * k, (sh["sole"] if slot == "shoes" else 0.006) + (0.02 * k if slot == "shoes" else 0.0)), slot, wfoot(y))
                for i in range(len(ring) - 1):
                    g.T.append((ring[i], ring[i + 1], c_id))
        g.end(lambda c, cx=cx, cy=cy: (cx, cy + float(np.clip(c[1] - cy, sh["heel"] * 0.5, sh["toe"] * 0.6)), sh["height"] * 0.4))

    # ---- fleece vest: a puffy shell over the torso with low armholes
    vz0, vz_side, vz_top = F["vest_z"]
    vest = p["vest"]
    g.begin("vest")
    n_v, r_v = (8, 2) if lo else (16, 5)
    rows = []
    for j in range(r_v + 1):
        t = j / r_v
        row = []
        for th in _ring_angles(n_v):
            ztop = vz_side + (vz_top - vz_side) * math.sin(th) ** 2
            z = vz0 + (ztop - vz0) * t
            o = -0.022 * k + vest * (0.04 * k + 0.004 * k * math.sin(6 * t * math.pi))
            pt = B.torso_point(z, th, o)
            row.append(g.vert(pt, "outer", _torso_weights(F, z, pt[0])))
        rows.append(row)
    g.grid(rows, closed=True)
    g.end(lambda c: (0.0, 0.0, c[2]))

    # ---- hoodie: a lowered hood behind the neck and a front pocket
    hood = p["hood"]
    g.begin("hood")
    n_hd, r_hd = (4, 2) if lo else (7, 4)
    neck = np.asarray(J["neck"])
    outer, inner = [], []
    for j in range(r_hd + 1):
        t = j / r_hd
        orow, irow = [], []
        for i in range(n_hd):
            th = math.radians(205 + 130 * i / (n_hd - 1))
            z = neck[2] - 0.075 * k + 0.17 * k * t
            r_full = (0.085 + 0.055 * math.sin(math.pi * t)) * k / 0.95 * 1.05
            r = 0.035 * k + (r_full - 0.035 * k) * hood
            c = np.array([neck[0], neck[1] - 0.02 * k * hood, z])
            pt = c + r * np.array([math.cos(th), math.sin(th) * 1.15, 0.0])
            wv = {"chest": 0.6, "neck": 0.4} if t < 0.5 else {"neck": 0.7, "chest": 0.3}
            orow.append(g.vert(pt, "top", wv))
            irow.append(g.vert(c + (r * 0.7) * np.array([math.cos(th), math.sin(th) * 1.15, 0.0]), "top", wv))
        outer.append(orow)
        inner.append(irow)
    g.grid(outer, closed=False)
    g.grid([list(reversed(r)) for r in inner], closed=False)
    g.grid([outer[-1], inner[-1]], closed=False)
    g.end(lambda c: (neck[0], neck[1], c[2]))
    g.begin("pocket")
    pz0, pz1 = F["waist_z"] + 0.04 * k, F["waist_z"] + 0.17 * k
    rows = []
    for z in (pz0, pz1):
        row = []
        for th in (math.radians(62), math.radians(90), math.radians(118)):
            row.append(g.vert(B.torso_point(z, th, -0.02 * k + 0.03 * k * hood), "top", _torso_weights(F, z, 0.0)))
        rows.append(row)
    g.grid(rows, closed=False)
    g.end(lambda c: (0.0, 0.0, c[2]))

    # ---- lanyard: two straps from the collar to a badge on the chest
    lan = p["lanyard"]
    lz0, lz1 = F["lanyard_z"]
    bw, bh, bz = F["badge"]
    if not lo:
        g.begin("lanyard")
        for sx in (-1, 1):
            rows = []
            for j in range(4):
                t = j / 3
                z = lz0 + (lz1 + bh * 0.5 - lz0) * t
                th0 = math.radians(90 + sx * (40 - 38 * t))
                strip = []
                for dth in (-0.06, 0.06):
                    o = -0.025 * k + lan * (0.031 * k)
                    strip.append(g.vert(B.torso_point(z, th0 + dth * (1 - 0.5 * t), o), "accent", _torso_weights(F, z, 0.0)))
                rows.append(strip)
            g.grid(rows, closed=False)
        g.end(lambda c: (0.0, 0.0, c[2]))
    g.begin("badge")
    rows = []
    for z in (bz - bh / 2, bz + bh / 2):
        row = []
        for dx in (-bw / 2, bw / 2):
            th = math.pi / 2 - dx / 0.11
            o = -0.03 * k + lan * (0.04 * k)
            row.append(g.vert(B.torso_point(z, th, o), "badge", _torso_weights(F, z, 0.0)))
        rows.append(row)
    g.grid(rows, closed=False)
    g.end(lambda c: (0.0, 0.0, c[2]))

    # ---- skirt: an A-line cone from the waist to above the knee
    skirt = p["skirt"]
    sz0, sz1 = F["skirt_z"]
    g.begin("skirt")
    n_s, r_s = (8, 2) if lo else (16, 4)
    rows = []
    for j in range(r_s + 1):
        t = j / r_s
        row = []
        for th in _ring_angles(n_s):
            top = np.asarray(B.torso_point(sz0, th, 0.012 * k))
            a0, bf0, bb0, _ = B.torso_dims(sz0)
            flare = np.array([math.cos(th) * (a0 + 0.06 * k), math.sin(th) * ((bf0 if math.sin(th) > 0 else bb0) + 0.07 * k), sz1])
            worn = top + (flare - top) * t
            hidden = np.asarray(B.torso_point(sz0 - 0.09 * k * t, th, -0.03 * k))
            pt = hidden + (worn - hidden) * skirt
            tl = t * 0.6
            fl = float(np.clip(0.5 - pt[0] / (0.16 * k), 0.0, 1.0))
            row.append(g.vert(pt, "bottom", {"hips": 1 - tl, "thigh_L": tl * fl, "thigh_R": tl * (1 - fl)}))
        rows.append(row)
    g.grid(rows, closed=True)
    g.end(lambda c: (0.0, 0.0, c[2]))

    # ---- heavier builds hold their arms out a little, clear of the hips
    if p["arm_out"] != 0.0:
        P = np.asarray(g.P)
        for name, v0, v1, _, _ in g.parts:
            if name.startswith(("arm_", "hand_")):
                sx = -1.0 if name.endswith("_L") else 1.0
                js = J[f"upper_arm_{name[-1]}"]
                jw = J[f"hand_{name[-1]}"]
                f = _smooth(js[2], jw[2], P[v0:v1, 2]) if js[2] < jw[2] else _smooth(jw[2], js[2], P[v0:v1, 2])
                f = 1.0 - f if js[2] > jw[2] else f
                P[v0:v1, 0] += sx * p["arm_out"] * k * f
        g.P = [tuple(r) for r in P]

    # ---- posture (older): the upper body leans forward, the head juts out
    if p["stoop"] != 0.0:
        P = np.asarray(g.P)
        s = p["stoop"]
        zz = P[:, 2]
        P[:, 1] += s * (0.04 * k * _smooth(J["spine"][2], J["neck"][2], zz) + 0.02 * k * _smooth(J["neck"][2], J["head"][2] + 0.05 * k, zz))
        P[:, 2] -= s * 0.018 * k * _smooth(J["chest"][2], J["head"][2], zz)
        g.P = [tuple(r) for r in P]
    return g


def _closest_on_polyline(c, pts):
    c = np.asarray(c, float)
    best, bd = None, 1e9
    for a, b in zip(pts, pts[1:]):
        a, b = np.asarray(a, float), np.asarray(b, float)
        d = b - a
        t = float(np.clip(np.dot(c - a, d) / np.dot(d, d), 0.0, 1.0))
        q = a + d * t
        dd = float(np.linalg.norm(c - q))
        if dd < bd:
            best, bd = q, dd
    return best


# ------------------------------------------------------------------- arrays and normals


def arrays(g: Geo):
    """Positions (V,3), triangles (T,3), slots (V,), joint indices (V,4), weights (V,4)."""
    P = np.asarray(g.P, dtype=np.float64)
    T = np.asarray(g.T, dtype=np.int64)
    S = np.asarray(g.slot, dtype=np.int64)
    idx = np.zeros((len(P), 4), dtype=np.int64)
    wts = np.zeros((len(P), 4), dtype=np.float64)
    for i, w in enumerate(g.W):
        items = sorted(w.items(), key=lambda kv: -kv[1])[:4]
        tot = sum(v for _, v in items)
        for j, (b, v) in enumerate(items):
            idx[i, j] = BONE_INDEX[b]
            wts[i, j] = v / tot
    return P, T, S, idx, wts


def vertex_normals(P: np.ndarray, T: np.ndarray) -> np.ndarray:
    """Area-weighted vertex normals (unit; degenerate ones point up)."""
    a, b, c = P[T[:, 0]], P[T[:, 1]], P[T[:, 2]]
    fn = np.cross(b - a, c - a)
    N = np.zeros_like(P)
    for k in range(3):
        np.add.at(N, T[:, k], fn)
    ln = np.linalg.norm(N, axis=1)
    bad = ln < 1e-12
    N[bad] = (0.0, 0.0, 1.0)
    ln[bad] = 1.0
    return N / ln[:, None]


def key_geometry(F: dict, res: int):
    """Base positions and every key's position delta, plus the topology."""
    base = build(F, {}, res)
    P0, T, S, idx, wts = arrays(base)
    deltas = []
    for key in KEYS:
        prm = dict(KEY_PARAMS[key])
        P1 = np.asarray(build(F, prm, res).P, dtype=np.float64)
        if P1.shape != P0.shape:
            raise AssertionError(f"{key}: topology changed ({P1.shape} vs {P0.shape})")
        deltas.append(P1 - P0)
    return dict(P=P0, T=T, S=S, idx=idx, wts=wts, deltas=np.asarray(deltas), parts=base.parts)


def variant_positions(geo: dict, weights: dict) -> np.ndarray:
    P = geo["P"].copy()
    for k, key in enumerate(KEYS):
        w = weights.get(key, 0.0)
        if w:
            P += w * geo["deltas"][k]
    return P


# ------------------------------------------------------------------------- the skeleton


def _rot(rx, ry, rz):
    """Rotation matrix Rz @ Ry @ Rx (degrees): X is applied first."""
    ax, ay, az = (math.radians(v) for v in (rx, ry, rz))
    cx, sx, cy, sy, cz, sz = math.cos(ax), math.sin(ax), math.cos(ay), math.sin(ay), math.cos(az), math.sin(az)
    Rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Rz @ Ry @ Rx


def bone_globals(F: dict, pose: dict) -> np.ndarray:
    """(B,4,4) skinning matrices: rest-space -> posed-space for each bone.

    pose: {bone: (rx, ry, rz) degrees} and optionally "hips_t": (x, y, z) metres.
    G_b = G_parent @ T(j_b) @ R_b @ T(-j_b); the hips also translate by hips_t.
    """
    J = F["J"]
    G = np.zeros((len(BONES), 4, 4))
    for i, (b, parent) in enumerate(BONES):
        L = np.eye(4)
        j = np.asarray(J[b])
        R = _rot(*pose.get(b, (0.0, 0.0, 0.0)))
        L[:3, :3] = R
        L[:3, 3] = j - R @ j
        if b == "hips" and "hips_t" in pose:
            L[:3, 3] += np.asarray(pose["hips_t"])
        G[i] = L if parent is None else G[BONE_INDEX[parent]] @ L
    return G


def skin(P: np.ndarray, idx: np.ndarray, wts: np.ndarray, G: np.ndarray):
    """Linear blend skinning. Returns posed positions (V,3) and each vertex's blended
    rotation as a unit quaternion (V,4, w last, w >= 0) from the polar decomposition."""
    M = np.einsum("vk,vkij->vij", wts, G[idx])  # (V,4,4)
    Ph = np.concatenate([P, np.ones((len(P), 1))], axis=1)
    out = np.einsum("vij,vj->vi", M, Ph)[:, :3]
    A = M[:, :3, :3]
    U, _, Vt = np.linalg.svd(A)
    R = U @ Vt
    neg = np.linalg.det(R) < 0
    if np.any(neg):
        U[neg, :, -1] *= -1
        R[neg] = U[neg] @ Vt[neg]
    return out, mat_to_quat(R)


def mat_to_quat(R: np.ndarray) -> np.ndarray:
    """(N,3,3) rotation matrices -> (N,4) quaternions (x, y, z, w), w >= 0."""
    m = R
    tr = m[:, 0, 0] + m[:, 1, 1] + m[:, 2, 2]
    q = np.zeros((len(m), 4))
    w = np.sqrt(np.maximum(0.0, 1 + tr)) / 2
    x = np.sqrt(np.maximum(0.0, 1 + m[:, 0, 0] - m[:, 1, 1] - m[:, 2, 2])) / 2
    y = np.sqrt(np.maximum(0.0, 1 - m[:, 0, 0] + m[:, 1, 1] - m[:, 2, 2])) / 2
    z = np.sqrt(np.maximum(0.0, 1 - m[:, 0, 0] - m[:, 1, 1] + m[:, 2, 2])) / 2
    x = np.copysign(x, m[:, 2, 1] - m[:, 1, 2])
    y = np.copysign(y, m[:, 0, 2] - m[:, 2, 0])
    z = np.copysign(z, m[:, 1, 0] - m[:, 0, 1])
    q[:, 0], q[:, 1], q[:, 2], q[:, 3] = x, y, z, w
    q /= np.linalg.norm(q, axis=1)[:, None]
    q[q[:, 3] < 0] *= -1
    return q


def quat_rotate(q: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Rotate vectors v (N,3) by quaternions q (N,4, x y z w)."""
    u = q[:, :3]
    w = q[:, 3:4]
    t = 2 * np.cross(u, v)
    return v + w * t + np.cross(u, t)
