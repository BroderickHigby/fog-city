"""The two suspension bridges seen from the city (interim, far-visible silhouettes):

  golden-gate-bridge.glb   the bridge across the Golden Gate strait
  bay-bridge-west.glb      the Bay Bridge's west span, Rincon Hill to Yerba Buena Island

Towers, decks, main cables and suspenders, anchorages and piers, built from published
dimensions and placed on the sf world's data (data/landmark-sites.json):

- Golden Gate: no street data runs onto the bridge (Hwy 101 ends at the shore north of Fort
  Point). The axis runs from that road end through the bridge's published centre (bearing
  354.4); the origin is the south tower at sea level. Published: main span 1,280 m, side spans
  343 m, towers 227 m above the water, deck clearance 67 m, deck 27 m wide. The south
  anchorage stands on the shore between the road's end and Fort Point (so the arch spans the
  fort), and the south approach runs on to the toll plaza's ground; the north anchorage is on
  the Marin shore.
- Bay Bridge west: the I-80 edge c14248000 is the axis; the DEM marks the piers along it
  (towers at 1,025, 1,785 and 2,495 m, the centre anchorage at 1,380-1,420 m), the fourth
  tower is one main span (704 m) west of the first. Published: towers 160 m, two main spans
  of 704 m, a double deck. The origin is mid eastern main span, at sea level.

Legal and taste (docs/design.md, Legal and taste): the Golden Gate Bridge's owner asserts
rights over the bridge's image; it is on the pre-release legal checklist, which does not block
private builds. These are generic low-poly suspension bridges in their real places and
colours, with no text, signs, logos or lettering, and no copied artwork (no light installation
on the Bay Bridge cables: plain aviation and tower lights only). In-game text says "the bridge"
(src/content/denylists.ts CHECKLIST_LANDMARKS). See assets/blender/README.md, Landmarks.

Nodes (each GLB):
  <root>      golden_gate_bridge | bay_bridge_west (extras fcLandmark)
    towers    towers and their piers
    deck      road deck(s), stiffening truss, approach viaduct and arch
    cables    main cables and suspenders
    anchorages
    lights    aviation beacons (light_status) and tower lights (light_tower_outline); nightLight
Frame: heading along the bridge, Blender +Y = glTF -Z = forward (north / toward the island).
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

from mathutils import Vector  # noqa: E402

import fc  # noqa: E402
import landmark_kit as LK  # noqa: E402

BUDGETS = {"golden-gate-bridge.glb": 30_000, "bay-bridge-west.glb": 30_000}


def parabola_cable(t0: float, z0: float, t1: float, z1: float, sag: float, n: int):
    """Points of a hanging cable from (t0, z0) to (t1, z1), `sag` below the chord at mid span."""
    out = []
    for k in range(n + 1):
        u = k / n
        out.append((LK.lerp(t0, t1, u), LK.lerp(z0, z1, u) - 4 * sag * u * (1 - u)))
    return out


def cable_z(cable, t: float) -> float:
    for (ta, za), (tb, zb) in zip(cable, cable[1:]):
        if ta <= t <= tb:
            return LK.lerp(za, zb, (t - ta) / (tb - ta))
    return cable[-1][1]


# ============================================================================ Golden Gate

GG_TOWER_H = 227.0
GG_MAIN = 1280.0
GG_SADDLE = 222.0
GG_DECK_W = 27.0
GG_TRUSS = 7.6
GG_LEG_X = 17.5
GG_CABLE_X = 15.0
GG_ANCH_S = (-345.0, -300.0)  # south anchorage, Y range (the road ends at its north face)
GG_ANCH_N = (GG_MAIN + 323.0, GG_MAIN + 368.0)
GG_ARCH = (-435.0, -345.0)  # the arch over Fort Point
GG_APPROACH_END = -840.0  # the approach meets the toll plaza's ground


def gg_deck_z(t: float, s: dict) -> float:
    """Road surface height along the bridge."""
    if 0.0 <= t <= GG_MAIN:
        u = t / GG_MAIN
        return 72.0 + 4.0 * 4 * u * (1 - u)  # crowned main span
    if t > GG_MAIN:
        return LK.lerp(72.0, 70.0, min((t - GG_MAIN) / 400.0, 1.0))
    if t >= GG_ANCH_S[0]:
        return LK.lerp(72.0, 70.5, -t / -GG_ANCH_S[0])
    # south approach: eases down to 4 m over the toll plaza's ground
    g_end, _ = LK.profile_ground(s, GG_APPROACH_END)
    return LK.lerp(70.5, g_end + 4.0, LK.smoothstep(GG_ANCH_S[0], GG_APPROACH_END, t))


def gg_tower(mb, lt, beacon, steel, concrete, y0: float, base_z: float) -> None:
    # pier and fender
    mb.box(-30, y0 - 18, base_z - 6, 30, y0 + 18, 12, concrete, skip=("-z",))
    # legs: three setbacks
    steps = [(12.0, 70.0, 10.0, 16.0), (70.0, 120.0, 9.0, 14.0), (120.0, 170.0, 8.2, 12.5), (170.0, GG_TOWER_H - 4, 7.5, 11.0)]
    for side in (-1, 1):
        cx = side * GG_LEG_X
        for (z0, z1, wx, wy) in steps:
            mb.box(cx - wx / 2, y0 - wy / 2, z0, cx + wx / 2, y0 + wy / 2, z1, steel, skip=("-z",))
        # saddle housing on top
        mb.box(cx - 4.2, y0 - 6.0, GG_TOWER_H - 4, cx + 4.2, y0 + 6.0, GG_TOWER_H, steel)
        # night: lit strips on the legs' fronts and backs
        for fy in (-1, 1):
            for (z0, z1, wx, wy) in steps:
                yy = y0 + fy * (wy / 2 + 0.05)
                mb.poly_n([(cx - wx * 0.35, yy, z0 + 1), (cx + wx * 0.35, yy, z0 + 1), (cx + wx * 0.35, yy, z1 - 1), (cx - wx * 0.35, yy, z1 - 1)], lt, (0, fy, 0))
    # portal struts between the legs: one below the deck, four above it
    inner = GG_LEG_X - 4.0
    for (z0, z1) in ((50.0, 58.0), (95.0, 104.0), (140.0, 148.0), (180.0, 187.0), (212.0, 221.0)):
        mb.box(-inner, y0 - 3.0, z0, inner, y0 + 3.0, z1, steel)
        # Art Deco: recessed panel lines on the struts' faces
        for fy in (-1, 1):
            yy = y0 + fy * 3.02
            for k in range(-3, 4):
                x = k * inner / 3.6
                mb.poly_n([(x - 0.4, yy, z0 + 1.2), (x + 0.4, yy, z0 + 1.2), (x + 0.4, yy, z1 - 1.2), (x - 0.4, yy, z1 - 1.2)], concrete, (0, fy, 0))
    # aviation beacons on the tower tops
    for side in (-1, 1):
        mb.sphere((side * GG_LEG_X, y0, GG_TOWER_H + 0.8), 0.9, 8, 4, beacon)


def golden_gate() -> None:
    s = LK.site("golden-gate-bridge")
    fc.reset()
    orange = fc.material("paint_bridge_orange", "#c0432c", 0.6)
    road = fc.material("asphalt", "#3c3d3f", 0.9)
    concrete = fc.material("concrete", "#b4ada2", 0.85)
    steel_dark = fc.material("paint_bridge_shadow", "#8f3322", 0.65)
    lt = fc.material("light_tower_outline", "#e8d7b8", 0.5, emission="#ffd9a0", strength=1.0)
    beacon = fc.material("light_status", "#5a1010", 0.4, emission="#ff2a18", strength=1.0)
    root = fc.empty("golden_gate_bridge")
    root["fcLandmark"] = "golden-gate-bridge"

    # ---- towers
    tw = fc.MeshBuilder()
    gg_tower(tw, lt, beacon, orange, concrete, 0.0, 0.0)
    gg_tower(tw, lt, beacon, orange, concrete, GG_MAIN, 0.0)
    tw.build("towers", parent=root, sharp_angle=30)

    # ---- deck: road slab and stiffening trusses from the north anchorage to the toll plaza
    dk = fc.MeshBuilder()
    half = GG_DECK_W / 2
    ts = [GG_APPROACH_END + k * 20.0 for k in range(int((GG_ANCH_N[1] + 40.0 - GG_APPROACH_END) / 20.0) + 1)]
    secs_top, secs_l, secs_r, secs_bot = [], [], [], []
    for t in ts:
        z = gg_deck_z(t, s)
        secs_top.append([(-half, t, z), (half, t, z)])
        secs_l.append([(-half, t, z - GG_TRUSS), (-half, t, z + 1.2)])
        secs_r.append([(half, t, z + 1.2), (half, t, z - GG_TRUSS)])
        secs_bot.append([(half, t, z - GG_TRUSS), (-half, t, z - GG_TRUSS)])
    dk.loft(secs_top, road, closed=False, smooth=False)
    dk.loft(secs_l, orange, closed=False, smooth=False)
    dk.loft(secs_r, orange, closed=False, smooth=False)
    dk.loft(secs_bot, steel_dark, closed=False, smooth=False)
    # truss verticals and diagonals on both faces (a Warren pattern every 15 m)
    for side in (-1, 1):
        x = side * (half + 0.15)
        t = GG_ANCH_S[1]
        k = 0
        while t < GG_ANCH_N[0]:
            z0, z1 = gg_deck_z(t, s), gg_deck_z(t + 15.0, s)
            a = (x, t, z0 - GG_TRUSS) if k % 2 == 0 else (x, t, z0)
            b = (x, t + 15.0, z1) if k % 2 == 0 else (x, t + 15.0, z1 - GG_TRUSS)
            LK.strut(dk, a, b, 0.5, steel_dark, d=0.4)
            t += 15.0
            k += 1
    # the arch over Fort Point, its piers, and the approach viaduct's steel bents to the toll plaza
    a0, a1 = GG_ARCH
    pts = []
    for k in range(17):
        u = k / 16
        t = LK.lerp(a0, a1, u)
        spring = LK.profile_ground(s, a0)[0] if u < 0.5 else LK.profile_ground(s, a1)[0]
        top = gg_deck_z(t, s) - GG_TRUSS - 1.0
        pts.append((t, LK.lerp(spring + 6.0, top, math.sin(math.pi * u))))
    for side in (-1, 1):
        x = side * (half - 2.0)
        prev = None
        for (t, z) in pts:
            if prev is not None:
                LK.strut(dk, (x, prev[0], prev[1]), (x, t, z), 2.4, orange, d=3.0)
                LK.strut(dk, (x, t, z), (x, t, gg_deck_z(t, s) - GG_TRUSS), 0.5, steel_dark)
            prev = (t, z)
    t = a0 - 50.0
    while t > GG_APPROACH_END + 20.0:
        g = LK.profile_ground(s, t)[0]
        top = gg_deck_z(t, s) - GG_TRUSS
        if top - g > 3.0:
            for side in (-1, 1):
                x = side * (half - 3.0)
                LK.strut(dk, (x, t, g - 1.0), (x, t, top), 2.2, orange, d=2.6)
            LK.strut(dk, (-half + 3.0, t, top - 3.0), (half - 3.0, t, top - 3.0), 1.2, orange)
        t -= 50.0
    dk.build("deck", parent=root, sharp_angle=30)

    # ---- cables: two main cables over the saddles, down to the anchorages, and suspenders
    cb = fc.MeshBuilder()
    anch_z = 74.0
    south = parabola_cable(GG_ANCH_S[1] + 4.0, anch_z, 0.0, GG_SADDLE, 14.0, 12)
    main = parabola_cable(0.0, GG_SADDLE, GG_MAIN, GG_SADDLE, GG_SADDLE - 79.0 + 0.0, 48)
    north = parabola_cable(GG_MAIN, GG_SADDLE, GG_ANCH_N[0] - 4.0, anch_z, 14.0, 12)
    for side in (-1, 1):
        x = side * GG_CABLE_X
        for cab in (south, main, north):
            LK.tube(cb, [(x, t, z) for t, z in cab], 0.75, 6, orange)
        for (cab, t0, t1) in ((south, GG_ANCH_S[1] + 10.0, -8.0), (main, 8.0, GG_MAIN - 8.0), (north, GG_MAIN + 8.0, GG_ANCH_N[0] - 10.0)):
            t = t0
            while t <= t1:
                zc = cable_z(cab, t)
                zd = gg_deck_z(t, s) + 1.2
                if zc - zd > 0.8:
                    LK.strut(cb, (x, t, zc), (side * (half - 0.2), t, zd), 0.16, orange)
                t += 15.24
    cb.build("cables", parent=root)

    # ---- anchorages (down below the water and the far terrain)
    an = fc.MeshBuilder()
    for (y0, y1) in (GG_ANCH_S, GG_ANCH_N):
        an.box(-half - 6, y0, -6.0, half + 6, y1, anch_z + 4.0, concrete, skip=("-z",))
        # stepped pylons where the cables enter
        for side in (-1, 1):
            an.box(side * GG_CABLE_X - 4, y0 + 8, anch_z + 4.0, side * GG_CABLE_X + 4, y1 - 8, anch_z + 14.0, concrete)
    # the arch's springing piers either side of Fort Point
    for t in GG_ARCH:
        g = LK.profile_ground(s, t)[0]
        an.box(-half, t - 4, g - 3, half, t + 4, g + 6.0, concrete, skip=("-z",))
    an.build("anchorages", parent=root, sharp_angle=30)

    # ---- night: beacons are in the towers' mesh (light_status); a lit roadway edge line
    li = fc.MeshBuilder()
    t = GG_APPROACH_END + 10.0
    while t < GG_ANCH_N[1]:
        z = gg_deck_z(t, s) + 1.25
        for side in (-1, 1):
            li.box(side * (half - 0.4) - 0.15, t - 0.4, z, side * (half - 0.4) + 0.15, t + 0.4, z + 0.3, lt)
        t += 50.0
    ob = li.build("lights", parent=root)
    ob["nightLight"] = True

    fc.export_glb("golden-gate-bridge.glb", BUDGETS["golden-gate-bridge.glb"])


# ============================================================================ Bay Bridge west

BB_TOWER_H = 160.0
BB_SADDLE = 156.0
BB_DECK_W = 20.0
BB_TRUSS = 10.0
BB_LEG_X = 11.5
BB_CABLE_X = 10.5
# Stations along the axis (t, metres from the origin toward Yerba Buena Island).
BB_SF_ANCH = -2173.0
BB_W2 = -1819.0
BB_W3 = -1115.0
BB_CENTRE = -742.0
BB_W5 = -355.0
BB_W6 = 355.0
BB_YBI_ANCH = 660.0
BB_CENTRE_TOP = 88.0


def bb_deck_z(t: float) -> float:
    """Upper deck surface: up from Rincon Hill, crowned main spans, level to the island."""
    if t < BB_W2:
        return LK.lerp(46.0, 60.0, LK.smoothstep(BB_SF_ANCH - 30.0, BB_W2, t))
    if t < BB_W3:
        u = (t - BB_W2) / (BB_W3 - BB_W2)
        return 60.0 + 8.0 * 4 * u * (1 - u)
    if t < BB_W5:
        return 60.0 + 2.0 * math.sin(math.pi * (t - BB_W3) / (BB_W5 - BB_W3))
    if t < BB_W6:
        u = (t - BB_W5) / (BB_W6 - BB_W5)
        return 60.0 + 8.0 * 4 * u * (1 - u)
    return LK.lerp(60.0, 58.0, min((t - BB_W6) / (BB_YBI_ANCH - BB_W6), 1.0))


def bb_tower(mb, steel, concrete, beacon, y0: float) -> None:
    mb.box(-18, y0 - 12, -8.0, 18, y0 + 12, 14.0, concrete, skip=("-z",))
    for side in (-1, 1):
        cx = side * BB_LEG_X
        mb.box(cx - 3.0, y0 - 4.5, 14.0, cx + 3.0, y0 + 4.5, BB_TOWER_H - 6, steel)
        mb.box(cx - 2.4, y0 - 3.6, BB_TOWER_H - 6, cx + 2.4, y0 + 3.6, BB_TOWER_H, steel)
        mb.sphere((cx, y0, BB_TOWER_H + 0.7), 0.8, 8, 4, beacon)
    # X bracing in panels below and above the deck, struts between them
    inner = BB_LEG_X - 3.0
    panels = [(16.0, 44.0), (72.0, 100.0), (100.0, 128.0), (128.0, BB_TOWER_H - 6)]
    for (z0, z1) in panels:
        for fy in (-1, 1):
            yy = y0 + fy * 3.0
            LK.strut(mb, (-inner, yy, z0), (inner, yy, z1), 1.4, steel)
            LK.strut(mb, (inner, yy, z0), (-inner, yy, z1), 1.4, steel)
        mb.box(-inner, y0 - 3.5, z1 - 2.0, inner, y0 + 3.5, z1, steel)
    mb.box(-inner, y0 - 3.5, 44.0, inner, y0 + 3.5, 48.0, steel)


def bay_bridge() -> None:
    s = LK.site("bay-bridge-west")
    fc.reset()
    steel = fc.material("paint_bridge_grey", "#98a0a6", 0.5, 0.35)
    shadow = fc.material("paint_bridge_grey_dark", "#6e767c", 0.6, 0.3)
    road = fc.material("asphalt", "#3c3d3f", 0.9)
    concrete = fc.material("concrete", "#b4ada2", 0.85)
    lt = fc.material("light_tower_outline", "#e8e2d0", 0.5, emission="#fff0d0", strength=1.0)
    beacon = fc.material("light_status", "#5a1010", 0.4, emission="#ff2a18", strength=1.0)
    root = fc.empty("bay_bridge_west")
    root["fcLandmark"] = "bay-bridge-west"

    tw = fc.MeshBuilder()
    for y in (BB_W2, BB_W3, BB_W5, BB_W6):
        bb_tower(tw, steel, concrete, beacon, y)
    tw.build("towers", parent=root, sharp_angle=30)

    # ---- double deck: an upper road, a lower road inside the truss, grey truss sides
    dk = fc.MeshBuilder()
    half = BB_DECK_W / 2
    ts = [BB_SF_ANCH - 30.0 + k * 20.0 for k in range(int((BB_YBI_ANCH + 60.0 - (BB_SF_ANCH - 30.0)) / 20.0) + 1)]
    top, lower, sl, sr, bot = [], [], [], [], []
    for t in ts:
        z = bb_deck_z(t)
        top.append([(-half, t, z), (half, t, z)])
        lower.append([(-half + 0.5, t, z - BB_TRUSS + 1.0), (half - 0.5, t, z - BB_TRUSS + 1.0)])
        sl.append([(-half, t, z - BB_TRUSS), (-half, t, z + 1.0)])
        sr.append([(half, t, z + 1.0), (half, t, z - BB_TRUSS)])
        bot.append([(half, t, z - BB_TRUSS), (-half, t, z - BB_TRUSS)])
    dk.loft(top, road, closed=False, smooth=False)
    dk.loft(lower, road, closed=False, smooth=False)
    dk.loft(bot, shadow, closed=False, smooth=False)
    # the truss sides are open: chords and a Warren web (the lower deck shows through)
    for side in (-1, 1):
        x = side * half
        for zoff, w in ((0.6, 1.0), (-BB_TRUSS + 0.5, 1.0)):
            LK.tube(dk, [(x, t, bb_deck_z(t) + zoff) for t in ts[::3]], w / 2, 4, steel, smooth=False)
        t = ts[0]
        k = 0
        while t + 12.0 < ts[-1]:
            z0, z1 = bb_deck_z(t), bb_deck_z(t + 12.0)
            a = (x, t, z0 - BB_TRUSS + 0.5) if k % 2 == 0 else (x, t, z0 + 0.6)
            b = (x, t + 12.0, z1 + 0.6) if k % 2 == 0 else (x, t + 12.0, z1 - BB_TRUSS + 0.5)
            LK.strut(dk, a, b, 0.6, steel)
            t += 12.0
            k += 1
    dk.build("deck", parent=root, sharp_angle=30)

    # ---- cables: anchorage -> W2 -> W3 -> centre anchorage -> W5 -> W6 -> island anchorage
    cb = fc.MeshBuilder()
    anch_z = bb_deck_z(BB_SF_ANCH) + 4.0
    spans = [
        parabola_cable(BB_SF_ANCH + 10.0, anch_z, BB_W2, BB_SADDLE, 18.0, 12),
        parabola_cable(BB_W2, BB_SADDLE, BB_W3, BB_SADDLE, BB_SADDLE - 72.0, 40),
        parabola_cable(BB_W3, BB_SADDLE, BB_CENTRE - 18.0, BB_CENTRE_TOP - 2.0, 14.0, 12),
        parabola_cable(BB_CENTRE + 18.0, BB_CENTRE_TOP - 2.0, BB_W5, BB_SADDLE, 14.0, 12),
        parabola_cable(BB_W5, BB_SADDLE, BB_W6, BB_SADDLE, BB_SADDLE - 72.0, 40),
        parabola_cable(BB_W6, BB_SADDLE, BB_YBI_ANCH - 10.0, bb_deck_z(BB_YBI_ANCH) + 4.0, 14.0, 10),
    ]
    for side in (-1, 1):
        x = side * BB_CABLE_X
        for cab in spans:
            LK.tube(cb, [(x, t, z) for t, z in cab], 0.6, 6, steel)
            t = cab[0][0] + 9.0
            while t < cab[-1][0] - 9.0:
                zc = cable_z(cab, t)
                zd = bb_deck_z(t) + 1.0
                if zc - zd > 0.8:
                    LK.strut(cb, (x, t, zc), (side * (half - 0.3), t, zd), 0.16, steel)
                t += 15.0
    cb.build("cables", parent=root)

    # ---- anchorages: Rincon Hill, the centre anchorage in the bay, Yerba Buena Island
    an = fc.MeshBuilder()
    for (t, ztop, length) in ((BB_SF_ANCH, anch_z + 6.0, 50.0), (BB_YBI_ANCH, bb_deck_z(BB_YBI_ANCH) + 10.0, 50.0)):
        an.box(-half - 8, t - length / 2, -8.0, half + 8, t + length / 2, ztop, concrete, skip=("-z",))
    an.box(-22, BB_CENTRE - 30, -8.0, 22, BB_CENTRE + 30, 14.0, concrete, skip=("-z",))
    an.box(-16, BB_CENTRE - 20, 14.0, 16, BB_CENTRE + 20, BB_CENTRE_TOP - 8.0, concrete)
    an.box(-12, BB_CENTRE - 14, BB_CENTRE_TOP - 8.0, 12, BB_CENTRE + 14, BB_CENTRE_TOP, concrete)
    an.build("anchorages", parent=root, sharp_angle=30)

    # ---- night: tower lights up the legs and roadway lamps
    li = fc.MeshBuilder()
    for y in (BB_W2, BB_W3, BB_W5, BB_W6):
        for side in (-1, 1):
            cx = side * BB_LEG_X
            for fy in (-1, 1):
                yy = y + fy * 4.55
                li.poly_n([(cx - 1.2, yy, 70.0), (cx + 1.2, yy, 70.0), (cx + 1.2, yy, BB_TOWER_H - 8), (cx - 1.2, yy, BB_TOWER_H - 8)], lt, (0, fy, 0))
    t = BB_SF_ANCH
    while t < BB_YBI_ANCH:
        z = bb_deck_z(t) + 1.05
        for side in (-1, 1):
            li.box(side * (half - 0.4) - 0.15, t - 0.4, z, side * (half - 0.4) + 0.15, t + 0.4, z + 0.3, lt)
        t += 45.0
    ob = li.build("lights", parent=root)
    ob["nightLight"] = True

    fc.export_glb("bay-bridge-west.glb", BUDGETS["bay-bridge-west.glb"])


if __name__ == "__main__":
    which = fc.script_args() or ["golden_gate", "bay_bridge"]
    for w in which:
        LK.report(w, LK.site("golden-gate-bridge" if w == "golden_gate" else "bay-bridge-west"))
        {"golden_gate": golden_gate, "bay_bridge": bay_bridge}[w]()
