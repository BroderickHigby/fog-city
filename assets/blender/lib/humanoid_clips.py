"""The humanoid clip library: procedural poses over time for the rig in humanoid.py.

A pose is {bone: (rx, ry, rz) degrees, "hips_t": (x, y, z) metres} in the rig's world-aligned
joint frames (see humanoid.py). Every clip is a function of time; `sample(clip, frame, t)`
returns the pose with the hips height solved so the feet meet the ground (walk, idle, talk,
wet shake, run, aim), or a scripted clearance (dive), or the bench seat (sit).

Clips (crowd VAT and the player):  walk, idle, dive, wet_shake, sit, talk
Player only:                       run, aim
"""

from __future__ import annotations

import math

import numpy as np

import humanoid as H

TAU = 2 * math.pi


def _bump(x, c, w):
    """Periodic gaussian bump on the unit circle (x, c in cycles)."""
    d = ((x - c + 0.5) % 1.0) - 0.5
    return math.exp(-((d / w) ** 2))


def _ease(t):
    t = min(max(t, 0.0), 1.0)
    return 0.5 - 0.5 * math.cos(math.pi * t)


def neutral() -> dict:
    """Standing, arms relaxed at the sides, elbows soft."""
    return {
        "upper_arm_L": (2.0, 5.0, 0.0),
        "upper_arm_R": (2.0, -5.0, 0.0),
        "forearm_L": (10.0, 0.0, 0.0),
        "forearm_R": (10.0, 0.0, 0.0),
    }


def _add(pose: dict, bone: str, rx=0.0, ry=0.0, rz=0.0) -> None:
    a = pose.get(bone, (0.0, 0.0, 0.0))
    pose[bone] = (a[0] + rx, a[1] + ry, a[2] + rz)


def _leg(pose, side, hip, knee, foot_world, roll=0.0):
    """Hip flexion (+ forward), knee flexion (+ bent), and the foot's world pitch."""
    _add(pose, f"thigh_{side}", hip, roll)
    _add(pose, f"shin_{side}", -knee)
    _add(pose, f"foot_{side}", foot_world - hip + knee)


# ---------------------------------------------------------------------------------- walk


def walk(t: float, T: float = 1.0, amp: float = 1.0) -> dict:
    ph = (t / T) % 1.0
    p = neutral()
    for side, off in (("L", 0.0), ("R", 0.5)):
        s = (ph + off) % 1.0
        hip = amp * (20.0 * math.cos(TAU * s) + 2.0)
        knee = 4.0 + amp * (12.0 * _bump(s, 0.1, 0.09) + 58.0 * _bump(s, 0.72, 0.15))
        # the foot: heel strike toe-up, flat through stance, push off, toe clear in swing
        foot = 14.0 * _bump(s, 0.0, 0.05) - 28.0 * _bump(s, 0.58, 0.07) + 4.0 * _bump(s, 0.85, 0.08)
        _leg(p, side, hip, knee, foot)
        sx = -1.0 if side == "L" else 1.0
        arm = -amp * 19.0 * math.cos(TAU * s)
        _add(p, f"upper_arm_{side}", arm, 0.0, sx * 3.0 * math.sin(TAU * s))
        _add(p, f"forearm_{side}", 8.0 + amp * 10.0 * max(0.0, math.cos(TAU * s + math.pi)))
    _add(p, "hips", 0.0, 2.5 * math.sin(TAU * ph * 2), 5.0 * math.sin(TAU * ph))
    _add(p, "spine", -3.0, 0.0, -3.0 * math.sin(TAU * ph))
    _add(p, "chest", -1.0 + 1.0 * math.cos(TAU * ph * 2), -1.5 * math.sin(TAU * ph * 2), -4.0 * math.sin(TAU * ph))
    _add(p, "head", 3.0 - 1.5 * math.cos(TAU * ph * 2), 0.0, 2.0 * math.sin(TAU * ph))
    return p


def run(t: float, T: float = 0.7) -> dict:
    ph = (t / T) % 1.0
    p = {}
    for side, off in (("L", 0.0), ("R", 0.5)):
        s = (ph + off) % 1.0
        hip = 38.0 * math.cos(TAU * s) + 12.0
        knee = 18.0 + 22.0 * _bump(s, 0.12, 0.08) + 95.0 * _bump(s, 0.68, 0.16)
        foot = 10.0 * _bump(s, 0.0, 0.05) - 35.0 * _bump(s, 0.5, 0.07)
        _leg(p, side, hip, knee, foot)
        sx = -1.0 if side == "L" else 1.0
        _add(p, f"upper_arm_{side}", -42.0 * math.cos(TAU * s) + 5.0, sx * -6.0, sx * 8.0 * math.sin(TAU * s))
        _add(p, f"forearm_{side}", 85.0 + 15.0 * math.cos(TAU * s + math.pi))
    _add(p, "hips", -6.0, 0.0, 8.0 * math.sin(TAU * ph))
    _add(p, "spine", -6.0, 0.0, -5.0 * math.sin(TAU * ph))
    _add(p, "chest", -2.0, 0.0, -7.0 * math.sin(TAU * ph))
    _add(p, "head", 12.0, 0.0, 3.0 * math.sin(TAU * ph))
    return p


# ---------------------------------------------------------------------------------- idle


def idle(t: float, T: float = 3.0) -> dict:
    ph = (t / T) % 1.0
    p = neutral()
    breathe = math.sin(TAU * ph * 2)
    shift = math.sin(TAU * ph)
    _add(p, "hips", 0.0, 2.2 * shift, 2.0 * math.sin(TAU * ph + 0.6))
    _add(p, "spine", 0.0, -1.4 * shift, 0.0)
    _add(p, "chest", -0.8 * breathe, -0.8 * shift, -1.5 * math.sin(TAU * ph + 0.6))
    for side, sx in (("L", -1.0), ("R", 1.0)):
        _add(p, f"thigh_{side}", 0.0, -2.2 * shift, 0.0)
        _add(p, f"shin_{side}", -2.0 - 2.0 * (1 + sx * shift))
        _add(p, f"foot_{side}", 1.0 + 1.0 * (1 + sx * shift))
        _add(p, f"shoulder_{side}", 0.0, sx * -0.8 * breathe, 0.0)
        _add(p, f"upper_arm_{side}", 1.5 * math.sin(TAU * ph + sx), 0.0, 0.0)
    _add(p, "head", 2.0 * math.sin(TAU * ph * 2 + 1.0), 0.0, 9.0 * math.sin(TAU * ph) * _ease(1.0))
    return p


# ---------------------------------------------------------------------------------- talk


def talk(t: float, T: float = 3.0) -> dict:
    """Standing in conversation (or pitching): the right hand gestures, nods, a shrug."""
    ph = (t / T) % 1.0
    p = idle(t, T)
    _add(p, "upper_arm_R", 22.0 + 10.0 * math.sin(TAU * ph * 2), -8.0, 6.0)
    _add(p, "forearm_R", 58.0 + 18.0 * math.sin(TAU * ph * 3 + 0.4), 0.0, 10.0 * math.sin(TAU * ph * 2))
    _add(p, "hand_R", 10.0 * math.sin(TAU * ph * 3 + 1.4), 0.0, 15.0 * math.sin(TAU * ph * 2 + 0.3))
    _add(p, "upper_arm_L", 10.0 + 9.0 * math.sin(TAU * (ph + 0.3)), 4.0, 0.0)
    _add(p, "forearm_L", 30.0 + 22.0 * max(0.0, math.sin(TAU * (ph * 2 + 0.15))), 0.0, 0.0)
    shrug = _bump(ph, 0.62, 0.05)
    for side, sx in (("L", -1.0), ("R", 1.0)):
        _add(p, f"shoulder_{side}", 0.0, sx * -9.0 * shrug, 0.0)
    _add(p, "head", -5.0 * math.sin(TAU * ph * 3), 0.0, 7.0 * math.sin(TAU * ph))
    _add(p, "chest", 0.0, 0.0, 5.0 * math.sin(TAU * ph))
    return p


# ----------------------------------------------------------------------------------- sit


SEAT_HEIGHT = 0.45


def sit(t: float, T: float = 2.0, flex: float = 90.0) -> dict:
    """Seated on a bench (seat 0.45 m): thighs on the seat, shins straight down to flat feet,
    hands on the thighs. flex: the hip flexion that puts the feet on the ground (sit_pose)."""
    ph = (t / T) % 1.0
    p = {}
    for side, sx in (("L", -1.0), ("R", 1.0)):
        _leg(p, side, flex, flex, 0.0, roll=sx * -3.0)
        _add(p, f"upper_arm_{side}", 24.0, sx * -4.0, 0.0)
        _add(p, f"forearm_{side}", 50.0, 0.0, sx * 8.0)
        _add(p, f"hand_{side}", -20.0, 0.0, 0.0)
        _add(p, f"shoulder_{side}", 0.0, sx * 0.8 * math.sin(TAU * ph), 0.0)
    _add(p, "spine", 6.0, 0.0, 0.0)
    _add(p, "chest", -3.0 - 1.0 * math.sin(TAU * ph), 0.0, 0.0)
    _add(p, "head", -4.0 + 1.5 * math.sin(TAU * ph + 0.5), 0.0, 4.0 * math.sin(TAU * ph))
    return p


# ---------------------------------------------------------------------------------- dive


def _keyed(keys, t):
    """Ease between keyframes [(time, pose, clearance, hips_x)]."""
    if t <= keys[0][0]:
        return keys[0][1:], 0.0
    for (t0, p0, c0, x0), (t1, p1, c1, x1) in zip(keys, keys[1:]):
        if t <= t1:
            u = _ease((t - t0) / (t1 - t0))
            bones = set(p0) | set(p1)
            pose = {}
            for b in bones:
                a = p0.get(b, (0.0, 0.0, 0.0))
                c = p1.get(b, (0.0, 0.0, 0.0))
                pose[b] = tuple(a[i] + (c[i] - a[i]) * u for i in range(3))
            return (pose, c0 + (c1 - c0) * u, x0 + (x1 - x0) * u), u
    return keys[-1][1:], 1.0


def _p(**kw):
    out = neutral()
    for k, v in kw.items():
        out[k] = v
    return out


DIVE_DX = -1.25

DIVE_KEYS = [
    (0.0, _p(), 0.0, 0.0),
    (0.16, _p(hips=(0, -12, 0), spine=(-14, 0, 0), thigh_L=(38, 0, 0), thigh_R=(38, 0, 0), shin_L=(-62, 0, 0), shin_R=(-62, 0, 0),
              foot_L=(24, 0, 0), foot_R=(24, 0, 0), upper_arm_L=(-35, 12, 0), upper_arm_R=(-35, -12, 0)), 0.0, 0.05),
    (0.38, _p(hips=(0, -72, 0), spine=(-6, 0, 0), thigh_L=(-6, 6, 0), thigh_R=(-14, -4, 0), shin_L=(-20, 0, 0), shin_R=(-35, 0, 0),
              upper_arm_L=(165, 14, 0), upper_arm_R=(160, -20, 0), forearm_L=(10, 0, 0), forearm_R=(15, 0, 0), head=(14, 0, 0)), 0.32, -0.6),
    (0.6, _p(hips=(0, -88, 0), spine=(-4, 0, 0), thigh_L=(10, 6, 0), thigh_R=(25, -6, 0), shin_L=(-30, 0, 0), shin_R=(-55, 0, 0),
             upper_arm_L=(150, 25, 0), upper_arm_R=(150, -30, 0), forearm_L=(25, 0, 0), forearm_R=(25, 0, 0), head=(18, 0, -10)), 0.0, -1.05),
    (0.82, _p(hips=(0, -86, 0), spine=(-8, 0, 0), thigh_L=(30, 6, 0), thigh_R=(45, -6, 0), shin_L=(-60, 0, 0), shin_R=(-80, 0, 0),
              upper_arm_L=(95, 30, 0), upper_arm_R=(110, -30, 0), forearm_L=(60, 0, 0), forearm_R=(55, 0, 0), head=(20, 0, -20)), 0.0, -1.2),
    (1.12, _p(hips=(-10, -35, 0), spine=(-22, 0, 0), thigh_L=(75, 4, 0), thigh_R=(20, -4, 0), shin_L=(-110, 0, 0), shin_R=(-95, 0, 0),
              foot_L=(30, 0, 0), foot_R=(60, 0, 0), upper_arm_L=(40, 20, 0), upper_arm_R=(50, -25, 0), forearm_L=(30, 0, 0), forearm_R=(30, 0, 0)), 0.0, -1.25),
    (1.42, _p(hips=(0, -6, 0), spine=(-10, 0, 0), thigh_L=(22, 0, 0), thigh_R=(12, 0, 0), shin_L=(-35, 0, 0), shin_R=(-22, 0, 0),
              foot_L=(13, 0, 0), foot_R=(10, 0, 0), upper_arm_L=(10, 8, 0), upper_arm_R=(20, -8, 0)), 0.0, -1.25),
    (1.62, _p(upper_arm_R=(28, -10, 0), forearm_R=(75, 0, 18), hand_R=(0, 0, 25), head=(-6, 0, 12)), 0.0, -1.25),
    (1.8, _p(upper_arm_R=(8, -6, 0), forearm_R=(20, 0, 0), head=(0, 0, 0)), 0.0, -1.25),
]


def dive(t: float) -> tuple[dict, float]:
    """A slapstick hop aside to the person's left (-X): crouch, dive, land on their side,
    roll up to a kneel, stand and brush off. Returns the pose and the clearance (height of the
    lowest point above the ground)."""
    (pose, clearance, hx), _ = _keyed(DIVE_KEYS, t)
    pose = dict(pose)
    pose["hips_t"] = (hx, 0.0, 0.0)
    return pose, clearance


# ----------------------------------------------------------------------------- wet shake


def wet_shake(t: float) -> dict:
    """Got wet: shoulders up, arms out, shake the water off the hands, head shake, an
    exasperated drop of the arms. Annoyed, never hurt."""
    p = neutral()
    up = _ease(t / 0.15) * (1 - _ease((t - 1.15) / 0.3))
    shake = up * math.sin(TAU * 5.0 * t)
    head = up * math.sin(TAU * 3.5 * t)
    for side, sx in (("L", -1.0), ("R", 1.0)):
        _add(p, f"shoulder_{side}", 0.0, sx * -14.0 * up, 0.0)
        _add(p, f"upper_arm_{side}", 12.0 * up, sx * -32.0 * up + sx * -6.0 * shake, 0.0)
        _add(p, f"forearm_{side}", 45.0 * up + 10.0 * shake, 0.0, sx * 22.0 * shake)
        _add(p, f"hand_{side}", -30.0 * up * math.sin(TAU * 5.0 * t + 0.8), 0.0, 0.0)
        _add(p, f"thigh_{side}", 6.0 * up, 0.0, 0.0)
        _add(p, f"shin_{side}", -10.0 * up - 4.0 * up * abs(math.sin(TAU * 2.5 * t)))
        _add(p, f"foot_{side}", 4.0 * up, 0.0, 0.0)
    _add(p, "chest", -4.0 * up, 0.0, 6.0 * up * math.sin(TAU * 2.5 * t))
    _add(p, "head", -6.0 * up, 0.0, 16.0 * head)
    # the exasperated end: a sigh, head drops then lifts
    sigh = _bump(min(t / 1.6, 0.999), 0.85, 0.08)
    _add(p, "head", 12.0 * sigh, 0.0, 0.0)
    _add(p, "chest", 4.0 * sigh, 0.0, 0.0)
    return p


# ----------------------------------------------------------------------------------- aim


def aim(t: float, T: float = 2.0) -> dict:
    """Player only: both hands forward on the water blaster's wand, stance braced."""
    ph = (t / T) % 1.0
    br = math.sin(TAU * ph)
    p = {}
    _add(p, "upper_arm_R", 72.0 + 1.0 * br, 14.0, 0.0)
    _add(p, "forearm_R", 18.0, 0.0, 0.0)
    _add(p, "hand_R", -8.0, 0.0, 0.0)
    _add(p, "upper_arm_L", 64.0 + 1.0 * br, -32.0, 0.0)
    _add(p, "forearm_L", 40.0, 0.0, -10.0)
    _add(p, "chest", -2.0 - 0.8 * br, 0.0, -8.0)
    _add(p, "head", 2.0, 0.0, 8.0)
    for side, sx in (("L", -1.0), ("R", 1.0)):
        _leg(p, side, 8.0 if side == "L" else -6.0, 10.0, 0.0, roll=sx * -6.0)
    return p


# ------------------------------------------------------------------------------ clip table

# name: (duration s, loop, crowd fps, player, crowd, child)
CLIPS = {
    "walk": (1.0, True, 20, True, True, True),
    "idle": (3.0, True, 6, True, True, True),
    "dive": (1.8, False, 16, True, True, False),
    "wet_shake": (1.6, False, 20, True, True, False),
    "sit": (2.0, True, 6, True, True, True),
    "talk": (3.0, True, 8, True, True, True),
    "run": (0.7, True, 30, True, False, False),
    "aim": (2.0, True, 15, True, False, False),
}
CHILD_WALK_T = 0.8


def duration(name: str, child: bool = False) -> float:
    if name == "walk" and child:
        return CHILD_WALK_T
    return CLIPS[name][0]


def pose_at(name: str, t: float, child: bool = False):
    """(pose, ground mode, value): mode 'feet' solves the hips so the feet touch the ground,
    'clear' sets the lowest point at value metres, 'seat' sits on a seat of height value."""
    if name == "walk":
        return walk(t, CHILD_WALK_T if child else 1.0), "feet", 0.0
    if name == "run":
        return run(t), "feet", 0.03 * max(0.0, math.sin(TAU * (t / 0.7) * 2 - 1.2))
    if name == "idle":
        return idle(t), "feet", 0.0
    if name == "talk":
        return talk(t), "feet", 0.0
    if name == "wet_shake":
        return wet_shake(t), "feet", 0.0
    if name == "aim":
        return aim(t), "feet", 0.0
    if name == "sit":
        return sit(t), "seat", SEAT_HEIGHT * (0.66 if child else 1.0)
    if name == "dive":
        pose, c = dive(t)
        return pose, "clear", c
    raise KeyError(name)


def sit_pose(F, t, seat):
    """The sit clip for this body: the hips at seat height plus the thigh's radius, the knees
    at shin length above the ankles' rest height, so the feet stay flat on the ground."""
    J = F["J"]
    thigh_r = F["leg_r"][0][1]
    hip_z = seat + thigh_r
    knee_z = J["foot_L"][2] + (J["shin_L"][2] - J["foot_L"][2])
    L = float(np.linalg.norm(np.asarray(J["shin_L"]) - np.asarray(J["thigh_L"])))
    flex = 90.0 - math.degrees(math.asin(max(-0.9, min(0.9, (hip_z - knee_z) / L))))
    pose = sit(t, flex=flex)
    pose["hips_t"] = (0.0, -0.04 * F["scale"], hip_z - J["thigh_L"][2])
    return pose


def solve_ground(F, geo, pose, mode, value, foot_ids):
    """Set pose['hips_t'][2] so the feet (or the lowest point) meet the target height."""
    hx, hy, _ = pose.get("hips_t", (0.0, 0.0, 0.0))
    pose = dict(pose)
    pose["hips_t"] = (hx, hy, 0.0)
    G = H.bone_globals(F, pose)
    ids = foot_ids if mode == "feet" else slice(None)
    P, _ = H.skin(geo["P"][ids], geo["idx"][ids], geo["wts"][ids], G)
    pose["hips_t"] = (hx, hy, value - P[:, 2].min())
    return pose


def sample_clip(F, geo, name, times, child=False):
    """Poses for each time, ground solved. geo: humanoid.key_geometry output."""
    foot_ids = np.flatnonzero(geo["S"] == H.SLOT["sole"])
    out = []
    for t in times:
        pose, mode, value = pose_at(name, t, child)
        if mode == "seat":
            out.append(sit_pose(F, t, value))
        else:
            out.append(solve_ground(F, geo, pose, mode, value, foot_ids))
    return out
