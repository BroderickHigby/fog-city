"""Street props -> public/models/{hydrant,drinking-fountain,traffic-cone,repair-kiosk,vendor-cart,wheelchair}.glb

  hydrant            SF-style fire hydrant (0.8 m): white barrel, blue bonnet, two side outlets
                     and a front pumper outlet. Node refill_point = where the hose couples.
  drinking-fountain  a pedestal drinking fountain with a bottle filler (1.0 m). refill_point.
  traffic-cone       a 0.7 m orange cone with white bands on a square base (thrown with `cone`).
  repair-kiosk       where heaps are hauled and robots are "Restored from backup": a booth with
                     an open service bay facing -Z, a blank screen (light_kiosk_screen), a status
                     ring (light_kiosk_status) and a heart-and-wrench mark. Node bay = the spot a
                     robot stands to reboot.
  vendor-cart        the coworking vendor's cart: counter, pour-over station, burrito warmer, a
                     row of spare blaster tanks, striped awning, blank sign slot (node sign_slot).
  wheelchair         a manual wheelchair for people who use one (seat 0.45 m, the humanoid sit
                     clip's seat); root extras mobilityAid and noTouch (water never reaches them).

Conventions: metres, front faces glTF -Z, origin on the ground at the footprint centre, night
lights on light_* materials only. No text, logos or brands anywhere.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

from mathutils import Matrix  # noqa: E402

import fc  # noqa: E402
import vehicle as V  # noqa: E402

BUDGETS = {
    "hydrant.glb": 1_200,
    "drinking-fountain.glb": 1_200,
    "traffic-cone.glb": 400,
    "repair-kiosk.glb": 3_000,
    "vendor-cart.glb": 4_000,
    "wheelchair.glb": 2_500,
}


def hydrant() -> None:
    fc.reset()
    white = fc.material("paint_white", "#efeee8", 0.45)
    bonnet = fc.material("paint_bonnet_blue", "#2f5fa8", 0.4)
    metal = fc.material("cast_iron", "#3b3d40", 0.6, 0.6)
    root = fc.empty("hydrant")
    root["fcActor"] = "hydrant"
    root["refill"] = "hydrant"
    mb = fc.MeshBuilder()
    # flange on the ground, barrel, a raised band, the bonnet dome and the pentagon nut
    mb.lathe([(0.0, 0.0), (0.17, 0.0), (0.17, 0.04), (0.14, 0.05), (0.135, 0.07)], 16, metal, smooth=False)
    mb.lathe([(0.135, 0.07), (0.128, 0.3), (0.125, 0.52)], 16, white, smooth=True)
    mb.lathe([(0.125, 0.52), (0.15, 0.53), (0.15, 0.57), (0.13, 0.58)], 16, white, smooth=False)
    mb.lathe([(0.13, 0.58), (0.135, 0.62), (0.12, 0.68), (0.085, 0.72), (0.04, 0.74), (0.0, 0.745)], 16, bonnet, smooth=True)
    mb.cylinder(0.035, 0.74, 0.79, 5, bonnet, smooth=False)
    # outlets: two side nozzles with caps, a larger pumper outlet facing the street (front, +Y)
    for (dx, dy, r, L) in ((1, 0, 0.045, 0.1), (-1, 0, 0.045, 0.1), (0, 1, 0.065, 0.11)):
        a = math.atan2(dy, dx)
        mb.push(Matrix.Translation((0, 0, 0.42 if dy else 0.45)) @ Matrix.Rotation(a - math.pi / 2, 4, "Z") @ Matrix.Rotation(-math.pi / 2, 4, "X"))
        mb.cylinder(r, 0.1, 0.1 + L, 12, white, caps=False)
        mb.cylinder(r + 0.012, 0.1 + L, 0.1 + L + 0.03, 12, bonnet)
        mb.cylinder(0.02, 0.1 + L + 0.03, 0.1 + L + 0.05, 5, bonnet)
        mb.pop()
    mb.build("body", parent=root, sharp_angle=40)
    rp = fc.empty("refill_point", location=(0.0, 0.29, 0.45), parent=root)
    rp["refillPoint"] = True
    fc.export_glb("hydrant.glb", BUDGETS["hydrant.glb"])


def drinking_fountain() -> None:
    fc.reset()
    steel = fc.material("steel_brushed", "#b9bdc1", 0.35, 0.85)
    paint = fc.material("paint_sage", "#5f7f6a", 0.5)
    dark = fc.material("trim_dark", "#2a2d31", 0.6)
    root = fc.empty("drinking_fountain")
    root["fcActor"] = "drinking-fountain"
    root["refill"] = "fountain"
    mb = fc.MeshBuilder()
    mb.box(-0.25, -0.2, 0.0, 0.25, 0.2, 0.04, dark)  # footing
    mb.lathe([(0.15, 0.04), (0.13, 0.1), (0.11, 0.75), (0.13, 0.8)], 14, paint, smooth=True)
    # the bowl, the spout and its push button, facing front (+Y)
    mb.push(Matrix.Translation((0.0, 0.05, 0.8)))
    mb.lathe([(0.13, 0.0), (0.2, 0.04), (0.215, 0.11), (0.2, 0.115), (0.17, 0.06), (0.0, 0.05)], 18, steel, smooth=True)
    mb.cylinder(0.012, 0.05, 0.13, 8, steel)
    mb.cyl_between((0.0, 0.0, 0.13), (0.0, 0.05, 0.15), 0.01, 6, steel)
    mb.pop()
    mb.box(-0.03, 0.24, 0.84, 0.03, 0.27, 0.88, dark)
    # bottle filler on the back of the pedestal: a hood and a nozzle
    mb.box(-0.09, -0.2, 0.5, 0.09, -0.12, 0.72, steel)
    mb.box(-0.02, -0.18, 0.66, 0.02, -0.14, 0.7, dark)
    mb.build("body", parent=root, sharp_angle=40)
    rp = fc.empty("refill_point", location=(0.0, 0.1, 0.95), parent=root)
    rp["refillPoint"] = True
    fc.export_glb("drinking-fountain.glb", BUDGETS["drinking-fountain.glb"])


def traffic_cone() -> None:
    fc.reset()
    orange = fc.material("cone_orange", "#ff6a1a", 0.55)
    band = fc.material("cone_band_white", "#f4f4f0", 0.35)
    base = fc.material("cone_base", "#1d1e20", 0.85)
    root = fc.empty("traffic_cone")
    root["fcActor"] = "traffic-cone"
    root["throwable"] = True
    mb = fc.MeshBuilder()
    s = 0.18
    mb.box(-s, -s, 0.0, s, s, 0.03, base)
    h = 0.7
    r0, r1 = 0.13, 0.025

    def r(z):
        return r0 + (r1 - r0) * (z - 0.03) / (h - 0.03)

    zs = [0.03, 0.28, 0.36, 0.42, 0.48, h - 0.04]
    mats = [orange, band, orange, band, orange]
    for z0, z1, m in zip(zs, zs[1:], mats):
        mb.lathe([(r(z0), z0), (r(z1), z1)], 16, m, smooth=True)
    mb.lathe([(r(h - 0.04), h - 0.04), (0.02, h), (0.0, h)], 16, orange, smooth=True)
    mb.build("cone", parent=root)
    fc.export_glb("traffic-cone.glb", BUDGETS["traffic-cone.glb"])


def repair_kiosk() -> None:
    fc.reset()
    shell = fc.material("kiosk_ceramic", "#eceae4", 0.35)
    green = fc.material("kiosk_green", "#3f9b6e", 0.45)
    floor = fc.material("kiosk_floor", "#6d7278", 0.8)
    dark = fc.material("trim_dark", "#2a2d31", 0.6)
    screen = fc.material("light_kiosk_screen", "#cfe9ff", 0.3, emission="#bfe3ff", strength=1.0)
    status = fc.material("light_kiosk_status", "#7cf0a8", 0.3, emission="#66ffa0", strength=1.0)
    root = fc.empty("repair_kiosk")
    root["fcActor"] = "repair-kiosk"
    root["interact"] = "repair"
    mb = fc.MeshBuilder()
    W, D, H = 1.6, 1.2, 2.6
    # plinth with a ramp lip, the bay floor
    mb.box(-W / 2, -D / 2, 0.0, W / 2, D / 2, 0.08, dark)
    mb.box(-W / 2 + 0.1, -D / 2 + 0.1, 0.08, W / 2 - 0.1, D / 2, 0.1, floor)
    # back wall and two side walls (the bay opens to the front, +Y)
    t = 0.12
    mb.box(-W / 2, -D / 2, 0.08, W / 2, -D / 2 + t, H - 0.3, shell)
    for sx in (1, -1):
        mb.box(sx * (W / 2 - t), -D / 2, 0.08, sx * W / 2, D / 2, H - 0.3, shell)
        mb.box(sx * (W / 2 - t - 0.01), D / 2 - 0.05, 0.25, sx * (W / 2 - t), D / 2 - 0.02, H - 0.45, green)  # door jamb stripe
    # roof canopy with a rounded front and a green band
    mb.box(-W / 2 - 0.05, -D / 2 - 0.05, H - 0.3, W / 2 + 0.05, D / 2 + 0.1, H - 0.1, shell)
    mb.box(-W / 2 - 0.06, D / 2 + 0.1, H - 0.28, W / 2 + 0.06, D / 2 + 0.12, H - 0.12, green)
    # heart-and-wrench mark on the header (geometry only)
    hz = H - 0.2
    for sx in (-1, 1):
        mb.push(Matrix.Translation((sx * 0.045, D / 2 + 0.125, hz + 0.02)) @ Matrix.Rotation(-math.pi / 2, 4, "X"))
        mb.cylinder(0.05, 0.0, 0.01, 12, shell)
        mb.pop()
    mb.push(Matrix.Translation((0, D / 2 + 0.125, hz - 0.03)) @ Matrix.Rotation(math.pi / 4, 4, "Y"))
    mb.box(-0.06, 0.0, -0.06, 0.06, 0.01, 0.06, shell)
    mb.pop()
    mb.box(-0.16, D / 2 + 0.125, hz - 0.012, -0.09, D / 2 + 0.136, hz + 0.012, shell)
    mb.box(0.09, D / 2 + 0.125, hz - 0.012, 0.16, D / 2 + 0.136, hz + 0.012, shell)
    # the screen on the back wall inside the bay (blank), and the status ring above the bay
    mb.box(-0.35, -D / 2 + t, 1.35, 0.35, -D / 2 + t + 0.01, 1.85, dark)
    mb.box(-0.32, -D / 2 + t + 0.01, 1.38, 0.32, -D / 2 + t + 0.02, 1.82, screen)
    mb.push(Matrix.Translation((0, D / 2 + 0.05, H - 0.32)) @ Matrix.Rotation(math.pi / 2, 4, "X"))
    mb.lathe([(0.12, 0.0), (0.12, 0.02), (0.09, 0.02)], 18, status, smooth=False)
    mb.pop()
    # charging contacts on the bay floor and a hand rail
    for sx in (1, -1):
        mb.box(sx * 0.12 - 0.05, -0.1, 0.1, sx * 0.12 + 0.05, 0.1, 0.11, green)
        mb.cyl_between((sx * (W / 2 - t - 0.04), -0.3, 1.0), (sx * (W / 2 - t - 0.04), 0.3, 1.0), 0.02, 8, dark)
    mb.build("booth", parent=root, sharp_angle=40)
    bay = fc.empty("bay", location=(0.0, 0.05, 0.1), parent=root)
    bay["bay"] = True
    fc.export_glb("repair-kiosk.glb", BUDGETS["repair-kiosk.glb"])


def vendor_cart() -> None:
    fc.reset()
    wood = fc.material("cart_wood", "#a8774a", 0.6)
    cream = fc.material("cart_cream", "#efe6d2", 0.5)
    steel = fc.material("steel_brushed", "#b9bdc1", 0.35, 0.85)
    dark = fc.material("trim_dark", "#2a2d31", 0.6)
    coral = fc.material("awning_coral", "#e8664f", 0.6, double_sided=True)
    stripe = fc.material("awning_cream", "#f6efe0", 0.6, double_sided=True)
    yellow = fc.material("tank_yellow", "#ffcc1a", 0.4)
    blank = fc.material("sign_blank", "#f3efe6", 0.7)
    tire = fc.material("tire", "#151515", 0.85)
    root = fc.empty("vendor_cart")
    root["fcActor"] = "vendor-cart"
    root["interact"] = "vendor"
    L_, Wd, H = 1.7, 0.8, 0.95
    mb = fc.MeshBuilder()
    # the counter box (wood), its cream top, a front shelf; customers stand at the front (+Y)
    mb.box(-L_ / 2, -Wd / 2, 0.3, L_ / 2, Wd / 2, H, wood)
    mb.box(-L_ / 2 - 0.04, -Wd / 2 - 0.04, H, L_ / 2 + 0.04, Wd / 2 + 0.06, H + 0.04, cream)
    mb.box(-L_ / 2, Wd / 2, 0.55, L_ / 2, Wd / 2 + 0.12, 0.58, cream)
    # two legs at one end (the wheels are at the other)
    for sy in (1, -1):
        mb.box(L_ / 2 - 0.12, sy * (Wd / 2 - 0.05) - 0.03, 0.0, L_ / 2 - 0.06, sy * (Wd / 2 - 0.05) + 0.03, 0.3, dark)
    # push handle
    mb.cyl_between((L_ / 2, -0.3, H - 0.1), (L_ / 2 + 0.25, -0.3, H + 0.05), 0.02, 8, dark)
    mb.cyl_between((L_ / 2, 0.3, H - 0.1), (L_ / 2 + 0.25, 0.3, H + 0.05), 0.02, 8, dark)
    mb.cyl_between((L_ / 2 + 0.25, -0.3, H + 0.05), (L_ / 2 + 0.25, 0.3, H + 0.05), 0.022, 8, dark)
    # pour-over station: a kettle and three drippers on a rack
    mb.push(Matrix.Translation((-0.5, 0.05, H + 0.04)))
    mb.box(-0.2, -0.08, 0.0, 0.2, 0.08, 0.15, dark)
    for k in range(3):
        mb.push(Matrix.Translation((-0.13 + 0.13 * k, 0.0, 0.15)))
        mb.lathe([(0.02, 0.0), (0.055, 0.07), (0.06, 0.075)], 10, cream, smooth=True)
        mb.pop()
    mb.pop()
    mb.push(Matrix.Translation((-0.15, 0.1, H + 0.04)))
    mb.lathe([(0.07, 0.0), (0.075, 0.1), (0.05, 0.16), (0.0, 0.17)], 12, steel, smooth=True)
    mb.cyl_between((0.06, 0.0, 0.08), (0.14, 0.0, 0.16), 0.008, 6, steel)
    mb.pop()
    # burrito warmer: a steel box with a glass-free roll lid (opaque)
    mb.push(Matrix.Translation((0.2, 0.0, H + 0.04)))
    mb.box(-0.18, -0.15, 0.0, 0.18, 0.15, 0.14, steel)
    mb.push(Matrix.Translation((0, 0, 0.14)) @ Matrix.Rotation(math.pi / 2, 4, "Y"))
    mb.lathe([(0.15, -0.18), (0.15, 0.18)], 12, steel, smooth=True, arc=(math.pi / 2, 3 * math.pi / 2))
    mb.pop()
    mb.pop()
    # spare blaster tanks for sale (the same bright yellow as the water blaster's)
    for k in range(3):
        mb.push(Matrix.Translation((0.55 + 0.0 * k, -0.22 + 0.22 * k, H + 0.04)))
        mb.lathe([(0.0, 0.0), (0.07, 0.0), (0.075, 0.02), (0.075, 0.16), (0.05, 0.2), (0.02, 0.21), (0.0, 0.21)], 10, yellow, smooth=True)
        mb.pop()
    # awning: four poles and a striped canopy
    for sx in (1, -1):
        for sy in (1, -1):
            mb.cyl_between((sx * (L_ / 2 - 0.05), sy * (Wd / 2 - 0.02), H + 0.04), (sx * (L_ / 2 - 0.05), sy * (Wd / 2 - 0.02), 2.15), 0.015, 6, dark)
    stripes = 8
    for k in range(stripes):
        x0 = -L_ / 2 - 0.1 + (L_ + 0.2) * k / stripes
        x1 = -L_ / 2 - 0.1 + (L_ + 0.2) * (k + 1) / stripes
        m = coral if k % 2 == 0 else stripe
        mb.poly_n([(x0, -Wd / 2 - 0.1, 2.25), (x1, -Wd / 2 - 0.1, 2.25), (x1, Wd / 2 + 0.25, 2.1), (x0, Wd / 2 + 0.25, 2.1)], m, (0, 0.3, 1))
        mb.poly_n([(x0, Wd / 2 + 0.25, 2.1), (x1, Wd / 2 + 0.25, 2.1), (x1, Wd / 2 + 0.25, 1.95), (x0, Wd / 2 + 0.25, 1.95)], m, (0, 1, 0))
    mb.build("cart", parent=root, sharp_angle=40)
    # blank sign slot (iconography only for now: the panel is where a generated menu goes)
    sb = fc.MeshBuilder()
    sb.box(-0.45, 0.0, -0.2, 0.45, 0.02, 0.2, dark)
    sb.box(-0.42, 0.02, -0.17, 0.42, 0.025, 0.17, blank)
    sign = sb.build("sign_slot", parent=root, location=(0.0, Wd / 2 + 0.02, 0.7 - 0.02))
    sign["signSlot"] = True
    sign["sizeM"] = [0.84, 0.34]
    for name, sy in (("wheel_L", -1), ("wheel_R", 1)):
        V.wheel(name, 0.2, 0.06, tire, steel, hub=dark, seg=14, spokes=6, side=sy, parent=root,
                location=(-L_ / 2 + 0.25, sy * (Wd / 2 + 0.04), 0.2))
    # the wheel helper names its axis by x; the cart's wheels turn about X as everywhere else
    fc.export_glb("vendor-cart.glb", BUDGETS["vendor-cart.glb"])


def wheelchair() -> None:
    fc.reset()
    frame = fc.material("frame_teal_grey", "#5b7f8c", 0.35, 0.6)
    seat = fc.material("seat_fabric", "#26292e", 0.85)
    tire = fc.material("tire", "#151515", 0.85)
    rim = fc.material("rim", "#b9bdc1", 0.35, 0.8)
    root = fc.empty("wheelchair")
    root["fcActor"] = "wheelchair"
    root["mobilityAid"] = True
    root["noTouch"] = True
    root["seatHeightM"] = 0.45
    mb = fc.MeshBuilder()
    sw = 0.22  # half seat width
    # seat and back (sling fabric), the frame tubes, footplates
    mb.box(-sw, -0.22, 0.42, sw, 0.2, 0.45, seat)
    mb.box(-sw, -0.26, 0.47, sw, -0.23, 0.92, seat)
    for sx in (1, -1):
        x = sx * (sw + 0.02)
        mb.cyl_between((x, -0.25, 0.42), (x, 0.22, 0.42), 0.012, 6, frame)
        mb.cyl_between((x, -0.25, 0.42), (x, -0.27, 0.95), 0.012, 6, frame)
        mb.cyl_between((x, -0.27, 0.95), (x, -0.36, 0.97), 0.012, 6, frame)  # push handles
        mb.cyl_between((x, 0.2, 0.42), (x, 0.3, 0.1), 0.012, 6, frame)
        mb.cyl_between((x, -0.2, 0.42), (x, -0.2, 0.62), 0.012, 6, frame)  # armrest post
        mb.cyl_between((x, -0.2, 0.62), (x, 0.12, 0.62), 0.012, 6, frame)
        mb.box(x - sx * 0.12, 0.27, 0.08, x - sx * 0.01, 0.4, 0.1, frame)
        # small front casters
        mb.push(Matrix.Translation((x, 0.28, 0.065)) @ Matrix.Rotation(math.pi / 2, 4, "Y"))
        mb.cylinder(0.065, -0.015, 0.015, 10, tire)
        mb.pop()
    mb.build("chair", parent=root, sharp_angle=40)
    for name, sx in (("wheel_L", -1), ("wheel_R", 1)):
        w = V.wheel(name, 0.3, 0.035, tire, rim, hub=frame, seg=20, spokes=8, side=sx, parent=root,
                    location=(sx * (sw + 0.07), -0.1, 0.3))
        # the push rim beside the tyre
        pr = fc.MeshBuilder()
        pr.push(Matrix.Rotation(math.pi / 2, 4, "Y"))
        pr.lathe([(0.27, sx * 0.03), (0.275, sx * 0.034), (0.27, sx * 0.038), (0.265, sx * 0.034)], 20, rim, smooth=True)
        pr.pop()
        pr.build(f"push_rim_{name[-1]}", parent=w)
    fc.export_glb("wheelchair.glb", BUDGETS["wheelchair.glb"])


hydrant()
drinking_fountain()
traffic_cone()
repair_kiosk()
vendor_cart()
wheelchair()
