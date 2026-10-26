"""San Francisco Ferry Building (A. Page Brown, 1898) -> public/models/ferry-building.glb

Sized and oriented from the SF building footprint (data/ferry-building-footprint.json,
sf16_bldgid 201006.0000058; see lib/ferry_frame.py). The model origin is the clock tower's
centre at ground level; the front (the Embarcadero / Market Street facade) faces glTF -Z.

Nodes:
  ferry_building            root
    building                wings, central pavilion, roof (one mesh, several materials)
    tower                   Giralda-style clock tower: shaft, clock stage with four dials,
                            belfry arcade, upper stage, lantern, cupola, flagpole
    tower_outline_lights    emissive strips along the tower's edges (light_tower_outline)
    clock_hour_N/E/S/W      hands; origin at the dial centre, local +Z = the dial's outward
    clock_minute_N/E/S/W    normal, at rest pointing at 12 (extras clockHand, clockAxis)
N/E/S/W are MODEL-frame directions, not compass points: N is the front dial (glTF -Z), E is
+X (the model's right), S is the back (+Z), W is -X. Placed at the landmark heading (233.8),
the N dial faces south-west up Market St. Each hand's extras say so: clockFaceFrame "model",
clockFaceNormal (model frame), clockFaceBearingDeg and clockFaceCompass (the world direction
the dial faces once placed, e.g. N -> 233.8 "SW").

Budget: 100k triangles.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import fc  # noqa: E402
import ferry_frame  # noqa: E402

BUDGET = 100_000
F = ferry_frame.frame()

# ------------------------------------------------------------------ plan (Blender frame)
# x right (north-west end), y forward (toward Market Street), z up; tower centre = origin.
X_END = round((F["u_range"][1] - F["u_range"][0]) / 2, 2)  # half length, ~101.6 m
Y_FACADE = round(F["v_facade"], 2)  # main Embarcadero facade line, ~-2.1
Y_PAV = round(F["v_pavilion"], 2)  # central pavilion front, 7.0
Y_BACK = round(F["v_back"], 2)  # bay-side facade, ~-50.8
PAV_X = round((F["pavilion_u"][1] - F["pavilion_u"][0]) / 2, 2)  # pavilion half width, ~22.5
END_PAV = 8.0  # end pavilion width

# Heights (m above ground). The lidar median roof is 15.2 m; the tower peak 71.4 m.
Z_BELT0, Z_BELT1 = 6.6, 7.2
Z_ENT = 12.6
Z_CORN = 13.2
Z_PARA = 13.7
Z_PARA_TOP = 14.75
Z_RIDGE = 17.2
PAV_CORN = 18.0
PAV_TOP = 20.6
TOWER_HALF = 5.7
CLOCK_Z = 37.0
DIAL_R = 3.35  # 22 ft dials

# ---------------------------------------------------------------------------- materials
fc.reset()
STONE = fc.material("sandstone", "#d8cbb0", 0.86)
TRIM = fc.material("sandstone_trim", "#e6dcc6", 0.8)
SHADE = fc.material("sandstone_shade", "#bcae94", 0.9)
ROOF = fc.material("roof_slate", "#6f7471", 0.72)
GLASS = fc.material("glass_dark", "#28323c", 0.18, 0.35)
SKY = fc.material("glass_skylight", "#8fa3b0", 0.12, 0.3)
DARK = fc.material("recess_dark", "#1d1b19", 0.95)
BRONZE = fc.material("bronze_dark", "#2a251f", 0.45, 0.6)
POLE = fc.material("flagpole_white", "#ececec", 0.35, 0.2)
DIAL = fc.material("light_clock_face", "#f1e9d6", 0.5, emission="#fff0c8", strength=1.0)
OUTLINE = fc.material("light_tower_outline", "#f4e6c4", 0.4, emission="#ffd99a", strength=1.0)


def rotz(a: float) -> Matrix:
    return Matrix.Rotation(a, 4, "Z")


def tr(x: float, y: float, z: float = 0.0) -> Matrix:
    return Matrix.Translation((x, y, z))


# --------------------------------------------------------------- facade building blocks
# Facade-local frame: the wall plane is y = 0, outward is +y, x runs along the wall.


def arch_pts(xc, a, zs, seg):
    return [(xc + a * math.cos(math.pi - math.pi * k / seg), zs + a * math.sin(math.pi - math.pi * k / seg)) for k in range(seg + 1)]


def arch_bay(mb, x0, x1, zb, zt, op, wall=STONE, reveal=SHADE, pane=GLASS):
    """Wall rectangle [x0,x1]x[zb,zt] pierced by one round-arched opening.

    op: dict xc, a (half width), zo (bottom), zs (spring), depth, seg, keystone, mullion.
    """
    xc, a, zo, zs, d = op["xc"], op["a"], op["zo"], op["zs"], op["depth"]
    seg = op.get("seg", 8)
    P = arch_pts(xc, a, zs, seg)
    n = (0, 1, 0)
    if zo > zb + 1e-6:
        mb.poly_n([(x0, 0, zb), (x1, 0, zb), (x1, 0, zo), (x0, 0, zo)], wall, n)
    if xc - a > x0 + 1e-6:
        mb.poly_n([(x0, 0, zo), (xc - a, 0, zo), (xc - a, 0, zs), (x0, 0, zs)], wall, n)
    if x1 > xc + a + 1e-6:
        mb.poly_n([(xc + a, 0, zo), (x1, 0, zo), (x1, 0, zs), (xc + a, 0, zs)], wall, n)
    T = [(x0 + (px - (xc - a)) / (2 * a) * (x1 - x0), zt) for px, _ in P]
    for k in range(seg):
        mb.poly_n([(P[k][0], 0, P[k][1]), (P[k + 1][0], 0, P[k + 1][1]), (T[k + 1][0], 0, zt), (T[k][0], 0, zt)], wall, n)
    if xc - a > x0 + 1e-6:
        mb.poly_n([(x0, 0, zs), (xc - a, 0, zs), (x0, 0, zt)], wall, n)
    if x1 > xc + a + 1e-6:
        mb.poly_n([(xc + a, 0, zs), (x1, 0, zs), (x1, 0, zt)], wall, n)
    # reveal
    mb.poly_n([(xc - a, 0, zo), (xc - a, -d, zo), (xc - a, -d, zs), (xc - a, 0, zs)], reveal, (1, 0, 0))
    mb.poly_n([(xc + a, 0, zo), (xc + a, -d, zo), (xc + a, -d, zs), (xc + a, 0, zs)], reveal, (-1, 0, 0))
    for k in range(seg):
        (ax, az), (bx, bz) = P[k], P[k + 1]
        mx, mz = (ax + bx) / 2, (az + bz) / 2
        mb.poly_n([(ax, 0, az), (bx, 0, bz), (bx, -d, bz), (ax, -d, az)], reveal, (xc - mx, 0, zs - mz))
    if zo > 0.05:
        mb.poly_n([(xc - a, 0, zo), (xc + a, 0, zo), (xc + a, -d, zo), (xc - a, -d, zo)], TRIM, (0, 0, 1))
    pts = [(xc - a, -d, zo), (xc + a, -d, zo)] + [(px, -d, pz) for px, pz in reversed(P)][1:-1]
    mb.poly_n(pts, pane, n)
    if op.get("mullion"):
        w = 0.11
        mb.box(xc - w / 2, -d, zo, xc + w / 2, -d + 0.08, zs + a, TRIM, skip=("-y",))
        mb.box(xc - a, -d, zs - w / 2, xc + a, -d + 0.08, zs + w / 2, TRIM, skip=("-y",))
    if op.get("keystone"):
        k = 0.28 if a < 1.6 else 0.4
        mb.box(xc - k, 0, zs + a - 0.15, xc + k, 0.14, zs + a + 0.55, TRIM, skip=("-y",))


def wall_row(mb, x0, x1, zb, zt, openings, wall=STONE, pane=GLASS):
    """A run of wall with openings; columns split half-way between neighbouring openings."""
    if not openings:
        mb.poly_n([(x0, 0, zb), (x1, 0, zb), (x1, 0, zt), (x0, 0, zt)], wall, (0, 1, 0))
        return
    ops = sorted(openings, key=lambda o: o["xc"])
    splits = [x0]
    for o1, o2 in zip(ops, ops[1:]):
        splits.append(((o1["xc"] + o1["a"]) + (o2["xc"] - o2["a"])) / 2)
    splits.append(x1)
    for i, o in enumerate(ops):
        arch_bay(mb, splits[i], splits[i + 1], zb, zt, o, wall=wall, pane=pane)


def ledge(mb, x0, x1, z0, z1, proud, mat=TRIM, ext=None):
    """A horizontal band along the wall (cornice, belt course), extended past the ends."""
    e = proud if ext is None else ext
    mb.box(x0 - e, 0, z0, x1 + e, proud, z1, mat, skip=("-y",))


def balustrade(mb, x0, x1, z0, z1, y=0.0, spacing=0.46, mat=TRIM):
    """Base rail, square balusters and top rail, standing on a ledge at height z0."""
    t = 0.32
    mb.box(x0, y - t, z0, x1, y + 0.02, z0 + 0.22, mat, skip=("-z",))
    mb.box(x0, y - t - 0.04, z1 - 0.2, x1, y + 0.06, z1, mat)
    n = max(1, int((x1 - x0) / spacing))
    step = (x1 - x0) / n
    for i in range(n):
        cx = x0 + step * (i + 0.5)
        mb.box(cx - 0.075, y - t + 0.08, z0 + 0.22, cx + 0.075, y - 0.06, z1 - 0.2, mat, skip=("-z", "+z"))


def pilaster(mb, xc, w, z0, z1, proud, mat=TRIM, cap=True):
    mb.box(xc - w / 2, 0, z0, xc + w / 2, proud, z1, mat, skip=("-y", "-z"))
    if cap:
        mb.box(xc - w / 2 - 0.12, 0, z1 - 0.28, xc + w / 2 + 0.12, proud + 0.12, z1, mat, skip=("-y",))


def wing_facade(mb, length, bays, ground="arcade", end_pav_at=None):
    """Two-storey facade of the long wings: ground arcade or windows, upper arched windows."""
    bw = length / bays
    ground_ops, upper_ops = [], []
    for i in range(bays):
        xc = bw * (i + 0.5)
        if ground == "arcade":
            ground_ops.append(dict(xc=xc, a=min(2.05, bw * 0.35), zo=0.0, zs=4.3, depth=2.4, seg=8, keystone=True))
        else:
            ground_ops.append(dict(xc=xc, a=min(1.55, bw * 0.27), zo=0.9, zs=4.1, depth=0.45, seg=8, keystone=True, mullion=True))
        upper_ops.append(dict(xc=xc, a=min(1.35, bw * 0.23), zo=8.1, zs=10.8, depth=0.45, seg=8, mullion=True))
    wall_row(mb, 0, length, 0, Z_BELT0, ground_ops)
    wall_row(mb, 0, length, Z_BELT1, Z_ENT, upper_ops)
    mb.poly_n([(0, 0, Z_BELT0), (length, 0, Z_BELT0), (length, 0, Z_BELT1), (0, 0, Z_BELT1)], STONE, (0, 1, 0))
    ledge(mb, 0, length, Z_BELT0, Z_BELT1, 0.22)
    for i in range(bays + 1):
        pilaster(mb, bw * i, 0.62, Z_BELT1, Z_ENT, 0.2)
    mb.poly_n([(0, 0, Z_ENT), (length, 0, Z_ENT), (length, 0, Z_CORN), (0, 0, Z_CORN)], STONE, (0, 1, 0))
    ledge(mb, 0, length, Z_ENT, Z_CORN, 0.32, ext=0.0)
    ledge(mb, 0, length, Z_CORN, Z_PARA, 0.78, ext=0.0)
    balustrade(mb, 0, length, Z_PARA, Z_PARA_TOP, y=0.35)
    for i in range(bays + 1):
        mb.box(bw * i - 0.3, 0.0, Z_PARA, bw * i + 0.3, 0.55, Z_PARA_TOP + 0.15, TRIM)


def end_pavilion_face(mb, width, mirror=False):
    """The taller pavilion that terminates each wing (one big bay, quoins, solid attic)."""
    z_top = 14.7
    xc = width / 2
    wall_row(mb, 0, width, 0, Z_BELT0, [dict(xc=xc, a=2.3, zo=0.0, zs=3.9, depth=2.4, seg=10, keystone=True)])
    mb.poly_n([(0, 0, Z_BELT0), (width, 0, Z_BELT0), (width, 0, Z_BELT1), (0, 0, Z_BELT1)], STONE, (0, 1, 0))
    wall_row(mb, 0, width, Z_BELT1, z_top, [dict(xc=xc, a=1.7, zo=8.0, zs=11.4, depth=0.5, seg=10, mullion=True, keystone=True)])
    ledge(mb, 0, width, Z_BELT0, Z_BELT1, 0.28)
    for qx in (0.55, width - 0.55):
        for k in range(9):
            z0 = 0.3 + k * 1.55
            mb.box(qx - 0.6, 0, z0, qx + 0.6, 0.16, z0 + 1.2, TRIM, skip=("-y",))
    ledge(mb, 0, width, z_top, z_top + 0.6, 0.85, ext=0.0)
    mb.box(-0.1, -0.3, z_top + 0.6, width + 0.1, 0.25, 16.3, STONE)
    mb.box(xc - 2.0, -0.3, 16.3, xc + 2.0, 0.3, 17.0, TRIM)


# ------------------------------------------------------------------------------- building
def build_building() -> bpy.types.Object:
    mb = fc.MeshBuilder()
    wing_len = X_END - PAV_X - END_PAV
    bays = 12
    # front wings (outward +Y), then end pavilions on the front facade
    mb.push(tr(PAV_X, Y_FACADE))
    wing_facade(mb, wing_len, bays)
    mb.pop()
    mb.push(tr(-X_END + END_PAV, Y_FACADE))
    wing_facade(mb, wing_len, bays)
    mb.pop()
    for x0 in (X_END - END_PAV, -X_END):
        mb.push(tr(x0, Y_FACADE + 0.4))
        end_pavilion_face(mb, END_PAV)
        mb.pop()
    # back facade (outward -Y), 34 bays of windows
    mb.push(tr(X_END, Y_BACK) @ rotz(math.pi))
    wing_facade(mb, 2 * X_END, 34, ground="windows")
    mb.pop()
    depth = Y_FACADE - Y_BACK
    side_len = depth - END_PAV
    # right end (outward +X): end pavilion return, then windows
    mb.push(tr(X_END, Y_FACADE + 0.4) @ rotz(-math.pi / 2))
    end_pavilion_face(mb, END_PAV + 0.4)
    mb.pop()
    mb.push(tr(X_END, Y_FACADE - END_PAV) @ rotz(-math.pi / 2))
    wing_facade(mb, side_len, 7, ground="windows")
    mb.pop()
    # left end (outward -X)
    mb.push(tr(-X_END, Y_BACK) @ rotz(math.pi / 2))
    wing_facade(mb, side_len, 7, ground="windows")
    mb.pop()
    mb.push(tr(-X_END, Y_FACADE - END_PAV) @ rotz(math.pi / 2))
    end_pavilion_face(mb, END_PAV + 0.4)
    mb.pop()
    # inner faces of the end pavilions where they step above the wing parapet
    for sx in (1, -1):
        x_in = sx * (X_END - END_PAV)
        mb.poly_n([(x_in, Y_FACADE, 0), (x_in, Y_FACADE + 0.4, 0), (x_in, Y_FACADE + 0.4, Z_PARA), (x_in, Y_FACADE, Z_PARA)], STONE, (-sx, 0, 0))
        mb.poly_n([(x_in, Y_FACADE + 0.4, Z_PARA), (x_in, Y_FACADE - END_PAV, Z_PARA), (x_in, Y_FACADE - END_PAV, 16.3), (x_in, Y_FACADE + 0.4, 16.3)], STONE, (-sx, 0, 0))
        mb.poly_n([(x_in, Y_FACADE - END_PAV, Z_PARA), (sx * X_END, Y_FACADE - END_PAV, Z_PARA), (sx * X_END, Y_FACADE - END_PAV, 16.3), (x_in, Y_FACADE - END_PAV, 16.3)], STONE, (0, -1, 0))
        mb.poly_n([(x_in, Y_FACADE + 0.7, 16.3), (sx * X_END, Y_FACADE + 0.7, 16.3), (sx * X_END, Y_FACADE - END_PAV, 16.3), (x_in, Y_FACADE - END_PAV, 16.3)], ROOF, (0, 0, 1))

    # ---- roof: two slopes to a ridge with a long glass monitor (the nave skylight)
    y_mid = (Y_FACADE + Y_BACK) / 2
    xr = X_END - END_PAV
    yf, yb = Y_FACADE - 0.1, Y_BACK + 0.1
    mb.poly_n([(-X_END, yf, Z_PARA), (X_END, yf, Z_PARA), (xr - 4, y_mid + 3.5, Z_RIDGE - 0.6), (-xr + 4, y_mid + 3.5, Z_RIDGE - 0.6)], ROOF, (0, 1, 1))
    mb.poly_n([(X_END, yb, Z_PARA), (-X_END, yb, Z_PARA), (-xr + 4, y_mid - 3.5, Z_RIDGE - 0.6), (xr - 4, y_mid - 3.5, Z_RIDGE - 0.6)], ROOF, (0, -1, 1))
    for sx in (1, -1):
        mb.poly_n([(sx * X_END, yf, Z_PARA), (sx * X_END, yb, Z_PARA), (sx * (xr - 4), y_mid - 3.5, Z_RIDGE - 0.6), (sx * (xr - 4), y_mid + 3.5, Z_RIDGE - 0.6)], ROOF, (sx, 0, 1))
    # skylight monitor
    sx0, sx1 = -xr + 4, xr - 4
    mb.poly_n([(sx0, y_mid + 3.5, Z_RIDGE - 0.6), (sx1, y_mid + 3.5, Z_RIDGE - 0.6), (sx1, y_mid + 3.5, Z_RIDGE + 0.3), (sx0, y_mid + 3.5, Z_RIDGE + 0.3)], STONE, (0, 1, 0))
    mb.poly_n([(sx0, y_mid - 3.5, Z_RIDGE - 0.6), (sx1, y_mid - 3.5, Z_RIDGE - 0.6), (sx1, y_mid - 3.5, Z_RIDGE + 0.3), (sx0, y_mid - 3.5, Z_RIDGE + 0.3)], STONE, (0, -1, 0))
    mb.poly_n([(sx0, y_mid + 3.5, Z_RIDGE + 0.3), (sx1, y_mid + 3.5, Z_RIDGE + 0.3), (sx1, y_mid, Z_RIDGE + 1.6), (sx0, y_mid, Z_RIDGE + 1.6)], SKY, (0, 1, 1))
    mb.poly_n([(sx1, y_mid - 3.5, Z_RIDGE + 0.3), (sx0, y_mid - 3.5, Z_RIDGE + 0.3), (sx0, y_mid, Z_RIDGE + 1.6), (sx1, y_mid, Z_RIDGE + 1.6)], SKY, (0, -1, 1))
    for xe, sgn in ((sx0, -1), (sx1, 1)):
        mb.poly_n([(xe, y_mid - 3.5, Z_RIDGE - 0.6), (xe, y_mid + 3.5, Z_RIDGE - 0.6), (xe, y_mid + 3.5, Z_RIDGE + 0.3), (xe, y_mid, Z_RIDGE + 1.6), (xe, y_mid - 3.5, Z_RIDGE + 0.3)], STONE, (sgn, 0, 0))
    # skylight ribs
    for i in range(0, int(sx1 - sx0) // 6 + 1):
        x = sx0 + i * 6
        mb.box(x - 0.08, y_mid - 3.55, Z_RIDGE + 0.25, x + 0.08, y_mid + 3.55, Z_RIDGE + 1.0, BRONZE)

    # ---- central pavilion: projects to Y_PAV, rises to PAV_TOP; its block runs back to y=-8
    yb_pav = -8.0
    mb.push(tr(-PAV_X, Y_PAV))
    W = 2 * PAV_X
    ent = [dict(xc=PAV_X + dx, a=2.9, zo=0.0, zs=6.9, depth=2.8, seg=12, keystone=True, mullion=True) for dx in (-9.4, 0.0, 9.4)]
    side = [dict(xc=PAV_X + dx, a=1.5, zo=0.6, zs=4.6, depth=0.6, seg=8, mullion=True, keystone=True) for dx in (-17.3, 17.3)]
    wall_row(mb, 0, W, 0, 10.6, ent + side)
    up = [dict(xc=PAV_X + dx, a=1.75, zo=11.6, zs=14.6, depth=0.55, seg=10, mullion=True, keystone=True) for dx in (-9.4, 0.0, 9.4)]
    up += [dict(xc=PAV_X + dx, a=1.5, zo=11.6, zs=14.4, depth=0.5, seg=8, mullion=True) for dx in (-17.3, 17.3)]
    wall_row(mb, 0, W, 10.6, 17.4, up)
    ledge(mb, 0, W, 10.3, 10.9, 0.35)
    for dx in (-21.9, -14.05, -4.7, 4.7, 14.05, 21.9):
        pilaster(mb, PAV_X + dx, 1.05, 0.0, 17.4, 0.38)
    mb.poly_n([(0, 0, 17.4), (W, 0, 17.4), (W, 0, PAV_CORN), (0, 0, PAV_CORN)], STONE, (0, 1, 0))
    ledge(mb, 0, W, 17.4, PAV_CORN, 0.45)
    ledge(mb, 0, W, PAV_CORN, PAV_CORN + 0.55, 0.95)
    mb.box(-0.2, -0.4, PAV_CORN + 0.55, W + 0.2, 0.3, PAV_TOP, STONE)
    for dx in (-9.4, 0.0, 9.4):
        mb.box(PAV_X + dx - 3.2, 0.3, PAV_CORN + 0.95, PAV_X + dx + 3.2, 0.42, PAV_TOP - 0.45, TRIM, skip=("-y",))
    mb.pop()
    # pavilion sides (outward +-X), from the facade line to the front
    for sx in (1, -1):
        L = Y_PAV - Y_FACADE
        if sx > 0:
            mb.push(tr(PAV_X, Y_PAV) @ rotz(-math.pi / 2))
        else:
            mb.push(tr(-PAV_X, Y_FACADE) @ rotz(math.pi / 2))
        wall_row(mb, 0, L, 0, 10.6, [dict(xc=L / 2, a=1.45, zo=0.6, zs=4.6, depth=0.5, seg=8, mullion=True, keystone=True)])
        wall_row(mb, 0, L, 10.6, PAV_CORN, [dict(xc=L / 2, a=1.45, zo=11.6, zs=14.4, depth=0.5, seg=8, mullion=True)])
        ledge(mb, 0, L, 10.3, 10.9, 0.35)
        ledge(mb, 0, L, PAV_CORN, PAV_CORN + 0.55, 0.95)
        mb.box(-0.2, -0.4, PAV_CORN + 0.55, L + 0.2, 0.3, PAV_TOP, STONE)
        mb.pop()
    # pavilion block above the wing roof, behind the facade line
    for sx in (1, -1):
        mb.poly_n([(sx * PAV_X, Y_FACADE, Z_PARA), (sx * PAV_X, yb_pav, Z_PARA), (sx * PAV_X, yb_pav, PAV_TOP), (sx * PAV_X, Y_FACADE, PAV_TOP)], STONE, (sx, 0, 0))
    mb.poly_n([(-PAV_X, yb_pav, Z_PARA), (PAV_X, yb_pav, Z_PARA), (PAV_X, yb_pav, PAV_TOP), (-PAV_X, yb_pav, PAV_TOP)], STONE, (0, -1, 0))
    ledge_y = yb_pav
    mb.box(-PAV_X - 0.4, ledge_y - 0.6, PAV_CORN, PAV_X + 0.4, ledge_y + 0.1, PAV_CORN + 0.55, TRIM)
    mb.poly_n([(-PAV_X, yb_pav, PAV_TOP - 0.3), (PAV_X, yb_pav, PAV_TOP - 0.3), (PAV_X, Y_PAV, PAV_TOP - 0.3), (-PAV_X, Y_PAV, PAV_TOP - 0.3)], ROOF, (0, 0, 1))
    return mb.build("building")


# ---------------------------------------------------------------------------------- tower
def square(h):
    return [(-h, -h), (h, -h), (h, h), (-h, h)]


def face_frames():
    """(name, matrix) per tower face: local x along the face, local +y outward."""
    return [
        ("N", rotz(0.0)),  # outward +Y (front)
        ("E", rotz(-math.pi / 2)),  # outward +X
        ("S", rotz(math.pi)),  # outward -Y
        ("W", rotz(math.pi / 2)),  # outward -X
    ]


def build_tower(lights: fc.MeshBuilder) -> bpy.types.Object:
    mb = fc.MeshBuilder()
    H = TOWER_HALF
    z_shaft0, z_shaft1 = 18.0, 46.0
    for _, M in face_frames():
        mb.push(M @ tr(0, H))
        # shaft face with openings: two slits, one window, the clock panel (plain), window band
        mb.poly_n([(-H, 0, z_shaft0), (H, 0, z_shaft0), (H, 0, 23.6), (-H, 0, 23.6)], STONE, (0, 1, 0))
        wall_row(mb, -H, H, 23.6, 28.2, [dict(xc=-1.3, a=0.38, zo=24.4, zs=27.3, depth=0.35, seg=6), dict(xc=1.3, a=0.38, zo=24.4, zs=27.3, depth=0.35, seg=6)], pane=DARK)
        wall_row(mb, -H, H, 28.2, 32.6, [dict(xc=0.0, a=0.5, zo=29.0, zs=31.4, depth=0.35, seg=6)], pane=DARK)
        mb.poly_n([(-H, 0, 32.6), (H, 0, 32.6), (H, 0, 42.6), (-H, 0, 42.6)], STONE, (0, 1, 0))
        band = [dict(xc=-H + 1.1 + i * (2 * H - 2.2) / 4, a=0.42, zo=42.9, zs=44.0, depth=0.3, seg=4) for i in range(5)]
        wall_row(mb, -H, H, 42.6, 44.8, band, pane=DARK)
        mb.poly_n([(-H, 0, 44.8), (H, 0, 44.8), (H, 0, z_shaft1), (-H, 0, z_shaft1)], STONE, (0, 1, 0))
        # bands
        mb.box(-H - 0.3, 0, 20.4, H + 0.3, 0.3, 21.2, TRIM, skip=("-y",))
        mb.box(-H - 0.25, 0, 32.4, H + 0.25, 0.22, 32.8, TRIM, skip=("-y",))
        mb.box(-H - 0.25, 0, 41.8, H + 0.25, 0.22, 42.3, TRIM, skip=("-y",))
        # clock surround panel and dial
        mb.box(-4.3, 0, 32.8, 4.3, 0.12, 41.8, TRIM, skip=("-y", "-z"))
        mb.push(tr(0, 0.12, CLOCK_Z) @ Matrix.Rotation(-math.pi / 2, 4, "X"))
        # local z now points outward (+y in face frame)
        mb.lathe([(DIAL_R + 0.45, 0.0), (DIAL_R + 0.45, 0.16), (DIAL_R + 0.2, 0.28), (DIAL_R, 0.28), (DIAL_R, 0.12)], 32, BRONZE, smooth=False)
        mb.lathe([(DIAL_R, 0.12), (0.0, 0.12)], 32, DIAL, smooth=False)
        for h in range(12):
            ang = math.pi / 2 - h * math.pi / 6
            cx, cy = 2.85 * math.cos(ang), 2.85 * math.sin(ang)
            mb.push(tr(cx, cy, 0.12) @ rotz(ang - math.pi / 2))
            long = 0.75 if h % 3 == 0 else 0.5
            mb.box(-0.11, -long / 2, 0.0, 0.11, long / 2, 0.05, BRONZE, skip=("-z",))
            mb.pop()
        mb.pop()
        mb.pop()
    # corner quoins
    for sx in (1, -1):
        for sy in (1, -1):
            mb.box(sx * (H - 1.0), sy * (H - 1.0), 21.2, sx * (H + 0.22), sy * (H + 0.22), z_shaft1, STONE, skip=("-z", "+z"))
            lights.box(sx * (H + 0.22), sy * (H + 0.22), 21.2, sx * (H + 0.36), sy * (H + 0.36), z_shaft1, OUTLINE)

    # ---- cornice and balcony under the belfry
    mb.frustum(square(H + 0.3), square(H + 0.75), z_shaft1, z_shaft1 + 0.5, TRIM, top=False, bottom=True)
    mb.prism(square(H + 0.75), z_shaft1 + 0.5, z_shaft1 + 0.95, TRIM, top=True, bottom=False)
    zb0 = z_shaft1 + 0.95  # 46.95
    hb = H - 0.3  # belfry half width
    zb1 = 54.6
    for _, M in face_frames():
        mb.push(M @ tr(0, hb))
        ops = [dict(xc=-hb + 1.2 + i * (2 * hb - 2.4) / 4, a=0.62, zo=48.4, zs=52.5, depth=0.9, seg=6, keystone=False) for i in range(5)]
        wall_row(mb, -hb, hb, zb0, zb1, ops, pane=DARK)
        # columns between openings
        for i in range(6):
            if i in (0, 5):
                continue
            cx = -hb + 1.2 + (i - 0.5) * (2 * hb - 2.4) / 4
            mb.push(tr(cx, 0.18, 0))
            mb.cylinder(0.2, 48.4, 52.4, 8, TRIM, caps=False)
            mb.pop()
            mb.box(cx - 0.3, 0, 52.2, cx + 0.3, 0.42, 52.5, TRIM, skip=("-y",))
        # low balcony parapet
        mb.box(-hb - 0.6, 0.0, zb0, hb + 0.6, 0.55, zb0 + 1.05, TRIM, skip=("-y", "-z"))
        mb.box(-hb + 0.5, 0.55, zb0 + 0.25, hb - 0.5, 0.6, zb0 + 0.8, SHADE, skip=("-y",))
        mb.pop()
    for sx in (1, -1):
        for sy in (1, -1):
            mb.box(sx * (hb - 0.7), sy * (hb - 0.7), zb0, sx * (hb + 0.2), sy * (hb + 0.2), zb1, TRIM, skip=("-z", "+z"))
            lights.box(sx * (hb + 0.2), sy * (hb + 0.2), zb0 + 1.05, sx * (hb + 0.33), sy * (hb + 0.33), zb1, OUTLINE)
    # cornice over the belfry and the terrace parapet
    mb.frustum(square(hb + 0.25), square(hb + 0.8), zb1, zb1 + 0.5, TRIM, top=False, bottom=True)
    mb.prism(square(hb + 0.8), zb1 + 0.5, zb1 + 0.9, TRIM, top=True)
    zt = zb1 + 0.9  # 55.5
    for _, M in face_frames():
        mb.push(M @ tr(0, hb + 0.55))
        balustrade(mb, -hb - 0.25, hb + 0.25, zt, zt + 1.0, y=0.0, spacing=0.42)
        mb.pop()
    for sx in (1, -1):
        for sy in (1, -1):
            mb.box(sx * (hb + 0.05), sy * (hb + 0.05), zt, sx * (hb + 0.8), sy * (hb + 0.8), zt + 1.25, TRIM)

    # ---- upper stage (three arches a face)
    hu = 4.2
    zu1 = 61.4
    for _, M in face_frames():
        mb.push(M @ tr(0, hu))
        ops = [dict(xc=dx, a=0.72, zo=56.9, zs=59.6, depth=0.7, seg=6, keystone=True) for dx in (-2.3, 0.0, 2.3)]
        wall_row(mb, -hu, hu, zt, zu1, ops, pane=DARK)
        mb.pop()
    for sx in (1, -1):
        for sy in (1, -1):
            mb.box(sx * (hu - 0.6), sy * (hu - 0.6), zt, sx * (hu + 0.25), sy * (hu + 0.25), zu1, TRIM, skip=("-z",))
            lights.box(sx * (hu + 0.25), sy * (hu + 0.25), zt + 1.25, sx * (hu + 0.38), sy * (hu + 0.38), zu1, OUTLINE)
    mb.frustum(square(hu + 0.2), square(hu + 0.65), zu1, zu1 + 0.4, TRIM, top=False, bottom=True)
    mb.prism(square(hu + 0.65), zu1 + 0.4, zu1 + 0.7, TRIM, top=True)

    # ---- lantern: octagonal colonnade
    zl0 = zu1 + 0.7  # 62.1
    zl1 = 65.7
    oct_r = 2.9
    mb.lathe([(oct_r + 0.2, zl0), (oct_r + 0.2, zl0 + 0.45), (0.0, zl0 + 0.45)], 8, TRIM, smooth=False, phase=math.pi / 8)
    mb.lathe([(1.9, zl0 + 0.45), (1.9, zl1)], 8, SHADE, smooth=False, phase=math.pi / 8)
    for k in range(8):
        a = 2 * math.pi * k / 8 + math.pi / 8
        mb.push(tr(2.6 * math.cos(a), 2.6 * math.sin(a), 0))
        mb.cylinder(0.2, zl0 + 0.45, zl1, 8, TRIM, caps=False)
        mb.pop()
    mb.lathe([(0.0, zl1), (oct_r + 0.15, zl1), (oct_r + 0.15, zl1 + 0.6), (0.0, zl1 + 0.6)], 8, TRIM, smooth=False, phase=math.pi / 8)

    # ---- cupola, finial, flagpole
    zc = zl1 + 0.6  # 66.3
    dome = [(2.65, zc), (2.6, zc + 0.6), (2.42, zc + 1.3), (2.1, zc + 2.0), (1.62, zc + 2.6), (1.05, zc + 3.1), (0.45, zc + 3.45), (0.0, zc + 3.55)]
    mb.lathe(dome, 24, STONE, smooth=True)
    zt2 = zc + 3.5
    mb.lathe([(0.48, zt2), (0.48, zt2 + 0.7), (0.62, zt2 + 0.8), (0.0, zt2 + 0.8)], 12, TRIM, smooth=False)
    mb.sphere((0, 0, zt2 + 1.15), 0.36, 12, 6, TRIM)
    mb.lathe([(0.12, zt2 + 1.45), (0.07, 75.3), (0.0, 75.4)], 8, POLE, smooth=True)
    # outline lights: cornice loops and dome ribs
    for z, h in ((z_shaft1 + 0.95, H + 0.8), (zb1 + 0.9, hb + 0.85), (zu1 + 0.7, hu + 0.7)):
        for _, M in face_frames():
            lights.push(M)
            lights.box(-h, h, z - 0.02, h, h + 0.12, z + 0.1, OUTLINE)
            lights.pop()
    for k in range(8):
        a = 2 * math.pi * k / 8
        pts = [(r * 1.03 * math.cos(a), r * 1.03 * math.sin(a), z) for r, z in dome[:-1]]
        for p0, p1 in zip(pts, pts[1:]):
            lights.cyl_between(p0, p1, 0.07, 4, OUTLINE, smooth=False, caps=False)
    lights.lathe([(oct_r + 0.25, zl1 + 0.6), (oct_r + 0.25, zl1 + 0.72)], 16, OUTLINE, smooth=False)
    return mb.build("tower")


# ---------------------------------------------------------------------------- clock hands
def hand_mesh(length, width, tail, thick, mat) -> fc.MeshBuilder:
    """A hand pointing up (+Z in Blender = glTF +Y), lying in front of the dial (-Y)."""
    mb = fc.MeshBuilder()
    pts = [(-width / 2, -tail), (width / 2, -tail), (width * 0.32, length * 0.86), (0.0, length), (-width * 0.32, length * 0.86)]
    y0, y1 = -thick, 0.0
    # front (facing -Y, i.e. out of the dial) and back
    mb.poly_n([(x, y0, z) for x, z in pts], mat, (0, -1, 0))
    mb.poly_n([(x, y1, z) for x, z in pts], mat, (0, 1, 0))
    for i in range(len(pts)):
        (ax, az), (bx, bz) = pts[i], pts[(i + 1) % len(pts)]
        nx, nz = bz - az, -(bx - ax)
        mb.poly_n([(ax, y0, az), (bx, y0, bz), (bx, y1, bz), (ax, y1, az)], mat, (nx, 0, nz))
    return mb


COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]


def build_hands(root) -> list:
    out = []
    face_rot = {"N": math.pi, "E": math.pi / 2, "S": 0.0, "W": -math.pi / 2}
    face_normal = {"N": [0, 0, -1], "E": [1, 0, 0], "S": [0, 0, 1], "W": [-1, 0, 0]}  # glTF model frame
    face_turn = {"N": 0.0, "E": 90.0, "S": 180.0, "W": 270.0}  # bearing = heading + turn
    face_pos = {
        "N": (0.0, TOWER_HALF + 0.12, CLOCK_Z),
        "E": (TOWER_HALF + 0.12, 0.0, CLOCK_Z),
        "S": (0.0, -TOWER_HALF - 0.12, CLOCK_Z),
        "W": (-TOWER_HALF - 0.12, 0.0, CLOCK_Z),
    }
    for f in "NESW":
        for kind, length, width, off in (("hour", 2.25, 0.36, 0.2), ("minute", 3.15, 0.24, 0.3)):
            mb = hand_mesh(length, width, 0.45, 0.07, BRONZE)
            if kind == "minute":
                mb.push(Matrix.Rotation(math.pi / 2, 4, "X"))
                mb.cylinder(0.24, 0.0, 0.1, 12, BRONZE)  # centre boss, toward -Y after rotation
                mb.pop()
            # move the whole hand out in front of the dial plane (local -Y)
            for i, (x, y, z) in enumerate(mb.verts):
                mb.verts[i] = (x, y - off, z)
            ob = mb.build(f"clock_{kind}_{f}", parent=root, location=face_pos[f])
            ob.rotation_euler = (0.0, 0.0, face_rot[f])
            ob["clockHand"] = kind
            ob["clockAxis"] = [0, 0, 1]
            ob["clockFace"] = f
            # N/E/S/W name the dial in the MODEL frame; say so, and give the world direction
            # each dial faces once the landmark is placed (heading from the footprint)
            ob["clockFaceFrame"] = "model"
            ob["clockFaceNormal"] = face_normal[f]
            bearing = round((F["heading_deg"] + face_turn[f]) % 360.0, 1)
            ob["clockFaceBearingDeg"] = bearing
            ob["clockFaceCompass"] = COMPASS[int((bearing + 22.5) // 45) % 8]
            out.append(ob)
    return out


def main() -> None:
    root = fc.empty("ferry_building")
    root["fcLandmark"] = "ferry-building"
    root["sourceFootprint"] = F["bldg_id"]
    b = build_building()
    b.parent = root
    lights = fc.MeshBuilder()
    t = build_tower(lights)
    t.parent = root
    lo = lights.build("tower_outline_lights", parent=root)
    lo["nightLight"] = True
    build_hands(root)
    fc.export_glb("ferry-building.glb", BUDGET)


main()
