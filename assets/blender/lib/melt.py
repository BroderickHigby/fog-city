"""The melt sequence as shape keys: seize -> slump -> melt (design.md, Combat: water and rust).

Each key is a deformation of the whole robot in model space at rest (Blender frame: +Y front,
+Z up, ground at z = 0), turned into per-part shape keys by fc.add_deform_keys. The renderer
blends them in order (see assets/blender/README.md, "Melting and rust"):

  seized   (0.5 s): seize 0 -> 1                      joints lock, a stiff hunch, head tilts
  slumping (1.5 s): seize 1 -> 0 and slump 0 -> 1 over the first half,
                    slump 1 -> 0 and melt 0 -> 1 over the second
  heap:             swap to a heap prop (heap-*.glb), which matches the melt shape

Cartoon, not gore: the shell sags and spreads into a rusty mound, nothing breaks off.
"""

from __future__ import annotations

import numpy as np


def _smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _rotate_about(P, pivot, axis, angle, mask):
    """Rotate the points where mask is set about an axis ('x' or 'y') through pivot."""
    c, s = np.cos(angle), np.sin(angle)
    Q = P.copy()
    d = P - pivot
    if axis == "x":  # pitch: +angle tips +Z toward +Y (forward)
        y = d[:, 1] * c + d[:, 2] * s
        z = -d[:, 1] * s + d[:, 2] * c
        Q[:, 1] = np.where(mask, pivot[1] + y, P[:, 1])
        Q[:, 2] = np.where(mask, pivot[2] + z, P[:, 2])
    else:  # roll: +angle tips +Z toward +X (the robot's right)
        x = d[:, 0] * c + d[:, 2] * s
        z = -d[:, 0] * s + d[:, 2] * c
        Q[:, 0] = np.where(mask, pivot[0] + x, P[:, 0])
        Q[:, 2] = np.where(mask, pivot[2] + z, P[:, 2])
    return Q


def keys(height: float, neck_z: float | None, heap_r: float, heap_h: float, centre=(0.0, 0.0)):
    """[(name, fn)] for seize, slump and melt. neck_z: where a head starts (None: no head)."""
    H = float(height)
    cx, cy = centre

    def seize(P):
        P = np.asarray(P, dtype=np.float64).copy()
        s = np.clip(P[:, 2] / H, 0.0, 1.0)
        P[:, 2] *= 0.975
        P[:, 0] = cx + (P[:, 0] - cx) * (1.0 - 0.06 * _smooth(0.3, 0.8, s))
        P[:, 1] += 0.025 * H * _smooth(0.5, 1.0, s)
        if neck_z is not None:
            m = P[:, 2] > neck_z * 0.975
            P = _rotate_about(P, np.array([cx, cy + 0.025 * H * _smooth(0.5, 1.0, neck_z / H), neck_z * 0.975]), "y", np.radians(12.0), m)
        return P

    def slump(P):
        P0 = np.asarray(P, dtype=np.float64)
        P = P0.copy()
        s = np.clip(P0[:, 2] / H, 0.0, 1.0)
        bulge = 1.0 + 0.7 * s * (1.0 - s)
        P[:, 0] = cx + (P0[:, 0] - cx) * bulge + 0.04 * H * s**2
        P[:, 1] = cy + (P0[:, 1] - cy) * bulge + 0.09 * H * s**2
        P[:, 2] = P0[:, 2] * (0.8 - 0.12 * s)
        if neck_z is not None:
            sn = neck_z / H
            pivot = np.array([cx + 0.04 * H * sn**2, cy + 0.09 * H * sn**2, neck_z * (0.8 - 0.12 * sn)])
            m = P0[:, 2] > neck_z
            P = _rotate_about(P, pivot, "x", np.radians(38.0), m)
            P = _rotate_about(P, pivot, "y", np.radians(10.0), m)
        return P

    def melt(P):
        P0 = np.asarray(P, dtype=np.float64)
        s = np.clip(P0[:, 2] / H, 0.0, 1.0)
        dx, dy = P0[:, 0] - cx, P0[:, 1] - cy
        r = np.hypot(dx, dy)
        # a soft-serve swirl: lower parts turn further, so limbs wrap round the mound
        ang = np.arctan2(dy, dx) + 1.4 * (1.0 - s) ** 1.5
        lobes = 0.85 + 0.15 * np.cos(3.0 * ang + 0.7) * np.cos(2.0 * ang)
        r2 = r * 0.3 + heap_r * (1.0 - s) ** 0.75 * lobes
        Q = np.empty_like(P0)
        Q[:, 0] = cx + np.cos(ang) * r2
        Q[:, 1] = cy + np.sin(ang) * r2
        Q[:, 2] = heap_h * s**0.9 * (1.0 - 0.3 * (r2 / max(heap_r, 1e-6)) ** 2).clip(0.15, 1.0)
        if neck_z is not None:
            sn = neck_z / H
            pz = heap_h * sn**0.9 * 0.85
            m = P0[:, 2] > neck_z
            Q = _rotate_about(Q, np.array([cx, cy, pz]), "y", np.radians(62.0), m)
            Q[:, 2] = np.where(m, np.maximum(Q[:, 2], pz * 0.6), Q[:, 2])
        Q[:, 2] = np.maximum(Q[:, 2], 0.0)
        return Q

    return [("seize", seize), ("slump", slump), ("melt", melt)]


def weights(state: str, t: float) -> tuple[float, float, float]:
    """(seize, slump, melt) morph weights for a melt state and the seconds spent in it."""
    if state == "seized":
        return (min(max(t / 0.5, 0.0), 1.0), 0.0, 0.0)
    if state == "slumping":
        u = min(max(t / 1.5, 0.0), 1.0)
        if u < 0.5:
            return (1.0 - 2 * u, 2 * u, 0.0)
        return (0.0, 2.0 - 2 * u, 2 * u - 1.0)
    if state == "heap":
        return (0.0, 0.0, 1.0)
    return (0.0, 0.0, 0.0)
