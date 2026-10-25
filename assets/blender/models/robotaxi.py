"""The Meander robotaxi -> public/models/robotaxi.glb

Meander ("We'll get you there.") is most of the city's traffic. The design follows the robot
table in docs/design.md: a long, low, asymmetric hatch with a sensor band wrapped along the
roof edge and one sliding kerb-side door; not an SUV with a roof dome, not a symmetric pod.

4.95 m long, 1.90 m wide, about 1.53 m to the top of the band, 3.05 m wheelbase. A short
round nose runs into a long raked windscreen, a flat roof and a fastback hatch. Every sensor
lives in one dark band (sensor_lens) round the roof edge, with a teal status line in it
(light_status, emissive). No dome, no corner pods, no mirror pods.

Asymmetric, because nobody drives it: the kerb side (the right, +X) has one wide sliding door
under one long window; the street side (the left) has no door at all, a solid panel with a
slim high window and a charging flap. Lights: short slim strips at the nose and tail
corners; no full-width bar, no grille, no badge, no text.

Nodes: robotaxi (root, origin on the ground at the body centre; extras fcActor, kerbSide)
  body
  door_slide_R   the kerb-side sliding door, shut. To open it, move it out along local +X by
                 extras popM, then back along local +Z by slideM (glTF frame). The body under
                 it is the dark cabin opening.
  sensor_band    no mesh: the middle of the roof band's front, where its cameras look out;
                 the point to aim at when a mission says to water a rogue robotaxi's sensors
                 (extras sprayTarget)
  wheel_FL/FR/RL/RR   origin at the hub, spin about local X (extras wheel/spinAxis/radius/steer)
Front faces glTF -Z. Budget: 10k triangles.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

from mathutils import Matrix, Vector  # noqa: E402

import fc  # noqa: E402
import vehicle as V  # noqa: E402

BUDGET = 10_000
WB = 3.05
WR = 0.36
WW = 0.23
ARCH_R = 0.43
Y_F, Y_R = WB / 2, -WB / 2
TUMBLE, SR, MID = 0.05, 0.09, 0.3  # body section shape (lib/vehicle.half_section)

# the sliding door: front and rear edges (Blender y) and how it opens
DOOR_F, DOOR_R = 0.85, -0.55
DOOR_WIN_F = 0.50  # the door's window starts behind the windscreen's foot
SLIDE_M, POP_M = 1.15, 0.05
DOOR_OFF = 0.008  # the door skin sits this far outside the body

# (y, half width, sill z, shoulder z, centre-top z), front to rear. The door edges are
# stations, so the body's faces stop exactly there.
STATIONS = [
    (2.475, 0.70, 0.36, 0.62, 0.64),
    (2.44, 0.82, 0.30, 0.70, 0.72),
    (2.36, 0.89, 0.27, 0.76, 0.79),
    (2.15, 0.935, 0.26, 0.82, 0.86),
    (1.80, 0.95, 0.25, 0.87, 0.92),
    (1.40, 0.95, 0.25, 0.90, 0.95),
    (DOOR_F, 0.95, 0.25, 0.92, 0.97),
    (0.0, 0.95, 0.25, 0.94, 0.99),
    (DOOR_R, 0.95, 0.25, 0.95, 1.00),
    (-1.00, 0.95, 0.25, 0.96, 1.01),
    (-1.90, 0.945, 0.26, 0.98, 1.03),
    (-2.20, 0.93, 0.28, 0.99, 1.04),
    (-2.38, 0.90, 0.31, 0.99, 1.03),
    (-2.475, 0.84, 0.36, 0.97, 1.00),
]
# greenhouse (y, roof half width, roof z, crown); None = the glass meets the body here.
# Windscreen from 1.45 back to 0.55, the roof to -1.65, then the hatch glass to the tail.
GLASS = [
    (1.45, None, None, 0.0),
    (0.55, 0.74, 1.46, 0.03),
    (DOOR_WIN_F, 0.745, 1.465, 0.03),
    (0.20, 0.76, 1.495, 0.035),
    (-0.50, 0.765, 1.50, 0.035),
    (DOOR_R, 0.765, 1.50, 0.035),
    (-1.40, 0.755, 1.47, 0.03),
    (-1.65, 0.74, 1.435, 0.028),
    (-2.40, None, None, 0.0),
]
PILLARS = dict(b=(DOOR_R, -0.50), c=-1.65)
ROOF = [(s[0], s[1], s[2], s[3]) for s in GLASS if s[1] is not None]


def side_section(y):
    """The body's right side at y, from above the rocker to the belt: [(x, z)] going up
    (lib/vehicle.half_section points 2..5, with the sill raised over the wheel arches the
    way car_body raises it)."""
    hw, zb, zs, zc = V.interp(STATIONS, y)
    for yw in (Y_F, Y_R):
        dy = y - yw
        if abs(dy) < ARCH_R:
            zb = max(zb, WR + 0.02 + math.sqrt(ARCH_R**2 - dy**2) * 0.98)
    return V.half_section(hw, zb, zs, zc, tumble=TUMBLE, sr=SR, mid=MID)[2:6]


def side_x(y, z):
    """x of the body's right side surface at (y, z), for z between the rocker and the belt."""
    sec = side_section(y)
    for (x0, z0), (x1, z1) in zip(sec, sec[1:]):
        if z0 <= z <= z1:
            return x0 + (x1 - x0) * (z - z0) / (z1 - z0)
    raise ValueError(f"z {z} is off the side at y {y}")


def glass_edge(y):
    """Belt point (x, z) and roof-edge point (x, z) of the right side glass at y (cabin)."""
    hw, zb, zs, zc = V.interp(STATIONS, y)
    hr, zr, _ = V.interp(ROOF, y)
    return (hw - TUMBLE - SR, zs), (hr, zr)


def glass_point(y, t, off, side=1):
    """A point on the side glass at y, t of the way from the belt (0) to the roof edge (1),
    pushed `off` out along the glass's outward normal."""
    (bx, bz), (rx, rz) = glass_edge(y)
    dx, dz = rx - bx, rz - bz
    ln = math.hypot(dx, dz)
    nx, nz = dz / ln, -dx / ln
    return (side * (bx + dx * t + nx * off), y, bz + dz * t + nz * off)


def shut_line(mb, pts, mat, r=0.0045):
    """A panel shut line: a thin dark rod along the body surface through pts (x, y, z)."""
    for p0, p1 in zip(pts, pts[1:]):
        mb.cyl_between(p0, p1, r, 5, mat, caps=False)


def surface_point(y, x_frac, top=True):
    """A point just proud of the body surface at y, at x_frac of the half width (top: on the
    bonnet/roof side of the shoulder, else on the flank between rocker and belt)."""
    hw, zb, zs, zc = V.interp(STATIONS, y)
    half = V.half_section(hw, zb, zs, zc, tumble=TUMBLE, sr=SR, mid=MID)
    pts = half[4:] if top else half[1:5]
    # walk the polyline by x (top) or z (flank) and interpolate
    if top:
        x = (hw - TUMBLE - SR) * x_frac
        for (x0, z0), (x1, z1) in zip(pts, pts[1:]):
            if min(x0, x1) <= x <= max(x0, x1) and x0 != x1:
                z = z0 + (z1 - z0) * (x - x0) / (x1 - x0)
                return (x, y, z + 0.004)
        return (x, y, zc + 0.004)
    sec = side_section(y)
    z = sec[0][1] + (sec[-1][1] - sec[0][1]) * x_frac
    return (side_x(y, z) + 0.004, y, z)


def band_loop(rc=0.15, n_side=16, n_end=8, n_arc=5):
    """Points round the roof edge (x, y, z) with their outward plan normals (nx, ny): the
    front-right corner, the right side, the rear corners, the left side, the front-left
    corner and the front edge (the windscreen header). z follows the roof's crown."""
    yf, yr = ROOF[0][0], ROOF[-1][0]

    def z_at(x, y):
        hr, zr, cr = V.interp(ROOF, y)
        return zr + cr * max(0.0, 1.0 - abs(x) / hr)

    def arc(cx, cy, a0, a1):
        out = []
        for k in range(n_arc + 1):
            a = math.radians(a0 + (a1 - a0) * k / n_arc)
            x, y = cx + rc * math.cos(a), cy + rc * math.sin(a)
            out.append((x, y, z_at(x, y), math.cos(a), math.sin(a)))
        return out

    hf = V.interp(ROOF, yf - rc)[0]
    hb = V.interp(ROOF, yr + rc)[0]
    pts = arc(hf - rc, yf - rc, 90, 0)
    for k in range(1, n_side):
        y = yf - rc + (yr + rc - (yf - rc)) * k / n_side
        hr = V.interp(ROOF, y)[0]
        pts.append((hr, y, z_at(hr, y), 1.0, 0.0))
    pts += arc(hb - rc, yr + rc, 0, -90)
    for k in range(1, n_end):
        x = (hb - rc) - 2 * (hb - rc) * k / n_end
        pts.append((x, yr, z_at(x, yr), 0.0, -1.0))
    pts += arc(-(hb - rc), yr + rc, -90, -180)
    for k in range(1, n_side):
        y = yr + rc + (yf - rc - (yr + rc)) * k / n_side
        hr = V.interp(ROOF, y)[0]
        pts.append((-hr, y, z_at(-hr, y), -1.0, 0.0))
    pts += arc(-(hf - rc), yf - rc, 180, 90)
    for k in range(1, n_end):
        x = -(hf - rc) + 2 * (hf - rc) * k / n_end
        pts.append((x, yf, z_at(x, yf), 0.0, 1.0))
    return pts


def ribbon(mb, loop, section, mats):
    """Sweep an open cross-section [(out, dz)] round the closed loop; mats[j] per segment.
    Each quad faces away from the section's inside: normal (-d dz, d out) per segment."""
    rows = [[(x + o * nx, y + o * ny, z + dz) for (o, dz) in section] for (x, y, z, nx, ny) in loop]
    rows.append(rows[0])
    norms = [(-(b[1] - a[1]), b[0] - a[0]) for a, b in zip(section, section[1:])]
    n = len(loop)
    for i in range(n):
        nx = (loop[i][3] + loop[(i + 1) % n][3]) / 2
        ny = (loop[i][4] + loop[(i + 1) % n][4]) / 2
        for j, (no, nz) in enumerate(norms):
            q = [rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]]
            mb.poly_n(q, mats[j], (no * nx, no * ny, nz), smooth=True)


def glass_panel(mb, ys, lo, hi, side, off, mat):
    """A panel on the side glass between heights lo..hi (0 = belt, 1 = roof edge) at the
    stations ys (front to rear), pushed `off` out from the glass."""
    for y0, y1 in zip(ys, ys[1:]):
        a, b = glass_point(y0, lo, off, side), glass_point(y0, hi, off, side)
        c, d = glass_point(y1, hi, off, side), glass_point(y1, lo, off, side)
        mb.poly_n([a, b, c, d], mat, (side, 0, 0.1))


def main() -> None:
    fc.reset()
    # An off-white rather than paper white (it no longer blows out in sun), and glass as glass:
    # dielectric and smooth. The renderer adds a clear lacquer lobe to both (agent-packing.ts).
    paint = fc.material("paint_white", "#dfe2df", 0.34, 0.0)
    glass = fc.material("glass", "#1b232b", 0.05, 0.0)
    seam = fc.material("seam", "#090a0b", 0.8)
    clad = fc.material("cladding", "#3a3e44", 0.7)
    under = fc.material("underbody", "#0e0f10", 0.9)
    cabin = fc.material("cabin_dark", "#17191c", 0.9)
    tire = fc.material("tire", "#151515", 0.85)
    rim = fc.material("rim", "#c3c8cc", 0.35, 0.7)
    lens = fc.material("sensor_lens", "#0e1319", 0.06, 0.4)
    head = fc.material("light_headlight", "#f4f6f8", 0.2, emission="#f2f7ff", strength=1.0)
    tail = fc.material("light_taillight", "#8a1010", 0.3, emission="#ff2a1a", strength=1.0)
    status = fc.material("light_status", "#2fd6c1", 0.3, emission="#2fffe0", strength=1.0)

    root = fc.empty("robotaxi")
    root["fcActor"] = "robotaxi"
    root["kerbSide"] = "right"
    body, _ = V.car_body(STATIONS, GLASS, (Y_F, Y_R), WR, ARCH_R,
                         dict(paint=paint, glass=glass, trim=clad, under=under, roof=paint),
                         pillars=PILLARS, clad_segments=1, mid=MID, tumble=TUMBLE, sr=SR)

    # The kerb-side door opening: the body's side panel and window under the door become the
    # dark cabin, so the opening shows when the door slides away (the door covers it when shut).
    belt = V.interp(STATIONS, 0.0)[2]
    body.mats.append(cabin)
    cabin_i = len(body.mats) - 1
    for fi, f in enumerate(body.faces):
        c = sum((Vector(body.verts[vi]) for vi in f), Vector((0, 0, 0))) / len(f)
        m = body.mats[body.face_mat[fi]]
        if c.x < 0.6:
            continue
        if m == paint and DOOR_R < c.y < DOOR_F and 0.33 < c.z < belt - 0.01:
            body.face_mat[fi] = cabin_i
        elif m == glass and DOOR_R < c.y < DOOR_WIN_F and c.z > belt:
            body.face_mat[fi] = cabin_i

    mb = fc.MeshBuilder()

    # --- the sensor band round the roof edge: a white cap down onto the roof, a dark sensor
    # face, tucked under the glass edge; a teal status line along its middle
    loop = band_loop()
    ribbon(mb, loop, [(-0.08, 0.0), (-0.075, 0.03), (0.008, 0.034), (0.02, 0.018), (0.022, -0.045), (0.012, -0.078), (-0.03, -0.082)],
           [paint, paint, lens, lens, lens, lens])
    ribbon(mb, loop, [(0.0235, -0.006), (0.0235, -0.022)], [status])

    # --- street side (left): a solid panel over the lower part of the side glass, so the
    # window is a slim strip under the band; a charging flap on the rear quarter
    glass_panel(mb, [0.45, DOOR_WIN_F - 0.3, 0.0, -0.5, -0.9, -1.3, -1.6], 0.0, 0.62, -1, 0.006, paint)
    xf = side_x(-1.84, 0.85)
    mb.box(-(xf + 0.008), -1.95, 0.81, -(xf - 0.004), -1.73, 0.89, clad)

    # --- kerb side (right): the door's rail along the rear quarter, just below the belt
    rail = [(side_x(y, 0.875) + 0.003, y, 0.875) for y in (DOOR_R - 0.02, -0.8, -1.0, -1.2, -1.4, -1.6, -1.8)]
    for p0, p1 in zip(rail, rail[1:]):
        mb.cyl_between(p0, p1, 0.008, 6, clad, caps=False)

    # --- panel shut lines: the bonnet's rear edge and its sides along the shoulders, and the
    # bumper splits at the nose and tail corners, so the body reads as pressed panels
    yb = 1.52
    shut_line(mb, [surface_point(yb, f) for f in (-0.98, -0.6, -0.3, 0.0, 0.3, 0.6, 0.98)], seam)
    for sx in (1, -1):
        side_pts = [surface_point(y, 0.98) for y in (yb, 1.8, 2.1, 2.3)]
        shut_line(mb, [(sx * x, y, z) for x, y, z in side_pts], seam)
        for yy, lo, hi in ((2.25, 0.08, 0.62), (-2.30, 0.12, 0.66)):
            flank = [surface_point(yy, t, top=False) for t in (lo, (lo + hi) / 2, hi)]
            shut_line(mb, [(sx * x, y, z) for x, y, z in flank], seam)
    # --- front: short slim headlight strips at the nose corners in dark lamp housings, a
    # radar patch low down
    for sx in (1, -1):
        V.strip(mb, sx * 0.36, sx * 0.62, 2.455, 2.47, 0.58, 0.06, lens)
        V.strip(mb, sx * 0.38, sx * 0.60, 2.462, 2.49, 0.585, 0.035, head)
    mb.box(-0.14, 2.462, 0.42, 0.14, 2.486, 0.50, lens)
    # --- rear: short tail strips at the corners and the hatch's lower seam
    for sx in (1, -1):
        V.strip(mb, sx * 0.42, sx * 0.78, -2.475, -2.455, 0.895, 0.065, lens)
        V.strip(mb, sx * 0.44, sx * 0.76, -2.49, -2.462, 0.90, 0.04, tail)
    mb.box(-0.42, -2.488, 0.86, 0.42, -2.47, 0.872, clad)
    # wheel-arch liners
    for yw in (Y_F, Y_R):
        mb.push(Matrix.Translation((0, yw, WR + 0.02)) @ Matrix.Rotation(math.pi / 2, 4, "Y"))
        mb.lathe([(ARCH_R - 0.01, 0.92), (ARCH_R - 0.01, -0.92)], 12, under, smooth=False, arc=(math.pi / 2, 3 * math.pi / 2))
        mb.pop()
    body.add(mb)
    body.build("body", parent=root, sharp_angle=38)

    # --- the sliding door: the body's own side between the door edges, from the rocker to
    # the belt, pushed out DOOR_OFF; its window from the belt to under the band; a window
    # post at the window's front edge and a handle near the rear edge
    d = fc.MeshBuilder()
    ys = [DOOR_F, 0.6, DOOR_WIN_F, 0.2, -0.2, DOOR_R]
    rows = []
    for y in ys:
        sec = side_section(y)
        row = []
        for i, (x, z) in enumerate(sec):
            a, b = sec[max(i - 1, 0)], sec[min(i + 1, len(sec) - 1)]
            tx, tz = b[0] - a[0], b[1] - a[1]
            ln = math.hypot(tx, tz)
            row.append((x + tz / ln * DOOR_OFF, y, z - tx / ln * DOOR_OFF))
        rows.append(row)
    for r0, r1 in zip(rows, rows[1:]):
        for j in range(len(r0) - 1):
            tx, tz = r0[j + 1][0] - r0[j][0], r0[j + 1][2] - r0[j][2]
            d.poly_n([r0[j], r0[j + 1], r1[j + 1], r1[j]], paint, (tz, 0.0, -tx), smooth=True)
    win_ys = [DOOR_WIN_F, 0.2, -0.2, DOOR_R]
    glass_panel(d, win_ys, 0.0, 0.82, 1, DOOR_OFF, glass)
    d.cyl_between(glass_point(DOOR_WIN_F, 0.0, DOOR_OFF + 0.004), glass_point(DOOR_WIN_F, 0.82, DOOR_OFF + 0.004), 0.012, 6, clad)
    for y0, y1 in zip(win_ys, win_ys[1:]):  # the window's top rail
        d.cyl_between(glass_point(y0, 0.82, DOOR_OFF + 0.002), glass_point(y1, 0.82, DOOR_OFF + 0.002), 0.008, 6, clad, caps=False)
    # dark seams down the door's front and rear edges, so its outline reads from the street
    for y, row in ((DOOR_F, rows[0]), (DOOR_R, rows[-1])):
        for p0, p1 in zip(row, row[1:]):
            d.cyl_between((p0[0] + 0.002, y, p0[2]), (p1[0] + 0.002, y, p1[2]), 0.007, 6, clad, caps=False)
    d.cyl_between(glass_point(DOOR_R, 0.0, DOOR_OFF + 0.002), glass_point(DOOR_R, 0.82, DOOR_OFF + 0.002), 0.007, 6, clad, caps=False)
    xh = side_x(-0.4, 0.80) + DOOR_OFF
    d.box(xh - 0.002, -0.47, 0.79, xh + 0.010, -0.31, 0.81, clad)
    # the spray target for "water its sensors": the front of the band, on the centre line
    hr, zr, cr = V.interp(ROOF, ROOF[0][0])
    target = fc.empty("sensor_band", location=(0.0, ROOF[0][0] + 0.02, zr + cr - 0.02), parent=root)
    target["sprayTarget"] = True
    door = d.build("door_slide_R", parent=root, sharp_angle=40)
    door["door"] = "slide"
    door["kerbSide"] = True
    door["popAxis"] = [1, 0, 0]
    door["popM"] = POP_M
    door["slideAxis"] = [0, 0, 1]
    door["slideM"] = SLIDE_M

    for name, y, sx in (("wheel_FL", Y_F, -1), ("wheel_FR", Y_F, 1), ("wheel_RL", Y_R, -1), ("wheel_RR", Y_R, 1)):
        V.wheel(name, WR, WW, tire, rim, hub=clad, seg=24, spokes=7, side=sx, parent=root,
                location=(sx * (0.95 - WW / 2 - 0.03), y, WR), extras={"steer": name.startswith("wheel_F")})

    fc.export_glb("robotaxi.glb", BUDGET)


main()
