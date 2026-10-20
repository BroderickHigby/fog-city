"""The Embarcadero Plaza set shared by look-dev renders 01 (golden hour) and 02 (night).

Places ferry-building.glb and r-evolution.glb exactly where content/landmarks.json puts them,
then lays a lean set around them in the Ferry Building's own frame: the promenade in front
of the facade, the Embarcadero roadway with its palm median, the plaza at the foot of
Market Street, lamp posts, and the bay behind.
"""

from __future__ import annotations

import json
import math
import os

import bpy
from mathutils import Matrix, Vector

import fc
import ferry_frame
import lookdev as L


def landmarks() -> dict:
    with open(os.path.join(fc.REPO, "content", "landmarks.json"), encoding="utf-8") as f:
        return {e["id"]: e for e in json.load(f)["landmarks"]}


def game_xz(lm: dict) -> tuple[float, float]:
    return ferry_frame.to_local(lm["lat"], lm["lon"])


def build(night: bool):
    lms = landmarks()
    fe, re_ = lms["ferry-building"], lms["r-evolution"]
    ferry, ferry_objs = L.import_glb(fe["model"].split("/")[-1], game_xz=game_xz(fe), heading_deg=fe["headingDeg"])
    rev, rev_objs = L.import_glb(re_["model"].split("/")[-1], game_xz=game_xz(re_), heading_deg=re_["headingDeg"])

    # the set is laid out in the Ferry Building's frame: x along the facade, y toward Market St
    frame = Matrix.Translation(ferry.location) @ Matrix.Rotation(-math.radians(fe["headingDeg"]), 4, "Z")
    asphalt = L.noisy_material("asphalt", "#2d2e30", "#3b3c3e", scale=1.5, rough=0.9, bump=0.05)
    paving = L.noisy_material("paving", "#a9a39a", "#c3bdb2", scale=0.4, rough=0.75, bump=0.03)
    median = L.noisy_material("median", "#8f8b84", "#a8a39b", scale=0.8, rough=0.85)
    water = L.flat_material("bay", "#24343f", rough=0.08, metal=0.0)
    trunk = L.noisy_material("palm_trunk", "#5b5146", "#7a6c5c", scale=9, rough=0.95, bump=0.6)
    frond = L.flat_material("palm_frond", "#3f5a2a", rough=0.7)
    frond.use_backface_culling = False
    iron = L.flat_material("lamp_iron", "#1f2a26", rough=0.5, metal=0.6)
    glow = L.flat_material("lamp_glass", "#fff1d6", rough=0.3, emission="#ffd59a", strength=12.0 if night else 0.0)

    g = fc.MeshBuilder()
    g.push(frame)
    g.poly([(-400, 7.0, 0.0), (400, 7.0, 0.0), (400, 22.0, 0.0), (-400, 22.0, 0.0)], paving)
    g.poly([(-400, 22.0, -0.02), (400, 22.0, -0.02), (400, 74.0, -0.02), (-400, 74.0, -0.02)], asphalt)
    g.box(-400, 41.0, -0.02, 400, 47.0, 0.15, median, skip=("-z",))
    g.poly([(-400, 74.0, 0.0), (400, 74.0, 0.0), (400, 420.0, 0.0), (-400, 420.0, 0.0)], paving)
    g.poly([(-400, -2.0, 0.0), (400, -2.0, 0.0), (400, 7.0, 0.0), (-400, 7.0, 0.0)], paving)
    g.poly([(-400, -420.0, -0.6), (400, -420.0, -0.6), (400, -2.0, -0.6), (-400, -2.0, -0.6)], water)
    g.poly([(-110, -60.0, 0.0), (110, -60.0, 0.0), (110, -2.0, 0.0), (-110, -2.0, 0.0)], paving)
    g.pop()
    g.build("ground")

    tr, fr = fc.MeshBuilder(), fc.MeshBuilder()
    k = 0
    for x in range(-150, 151, 13):  # median palms
        p = frame @ Vector((x, 44.0, 0.15))
        L.palm(tr, fr, p.x, p.y, 9.5 + (k % 3) * 0.6, trunk, frond, seed=k)
        k += 1
    rv = Vector(rev.location)
    up_market = Vector((math.sin(math.radians(re_["headingDeg"])), math.cos(math.radians(re_["headingDeg"])), 0))
    side = Vector((up_market.y, -up_market.x, 0))
    for d in (14, 28, 42, 56):  # palms flanking Market Street's axis, as in the photographs
        for s in (-1, 1):
            p = rv + up_market * (d - 6) + side * (s * 15)
            L.palm(tr, fr, p.x, p.y, 10.0 + (k % 3) * 0.7, trunk, frond, seed=k)
            k += 1
    tr.build("palm_trunks")
    fr.build("palm_fronds")

    lamps = fc.MeshBuilder()
    lamp_pts = []
    for x in range(-100, 101, 20):  # ornamental lamp posts along the promenade
        lamp_pts.append(frame @ Vector((x, 19.0, 0)))
    for d in (-16, 40):
        for s in (-1, 1):
            lamp_pts.append(rv + up_market * d + side * (s * 12))
    for p in lamp_pts:
        lamps.push(Matrix.Translation(p))
        lamps.cylinder(0.12, 0.0, 4.2, 8, iron)
        lamps.lathe([(0.18, 4.2), (0.28, 4.5), (0.28, 5.0), (0.0, 5.25)], 8, glow, smooth=False)
        lamps.pop()
    lamps.build("lamp_posts")
    if night:
        for p in lamp_pts:
            L.point_light((p.x, p.y, 4.75), 260.0, "#ffc98a", radius=0.25)
    return ferry, ferry_objs, rev, rev_objs, frame


def golden_camera(rev, re_heading):
    """From the plaza, south-west of the sculpture, with the tower to her left."""
    rv = Vector(rev.location)
    a = math.radians(re_heading + 20)  # 245 deg from the sculpture
    cam = rv + Vector((math.sin(a), math.cos(a), 0)) * 31.0
    cam.z = 1.65
    tgt = rv + Vector((math.sin(math.radians(re_heading + 180 - 10)), math.cos(math.radians(re_heading + 180 - 10)), 0)) * 20
    tgt.z = 15.5
    return L.camera(cam, tgt, lens=30.0)
