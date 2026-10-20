"""A 40 ft low-floor city bus in red and white -> public/models/muni-bus.glb

12.2 m long, 2.59 m wide, 3.2 m to the roof (3.4 m over the roof pods). Battery-electric:
roof pods instead of an exhaust stack. Two right-hand doors (front, centre), a big wrap-round
windscreen, a dark destination sign over it (light_destination_sign, emissive, blank: the
renderer can draw on it), red lower body and front, white window band. No logos, no text.

The large ad panel on each side between the axles uses its own material named "livery"
with UVs spanning the panel 0..1 (u along the bus as seen from outside, v up), so the
renderer can swap in generated ad textures. The default texture is an abstract placeholder.

Nodes: muni_bus (root, ground, body centre), body, livery_panel (both ad panels; the only
mesh with UVs), wheel_FL/FR/RL/RR (origin at the hub, spin about local X). Front faces glTF -Z. Budget: 12k triangles.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402
from mathutils import Matrix  # noqa: E402

import fc  # noqa: E402
import vehicle as V  # noqa: E402

BUDGET = 12_000
L, W, H = 12.20, 2.59, 3.20
HL, HW = L / 2, W / 2
WR = 0.50
Y_F, Y_R = 3.75, -3.45  # axles (front overhang 2.35, rear 2.65)
Z_FLOOR = 0.32
Z_WIN0, Z_WIN1 = 1.20, 2.55
ARCH_R = 0.58
PANEL = (-2.55, 2.75, 0.50, 1.10)  # livery panel: y0, y1, z0, z1
TEX_DIR = os.path.join(fc.BLENDER_DIR, ".cache", "textures")


def livery_png(path):
    """Abstract placeholder ad: soft gradient, two circles and bars. No words, no marks."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    w, h = 512, 128
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    u, v = x / w, 1 - y / h
    r = 0.12 + 0.55 * u
    g = 0.20 + 0.35 * (1 - u) + 0.1 * v
    b = 0.55 + 0.35 * v
    for cx, cy, rad, col in ((0.18, 0.52, 0.36, (1.0, 0.85, 0.35)), (0.27, 0.40, 0.22, (1.0, 0.45, 0.3))):
        d = np.sqrt(((u - cx) * w / h) ** 2 + (v - cy) ** 2)
        m = (d < rad).astype(np.float32)
        r, g, b = r * (1 - m) + col[0] * m, g * (1 - m) + col[1] * m, b * (1 - m) + col[2] * m
    for k, (y0, y1, x1) in enumerate(((0.62, 0.74, 0.86), (0.42, 0.50, 0.74), (0.26, 0.33, 0.66))):
        m = ((u > 0.48) & (u < x1) & (v > y0) & (v < y1)).astype(np.float32)
        r, g, b = r * (1 - m) + 0.98 * m, g * (1 - m) + 0.98 * m, b * (1 - m) + 0.98 * m
    img = bpy.data.images.new("livery_placeholder", w, h, alpha=False)
    rgba = np.stack([r, g, b, np.ones_like(r)], axis=-1)
    img.pixels.foreach_set(rgba.ravel().astype(np.float32))  # rows bottom-up, v up already
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    return path


def main() -> None:
    fc.reset()
    red = fc.material("paint_red", "#c41f2c", 0.38, 0.1)
    white = fc.material("paint_white", "#f2f2ee", 0.35, 0.05)
    grey = fc.material("roof_grey", "#b9bdc0", 0.5, 0.1)
    dark = fc.material("trim_black", "#17191c", 0.55)
    glass = fc.material("glass", "#1a232b", 0.08, 0.55)
    tire = fc.material("tire", "#151515", 0.85)
    rim = fc.material("rim", "#c3c7cb", 0.3, 0.85)
    head = fc.material("light_headlight", "#f4f6f8", 0.2, emission="#fff4e0", strength=1.0)
    tail = fc.material("light_taillight", "#8a1010", 0.3, emission="#ff2a1a", strength=1.0)
    sign = fc.material("light_destination_sign", "#151719", 0.4, emission="#ffb347", strength=1.0)
    livery = fc.material("livery", "#ffffff", 0.45, image=livery_png(os.path.join(TEX_DIR, "livery.png")))

    root = fc.empty("muni_bus")
    root["fcActor"] = "muni-bus"
    body = fc.MeshBuilder()
    mb = fc.MeshBuilder()

    # ---- the box: lofted rounded-rectangle sections, arches carved into the skirt
    def sill(y):
        z = Z_FLOOR - 0.05
        for yw in (Y_F, Y_R):
            d = y - yw
            if abs(d) < ARCH_R:
                z = max(z, WR + 0.03 + math.sqrt(ARCH_R**2 - d**2))
        return z

    def section(y):
        zb = sill(y)
        r_top = 0.28
        hw = HW
        # front/rear: slight taper in plan at the very ends
        if y > HL - 0.12:
            hw = HW - 0.05
        if y < -HL + 0.12:
            hw = HW - 0.04
        half = [(0.0, zb), (hw - 0.06, zb), (hw, zb + 0.06), (hw, 1.15), (hw, H - r_top),
                (hw - r_top * 0.3, H - r_top * 0.3), (hw - r_top, H), (0.0, H)]
        return V.full_ring(half)

    ys = {HL, HL - 0.12, -HL + 0.12, -HL, 0.0, PANEL[0], PANEL[1]}
    for yw in (Y_F, Y_R):
        for k in range(11):
            ys.add(round(yw + ARCH_R * 1.02 * math.cos(math.pi * k / 10), 4))
    ys = sorted(ys, reverse=True)

    def seg_mat(j, y0, y1):
        last = 14
        if j in (0, last - 1):
            return dark
        if j in (1, last - 2):
            return dark
        if j in (2, last - 3):
            return red  # lower side
        if j in (3, last - 4):
            return white  # window band (glass is applied over it)
        return grey  # roof edge and roof

    V.loft_body(body, ys, section, seg_mat, axis_z=1.6, cap_front=red, cap_rear=red)
    body = V.weld(body)

    # ---- windows: glass panels proud of the sides, with dark mullions
    for sx in (1, -1):
        x = sx * (HW + 0.004)
        spans = [(-5.7, -3.9), (-3.8, -2.0), (-1.9, -0.1), (0.0, 1.5)] if sx > 0 else \
                [(-5.7, -3.9), (-3.8, -2.0), (-1.9, -0.1), (0.0, 1.8), (1.9, 3.6), (3.7, 5.5)]
        if sx > 0:
            spans += [(2.75, 3.85)]  # behind the front door (front door at 4.0..5.2)
        for y0, y1 in spans:
            body_pts = [(x, y0, Z_WIN0), (x, y1, Z_WIN0), (x, y1, Z_WIN1), (x, y0, Z_WIN1)]
            mb.poly_n(body_pts, glass, (sx, 0, 0))
        mb.box(sx * HW - 0.01, -HL + 0.3, Z_WIN0 - 0.06, sx * (HW + 0.012), HL - 0.4, Z_WIN0, dark)
    # doors (right side): centre door between the axles, front door ahead of the front axle
    for (y0, y1) in ((1.55, 2.70), (4.35, 5.55)):
        mb.poly_n([(HW + 0.006, y0, 0.36), (HW + 0.006, y1, 0.36), (HW + 0.006, y1, 2.62), (HW + 0.006, y0, 2.62)], glass, (1, 0, 0))
        ym = (y0 + y1) / 2
        mb.box(HW, ym - 0.03, 0.36, HW + 0.02, ym + 0.03, 2.62, dark)
        for yy in (y0, y1):
            mb.box(HW, yy - 0.04, 0.36, HW + 0.02, yy + 0.04, 2.66, dark)
        mb.box(HW, y0 - 0.04, 2.62, HW + 0.02, y1 + 0.04, 2.68, dark)
    # ---- livery panels (both sides, own node so only they carry UVs), UV 0..1 across each
    # panel as seen from outside: u runs left to right, v bottom to top
    y0, y1, z0, z1 = PANEL
    lv = fc.MeshBuilder()
    for sx in (1, -1):
        x = sx * (HW + 0.006)
        if sx > 0:  # right side, seen from +X: forward (+Y) is to the right
            pts = [(x, y0, z0), (x, y1, z0), (x, y1, z1), (x, y0, z1)]
        else:  # left side, seen from -X: forward is to the left
            pts = [(x, y1, z0), (x, y0, z0), (x, y0, z1), (x, y1, z1)]
        lv.poly_n(pts, livery, (sx, 0, 0), uv=[(0, 0), (1, 0), (1, 1), (0, 1)])
        mb.box(sx * HW, y0 - 0.05, z0 - 0.05, sx * (HW + 0.004), y1 + 0.05, z1 + 0.05, dark)
    # ---- front: big windscreen, destination sign, lights, bumper
    yf = HL + 0.002
    mb.poly_n([(-HW + 0.12, yf, 1.0), (HW - 0.12, yf, 1.0), (HW - 0.12, yf, 2.62), (-HW + 0.12, yf, 2.62)], glass, (0, 1, 0))
    mb.box(-HW + 0.18, yf, 2.70, HW - 0.18, yf + 0.03, 3.02, dark)
    mb.poly_n([(-HW + 0.24, yf + 0.032, 2.75), (HW - 0.24, yf + 0.032, 2.75), (HW - 0.24, yf + 0.032, 2.97), (-HW + 0.24, yf + 0.032, 2.97)], sign, (0, 1, 0))
    for sx in (1, -1):
        V.strip(mb, sx * 0.85, sx * 1.18, yf, yf + 0.04, 0.72, 0.16, head)
    mb.box(-HW + 0.02, yf - 0.05, 0.28, HW - 0.02, yf + 0.08, 0.50, dark)  # bumper
    mb.box(-0.02, yf, 1.0, 0.02, yf + 0.02, 2.62, dark)  # windscreen divider
    # folded front bike rack (an SF bus fixture): two rails and a frame on the bumper
    rack = fc.material("rack_metal", "#4a4f55", 0.45, 0.7)
    for sx in (1, -1):
        mb.box(sx * 0.62, yf + 0.08, 0.42, sx * 0.68, yf + 0.16, 1.02, rack)
    for z in (0.62, 0.98):
        mb.box(-0.68, yf + 0.08, z - 0.03, 0.68, yf + 0.16, z + 0.03, rack)
    mb.box(-0.55, yf + 0.16, 0.95, 0.55, yf + 0.20, 1.0, rack)
    # ---- rear: lights, small rear window, bumper
    yr = -HL - 0.002
    mb.poly_n([(-HW + 0.3, yr, 2.0), (HW - 0.3, yr, 2.0), (HW - 0.3, yr, 2.6), (-HW + 0.3, yr, 2.6)], glass, (0, -1, 0))
    for sx in (1, -1):
        mb.box(sx * 0.95, yr - 0.04, 0.7, sx * 1.2, yr, 1.25, tail)
    mb.box(-HW + 0.02, yr - 0.08, 0.28, HW - 0.02, yr + 0.05, 0.52, dark)
    # ---- roof: battery and HVAC pods, a front fairing
    mb.box(-1.0, -1.8, H - 0.01, 1.0, 2.6, H + 0.22, grey)
    mb.box(-0.9, -4.6, H - 0.01, 0.9, -2.4, H + 0.26, grey)
    mb.box(-1.05, 2.6, H - 0.01, 1.05, 3.4, H + 0.12, grey)
    for y in (-4.0, -3.2):
        mb.box(-0.7, y - 0.25, H + 0.26, 0.7, y + 0.25, H + 0.28, dark)
    # mirrors on arms ahead of the front corners
    for sx in (1, -1):
        mb.box(sx * (HW - 0.05), HL - 0.1, 2.55, sx * (HW + 0.25), HL + 0.15, 2.6, dark)
        mb.box(sx * (HW + 0.18), HL + 0.12, 2.1, sx * (HW + 0.3), HL + 0.22, 2.55, dark)
    # wheel-arch liners
    for yw in (Y_F, Y_R):
        mb.push(Matrix.Translation((0, yw, WR + 0.03)) @ Matrix.Rotation(math.pi / 2, 4, "Y"))
        mb.lathe([(ARCH_R - 0.01, HW - 0.02), (ARCH_R - 0.01, -HW + 0.02)], 12, dark, smooth=False, arc=(math.pi / 2, 3 * math.pi / 2))
        mb.pop()
    body.add(mb)
    body.build("body", parent=root, sharp_angle=40)
    panel = lv.build("livery_panel", parent=root)
    panel["livery"] = {"material": "livery", "uv": "0..1 per side, u left to right as seen from outside, v up",
                       "aspect": round((y1 - y0) / (z1 - z0), 3)}

    for name, y, sx, ww in (("wheel_FL", Y_F, -1, 0.30), ("wheel_FR", Y_F, 1, 0.30), ("wheel_RL", Y_R, -1, 0.56), ("wheel_RR", Y_R, 1, 0.56)):
        V.wheel(name, WR, ww, tire, rim, hub=dark, seg=18, spokes=8, side=sx, parent=root,
                location=(sx * (HW - ww / 2 - 0.05), y, WR), extras={"steer": name.startswith("wheel_F")})

    fc.export_glb("muni-bus.glb", BUDGET)


main()
