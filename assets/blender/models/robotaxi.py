"""The Meander robotaxi -> public/models/robotaxi.glb

Meander ("We'll get you there.") is most of the city's traffic. Owner, 2026-10-27: "make the
robotaxis look more like bigger Zoox or something". So the Meander is now a tall, two-ended
carriage pod of its own: the same both ways round, short overhangs and big wheels at the
corners, big glass and a light bar across each end.

It keeps the Meander's own marks: warm white paint, every sensor in one dark band round the
roof edge with the teal status line (light_status) in it, and one wide sliding door on the
kerb side only. It is not a copy of any real pod: nothing stands on the roof (no sensor
housings on the roof corners, the best-known pod's signature), the corners are white posts,
not dark glass, and the roof is white; the street side has no door (two windows either side
of a white post with the charging flap); no logo, badge, text or livery.

4.96 m long, 1.92 m wide (inside the sim's 5.0 x 2.0 m robotaxi box, src/sim/agents.ts
ROBOTAXI_BODY), 1.95 m to the roof; 3.40 m wheelbase, wheels 0.38 m in radius.

Nodes: robotaxi (root, origin on the ground at the body centre; extras fcActor, kerbSide)
  body
  door_slide_R   the kerb-side sliding door, shut, in the middle of the side. To open it, move
                 it out along local +X by extras popM, then back along local +Z by slideM
                 (glTF frame). The body under it is the dark cabin opening.
  sensor_band    no mesh: the middle of the sensor band's front, where its cameras look out;
                 the point to aim at when a mission says to water a rogue robotaxi's sensors
                 (extras sprayTarget)
  wheel_FL/FR/RL/RR   origin at the hub, spin about local X (extras wheel/spinAxis/radius/steer)
Front faces glTF -Z (headlight bar at the front, tail bar at the back; the body is the same
both ways). Budget: 10k triangles.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

from mathutils import Matrix  # noqa: E402

import fc  # noqa: E402
import vehicle as V  # noqa: E402

BUDGET = 10_000
HL, HW = 2.48, 0.96  # half length and half width of the lower body
RC = 0.32  # plan corner radius of the lower body
BOW = 0.07  # each end bows out this much at the middle
WB = 3.40
WR = 0.38
WW = 0.25
ARCH_R = 0.45
Y_F, Y_R = WB / 2, -WB / 2
ROOF_Z = 1.95

# the sliding door (Blender y of its front and rear edges) and how it opens
DOOR_Y = 0.68
SLIDE_M, POP_M = 1.36, 0.05
DOOR_OFF = 0.008
POST_Y = 0.24  # the street side's middle post: |y| under this is white between the windows

# Horizontal rings, bottom to top: (z, inset from the lower body's outline). The outline is
# offset inward by the inset, so the corners stay concentric and every column stays plumb
# in plan; above the belt the sides lean in (tumblehome).
Z_CLAD, Z_BELT, Z_GLASS, Z_BAND, Z_LINE0, Z_LINE1, Z_BAND_TOP, Z_ROOF_EDGE = 0.46, 0.88, 0.92, 1.76, 1.805, 1.83, 1.87, 1.90
RINGS = [
    (0.24, 0.035),
    (0.31, 0.0),
    (Z_CLAD, 0.0),
    (0.68, -0.004),
    (Z_BELT, 0.0),
    (Z_GLASS, 0.014),
    (1.40, 0.045),
    (Z_BAND, 0.080),
    (Z_BAND_TOP, 0.096),
    (Z_ROOF_EDGE, 0.135),
]
# side stations (front half; mirrored): the corner's start, the front arch, the door's edge
# and its dark post, the street side's middle post
ARCH_YS = [round(Y_F + ARCH_R * math.cos(math.pi * k / 10), 4) for k in range(1, 11)]
SIDE_HALF = sorted({HL - RC - BOW, *[y for y in ARCH_YS if y < HL - RC - BOW - 0.01], 1.05, DOOR_Y + 0.06, DOOR_Y, 0.45, POST_Y, 0.0}, reverse=True)
SIDE_YS = SIDE_HALF + [-y for y in reversed(SIDE_HALF) if y > 0]
N_END, N_ARC = 10, 6


def base_loop():
    """The lower body's outline in plan, as (x, y, nx, ny) with outward normals: the front end
    left to right, the front-right corner, the right side front to rear, the rear end, the
    left side, back to the front-left corner. Ends bow out by BOW at the middle."""
    a, b = HL, HW
    xe = b - RC
    ys = a - RC - BOW  # where the sides end and the corner arcs start

    def end_pt(x, sign):
        t = x / xe
        y = (a - BOW * t * t) * sign
        # outward normal of the bowed end: (2 BOW x / xe^2, +-1)
        nx, ny = 2 * BOW * x / (xe * xe), float(sign)
        ln = math.hypot(nx, ny)
        return (x, y, nx / ln, ny / ln)

    def arc(cx, cy, a0, a1, incl_end=False):
        out = []
        n = N_ARC + (1 if incl_end else 0)
        for k in range(1, n):
            t = math.radians(a0 + (a1 - a0) * k / N_ARC)
            out.append((cx + RC * math.cos(t), cy + RC * math.sin(t), math.cos(t), math.sin(t)))
        return out

    pts = []
    for k in range(N_END + 1):  # front end, left to right
        x = -xe + 2 * xe * k / N_END
        pts.append(end_pt(x, 1))
    pts += arc(xe, ys, 90, 0)
    for y in SIDE_YS:  # right side, front to rear
        pts.append((b, y, 1.0, 0.0))
    pts += arc(xe, -ys, 0, -90)
    for k in range(N_END + 1):  # rear end, right to left
        x = xe - 2 * xe * k / N_END
        pts.append(end_pt(x, -1))
    pts += arc(-xe, -ys, -90, -180)
    for y in reversed(SIDE_YS):  # left side, rear to front
        pts.append((-b, y, -1.0, 0.0))
    pts += arc(-xe, ys, 180, 90)
    return pts


def arch_z(x, y):
    """Lowest z of the body's skin at (x, y): raised over the wheels."""
    if abs(x) < 0.55:
        return 0.0
    for yw in (Y_F, Y_R):
        d = y - yw
        if abs(d) < ARCH_R:
            return WR + 0.02 + math.sqrt(ARCH_R**2 - d * d) * 0.98
    return 0.0


def region(x, y, nx, ny):
    """Which part of the outline a column belongs to."""
    if abs(nx) > 0.999:
        return "kerb" if nx > 0 else "street"
    if abs(ny) > 0.95:
        return "front" if ny > 0 else "rear"
    return "corner"


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

    loop = base_loop()
    n = len(loop)

    def ring_pt(i, k, raise_arch=True):
        x, y, nx, ny = loop[i]
        z, d = RINGS[k]
        px, py = x - nx * d, y - ny * d
        if raise_arch and z < Z_BELT:
            z = max(z, arch_z(x, y))
        return (px, py, z)

    def band_mat(k, i0, i1):
        """Material of the quad between rings k, k+1 and columns i0, i1."""
        z0, z1 = RINGS[k][0], RINGS[k + 1][0]
        xa, ya, nxa, nya = loop[i0]
        xb, yb, nxb, nyb = loop[i1]
        ym = (ya + yb) / 2
        reg = {region(*loop[i0]), region(*loop[i1])}
        side = "kerb" if reg == {"kerb"} else "street" if reg == {"street"} else None
        if z1 <= 0.31 + 1e-6:
            return clad
        if z1 <= Z_CLAD + 1e-6:
            return cabin if side == "kerb" and abs(ym) < DOOR_Y else clad
        if z1 <= Z_BELT + 1e-6:
            # behind the door: the dark cabin opening
            return cabin if side == "kerb" and abs(ym) < DOOR_Y else paint
        if z1 <= Z_GLASS + 1e-6:
            return cabin if side == "kerb" and abs(ym) < DOOR_Y else paint
        if z1 <= Z_BAND + 1e-6:
            if "corner" in reg:
                # a slim white post in the middle of each corner; the glass wraps round it
                ang = math.degrees(math.atan2(abs(nya + nyb), abs(nxa + nxb)))
                return paint if 30 <= ang <= 60 else glass
            if side == "kerb":
                if abs(ym) < DOOR_Y:
                    return cabin
                if abs(ym) < DOOR_Y + 0.06:
                    return clad  # the door's dark posts
            if side == "street" and abs(ym) < POST_Y:
                return paint
            return glass
        if z1 <= Z_BAND_TOP + 1e-6:
            return lens
        return paint

    body = fc.MeshBuilder()
    for k in range(len(RINGS) - 1):
        z0, d0 = RINGS[k]
        z1, d1 = RINGS[k + 1]
        lean = (d1 - d0) / (z1 - z0)
        for i in range(n):
            j = (i + 1) % n
            q = [ring_pt(i, k), ring_pt(j, k), ring_pt(j, k + 1), ring_pt(i, k + 1)]
            nx = (loop[i][2] + loop[j][2]) / 2
            ny = (loop[i][3] + loop[j][3]) / 2
            body.poly_n(q, band_mat(k, i, j), (nx, ny, lean), smooth=True)
    # the roof: a low crown inside the roof edge
    top = len(RINGS) - 1
    edge = [ring_pt(i, top) for i in range(n)]
    crown = [(x * 0.62, y * 0.86, ROOF_Z) for (x, y, _) in edge]
    for i in range(n):
        j = (i + 1) % n
        body.poly_n([edge[i], edge[j], crown[j], crown[i]], paint, (loop[i][2] * 0.3, loop[i][3] * 0.3, 1.0), smooth=True)
    body.poly_n(crown, paint, (0, 0, 1), smooth=True)
    # the underside between the wheels, so a low camera sees no hollow
    body.box(-0.64, -HL + 0.12, 0.215, 0.64, HL - 0.12, 0.235, under, skip=("+z",))
    body = V.weld(body)

    mb = fc.MeshBuilder()

    def strip_on(region_pred, z0, z1, off, mat, wrap=0.0):
        """A ribbon over the body's lower outline where region_pred(x, y, nx, ny) holds,
        from z0 to z1, pushed `off` outward."""
        for a in range(n):
            b = (a + 1) % n
            if not (region_pred(*loop[a]) and region_pred(*loop[b])):
                continue
            pa = [(loop[a][0] + loop[a][2] * off, loop[a][1] + loop[a][3] * off, z) for z in (z0, z1)]
            pb = [(loop[b][0] + loop[b][2] * off, loop[b][1] + loop[b][3] * off, z) for z in (z0, z1)]
            nx, ny = (loop[a][2] + loop[b][2]) / 2, (loop[a][3] + loop[b][3]) / 2
            mb.poly_n([pa[0], pb[0], pb[1], pa[1]], mat, (nx, ny, 0), smooth=True)

    # --- the light bars: across each end and round the corners, in a dark housing
    def end_zone(sign):
        lim = HL - RC - BOW - 0.02
        return lambda x, y, nx, ny: y * sign > lim
    for sign, mat in ((1, head), (-1, tail)):
        strip_on(end_zone(sign), 0.76, 0.90, 0.006, lens)
        strip_on(end_zone(sign), 0.795, 0.865, 0.012, mat)
    # a radar and camera patch low on each end
    for sign in (1, -1):
        y = sign * (HL + 0.004)
        mb.box(-0.16, y - 0.012 * sign, 0.48, 0.16, y + 0.004 * sign, 0.56, lens)

    # --- the teal status line round the sensor band, proud of it. One segment per flat side:
    # the renderer's distance copies keep every light triangle (agent-packing.ts simplifyPacked)
    flat = ("kerb", "street")
    outline = [i for i in range(n) if not (region(*loop[i]) in flat and region(*loop[i - 1]) == region(*loop[i]) == region(*loop[(i + 1) % n]))]
    zl = (Z_LINE0, Z_LINE1)
    for i, j in zip(outline, outline[1:] + outline[:1]):
        def pt(c, z):
            x, y, nx, ny = loop[c]
            t = (z - Z_BAND) / (Z_BAND_TOP - Z_BAND)
            d = RINGS[7][1] + (RINGS[8][1] - RINGS[7][1]) * t - 0.006
            return (x - nx * d, y - ny * d, z)
        nx = (loop[i][2] + loop[j][2]) / 2
        ny = (loop[i][3] + loop[j][3]) / 2
        mb.poly_n([pt(i, zl[0]), pt(j, zl[0]), pt(j, zl[1]), pt(i, zl[1])], status, (nx, ny, 0.1), smooth=True)

    # --- street side (left): the charging flap on the rear quarter
    mb.box(-(HW + 0.006), -1.02, 0.66, -(HW - 0.004), -0.80, 0.78, clad)
    # --- kerb side (right): the door's rail along the rear quarter, just above the belt, as
    # far back as the open door reaches
    mb.cyl_between((HW + 0.004, -DOOR_Y - 0.02, 0.93), (HW + 0.004, -DOOR_Y - SLIDE_M, 0.93), 0.007, 6, clad, caps=False)
    # wheel-arch liners
    for yw in (Y_F, Y_R):
        mb.push(Matrix.Translation((0, yw, WR + 0.02)) @ Matrix.Rotation(math.pi / 2, 4, "Y"))
        mb.lathe([(ARCH_R - 0.01, 0.93), (ARCH_R - 0.01, -0.93)], 12, under, smooth=False, arc=(math.pi / 2, 3 * math.pi / 2))
        mb.pop()
    body.add(mb)
    body.build("body", parent=root, sharp_angle=36)

    # --- the sliding door: the body's own kerb side between the door edges, from the sill to
    # the band, pushed out DOOR_OFF: dark cladding at the bottom, white to the belt, then its
    # window up to the band
    d = fc.MeshBuilder()
    door_cols = [i for i in range(n) if region(*loop[i]) == "kerb" and abs(loop[i][1]) <= DOOR_Y + 1e-6]
    for k in range(1, 7):  # rings 0.31 .. Z_BAND
        z0, z1 = RINGS[k][0], RINGS[k + 1][0]
        for a, b in zip(door_cols, door_cols[1:]):
            pa0, pb0 = ring_pt(a, k, False), ring_pt(b, k, False)
            pa1, pb1 = ring_pt(a, k + 1, False), ring_pt(b, k + 1, False)
            q = [(p[0] + DOOR_OFF, p[1], p[2]) for p in (pa0, pb0, pb1, pa1)]
            m = clad if z1 <= Z_CLAD + 1e-6 else paint if z1 <= Z_GLASS + 1e-6 else glass
            d.poly_n(q, m, (1, 0, 0.05), smooth=True)
    # the window's frame and the door's edges: dark rods so its outline reads from the street
    def side_pt(y, z, off):
        k = max(i for i in range(len(RINGS)) if RINGS[i][0] <= z + 1e-9)
        k = min(k, len(RINGS) - 2)
        z0, d0 = RINGS[k]
        z1, d1 = RINGS[k + 1]
        dd = d0 + (d1 - d0) * (z - z0) / (z1 - z0)
        return (HW - dd + off, y, z)
    for y in (DOOR_Y, -DOOR_Y):
        d.cyl_between(side_pt(y, 0.31, DOOR_OFF + 0.002), side_pt(y, Z_BELT, DOOR_OFF + 0.002), 0.007, 6, clad, caps=False)
        d.cyl_between(side_pt(y, Z_GLASS, DOOR_OFF + 0.003), side_pt(y, Z_BAND - 0.01, DOOR_OFF + 0.003), 0.014, 6, clad)
    for z in (Z_GLASS, Z_BAND - 0.01):
        d.cyl_between(side_pt(DOOR_Y, z, DOOR_OFF + 0.003), side_pt(-DOOR_Y, z, DOOR_OFF + 0.003), 0.010, 6, clad)
    xh = side_pt(-0.5, 0.88, DOOR_OFF)[0]
    d.box(xh - 0.002, -0.60, 0.87, xh + 0.012, -0.44, 0.89, clad)
    door = d.build("door_slide_R", parent=root, sharp_angle=40)
    door["door"] = "slide"
    door["kerbSide"] = True
    door["popAxis"] = [1, 0, 0]
    door["popM"] = POP_M
    door["slideAxis"] = [0, 0, 1]
    door["slideM"] = SLIDE_M

    # the spray target for "water its sensors": the front of the band, on the centre line
    zt = (Z_BAND + Z_BAND_TOP) / 2
    target = fc.empty("sensor_band", location=(0.0, HL - RINGS[7][1] + 0.005, zt), parent=root)
    target["sprayTarget"] = True

    for name, y, sx in (("wheel_FL", Y_F, -1), ("wheel_FR", Y_F, 1), ("wheel_RL", Y_R, -1), ("wheel_RR", Y_R, 1)):
        V.wheel(name, WR, WW, tire, rim, hub=clad, seg=22, spokes=6, side=sx, parent=root,
                location=(sx * (HW - WW / 2 - 0.035), y, WR), extras={"steer": name.startswith("wheel_F")})

    fc.export_glb("robotaxi.glb", BUDGET)


main()
