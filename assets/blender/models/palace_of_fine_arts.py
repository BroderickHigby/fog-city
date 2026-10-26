"""Original Palace of Fine Arts rotunda and colonnades -> palace-of-fine-arts.glb.

Run directly in headless Blender; do not run the full build (which also writes landmarks).
Rebuilds both the GLB and its canonical content/palace-of-fine-arts.json collision packet.
Metres, Blender +Y / glTF -Z faces the lagoon. Origin is the rotunda floor centre.
Placement: SF (-4818.56, -823.9325), bearing 84.44334179005355 degrees.

The colonnade centre lines are interpreted from the six existing SF footprints at
source head e75446cc2b802d2669a204ec97b361a4867922d6, rotated into this model frame.
Architecture is newly drawn geometry, not an imported mesh. The California landmark
record supplies the 162 ft apex, 160 ft rotunda diameter, octagonal open arcade,
paired exterior / single interior Corinthian columns and coffered hemispherical dome:
https://ohp.parks.ca.gov/pages/1067/files/CHL_San%20Francisco_Palace%20of%20Fine%20Arts.pdf

Two static meshes / eight material primitives. No images, lights, opaque centre wall,
or broad foundation: the open rotunda and colonnade aisles remain walk-through.
"""

import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib"))

from mathutils import Matrix, Vector  # noqa: E402
import fc  # noqa: E402

TAU = math.pi * 2
APEX = 49.3776
BUDGET = 40_000
fc.reset()
STONE = fc.material("palace_sandstone", "#c8ae88", .92)
TRIM = fc.material("palace_limestone_trim", "#e0c9a5", .9)
SHAFT = fc.material("palace_terracotta_columns", "#a77658", .94)
DOME = fc.material("palace_terracotta_dome", "#a87355", .92)
RECESS = fc.material("palace_coffer_recess", "#887454", .96)
COLLIDERS = []


def collider(mb, label, points, bottom, top, elevated=False):
    """Export only numeric GLTF-frame collision footprints for the runtime owner."""
    placed = [mb.m @ Vector((x, y, bottom)) for x, y in points]
    floor = min(p.z for p in placed)
    ceiling = max((mb.m @ Vector((x, y, top))).z for x, y in points)
    item = {"id": f"palace:{label}:{len(COLLIDERS)}",
            "footprint": [[round(p.x, 5), round(-p.y, 5)] for p in reversed(placed)],
            "baseY": round(floor, 5), "topY": round(ceiling, 5)}
    if elevated:
        item["underY"] = round(floor, 5)
    COLLIDERS.append(item)


def collider_box(mb, label, x0, y0, bottom, x1, y1, top, elevated=False):
    x0, x1 = sorted((x0, x1)); y0, y1 = sorted((y0, y1))
    collider(mb, label, [(x0, y0), (x1, y0), (x1, y1), (x0, y1)], bottom, top, elevated)


def translation(x, y, z=0):
    return Matrix.Translation((x, y, z))


def ring(mb, inner, outer, bottom, top, material, segments=64):
    phase = math.pi / 8 if segments == 8 else 0
    mb.lathe([(inner, bottom), (outer, bottom), (outer, top), (inner, top), (inner, bottom)], segments, material, phase=phase)
    for i in range(segments):
        a, b = phase + i * TAU / segments, phase + (i + 1) * TAU / segments
        collider(mb, "roof-ring", [(inner * math.cos(a), inner * math.sin(a)),
                 (outer * math.cos(a), outer * math.sin(a)), (outer * math.cos(b), outer * math.sin(b)),
                 (inner * math.cos(b), inner * math.sin(b))], bottom, top, True)


def column(mb, x, y, bottom, height, radius=.88, heading=0):
    """Fluted shaft, moulded Attic base, leafy bell and four curled volutes."""
    mb.push(translation(x, y, bottom) @ Matrix.Rotation(heading, 4, "Z"))
    cap = height * .105
    base = height * .045
    collider_box(mb, "column", -radius * 1.375, -radius * 1.375, 0,
                 radius * 1.375, radius * 1.375, height + cap * .02)
    # Stepped square plinth and round mouldings keep the monumental base readable.
    mb.boxc(0, 0, base * .15, radius * 2.65, radius * 2.65, base * .30, TRIM)
    mb.lathe([(radius * 1.24, base * .30), (radius * 1.25, base * .48),
              (radius * 1.08, base * .70), (radius, base)], 12, TRIM)
    # Three levels carry subtle entasis; alternating radius makes real shallow flutes.
    levels = [(base, 1), (height * .48, .96), (height - cap, .82)]
    circles = []
    for z, scale in levels:
        circles.append([mb.v((math.cos(i * TAU / 24) * radius * scale * (1 if i % 2 else .96),
                              math.sin(i * TAU / 24) * radius * scale * (1 if i % 2 else .96), z)) for i in range(24)])
    for a, b in zip(circles, circles[1:]):
        for i in range(24):
            j = (i + 1) % 24
            mb.face([a[i], a[j], b[j], b[i]], SHAFT, True)
    # Capital bell flares upwards; acanthus leaves are solid folded relief, not alpha cards.
    z0 = height - cap
    mb.lathe([(radius * .82, z0), (radius * .92, z0 + cap * .48), (radius * 1.23, height - cap * .15)], 16, TRIM)
    for i in range(8):
        a = i * TAU / 8
        mid = Vector((math.cos(a), math.sin(a), 0))
        tangent = Vector((-math.sin(a), math.cos(a), 0))
        root = mid * radius * .84 + Vector((0, 0, z0 + cap * .08))
        tip = mid * radius * 1.3 + Vector((0, 0, z0 + cap * .78))
        left = root + tangent * radius * .37
        right = root - tangent * radius * .37
        fold = mid * radius * 1.21 + Vector((0, 0, z0 + cap * .38))
        mb.poly([left, right, fold], STONE)
        mb.poly([left, fold, tip], TRIM)
        mb.poly([fold, right, tip], TRIM)
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        mb.push(Matrix.Rotation(a, 4, "Z") @ translation(radius * 1.03, 0, height - cap * .26))
        # Open spiral scroll in the vertical/tangent plane, three low-detail segments.
        points = []
        for j in range(4):
            theta = -.5 * math.pi + j * TAU * .80 / 3
            r = radius * (.31 - j * .05)
            points.append((0, r * math.cos(theta), r * math.sin(theta)))
        for p, q in zip(points, points[1:]):
            mb.cyl_between(p, q, radius * .075, 3, TRIM, caps=False)
        mb.pop()
    mb.boxc(0, 0, height - cap * .06, radius * 2.75, radius * 2.75, cap * .16, TRIM)
    mb.pop()


def urn(mb, x, y, z, scale=1):
    mb.push(translation(x, y, z))
    collider(mb, "urn", [(math.cos(i * TAU / 12) * .91 * scale, math.sin(i * TAU / 12) * .91 * scale)
                          for i in range(12)], 0, 2.15 * scale)
    mb.lathe([(0.42 * scale, 0), (.46 * scale, .20 * scale), (.28 * scale, .48 * scale),
              (.75 * scale, .85 * scale), (.91 * scale, 1.40 * scale), (.70 * scale, 1.82 * scale),
              (.38 * scale, 2.02 * scale), (.53 * scale, 2.15 * scale)], 12, TRIM,
             cap_top=True, cap_bottom=True)
    mb.pop()


def arch(mb, theta):
    """One open barrel arch in a radial octagon face, including deep voussoirs."""
    mb.push(translation(21.2 * math.cos(theta), 21.2 * math.sin(theta)) @ Matrix.Rotation(theta - math.pi / 2, 4, "Z"))
    half, r, spring, top, depth = 8.75, 6.25, 17.5, 26.3, 2.6
    for side in [-1, 1]:
        mb.box(side * r, -depth, 3.6, side * half, 0, spring, STONE)
        collider_box(mb, "arch-jamb", side * r, -depth, 3.6, side * half, 0, top)
    for i in range(16):
        a, b = math.pi * i / 16, math.pi * (i + 1) / 16
        x0, z0 = r * math.cos(a), spring + r * math.sin(a)
        x1, z1 = r * math.cos(b), spring + r * math.sin(b)
        collider_box(mb, "arch-vault", x0, -depth, min(z0, z1), x1, 0, top, True)
        for y, normal in [(0, (0, 1, 0)), (-depth, (0, -1, 0))]:
            mb.poly_n([(x0, y, z0), (x1, y, z1), (x1, y, top), (x0, y, top)], STONE, normal)
        mb.poly_n([(x0, 0, z0), (x1, 0, z1), (x1, -depth, z1), (x0, -depth, z0)], TRIM,
                  (-math.cos((a + b) / 2), 0, -math.sin((a + b) / 2)))
        # Distinct pale arch stones on the exterior face, with recessed joints.
        aa, bb = a + .010, b - .010
        ri, ro = r + .08, r + .67
        mb.poly_n([(ri * math.cos(aa), .035, spring + ri * math.sin(aa)),
                   (ri * math.cos(bb), .035, spring + ri * math.sin(bb)),
                   (ro * math.cos(bb), .035, spring + ro * math.sin(bb)),
                   (ro * math.cos(aa), .035, spring + ro * math.sin(aa))], TRIM, (0, 1, 0))
    # Narrow outer spandrel infill; never close the arch below its spring.
    for side in [-1, 1]:
        mb.box(side * r, -depth, spring, side * half, 0, top, STONE)
    mb.pop()


def dome(mb):
    radius, base = 17.0, APEX - 17.0
    collider(mb, "dome", [(math.cos(i * TAU / 24) * 17.12, math.sin(i * TAU / 24) * 17.12)
                         for i in range(24)], base - .25, APEX, True)
    profile = [(radius * math.cos(i * math.pi / 32), base + radius * math.sin(i * math.pi / 32)) for i in range(17)]
    profile[-1] = (0, APEX)
    mb.lathe(profile, 64, DOME, smooth=True)
    # Low ribs articulate the terracotta roof without adding a separate texture.
    for sector in range(24):
        a = sector * TAU / 24
        for j in range(12):
            p = j * math.pi / 24
            q = (j + 1) * math.pi / 24
            r = radius + .055
            mb.cyl_between((r * math.cos(p) * math.cos(a), r * math.cos(p) * math.sin(a), base + radius * math.sin(p)),
                           (r * math.cos(q) * math.cos(a), r * math.cos(q) * math.sin(a), base + radius * math.sin(q)),
                           .07, 3, DOME, caps=False)
    # Coffers are recessed trapezoids set into an inward-facing hemispherical ceiling.
    # A shallow bevel around every panel supplies real light/shadow when viewed below.
    inner, inside_base = 16.45, base - .10
    def point(phi, a, radius=inner):
        return Vector((radius * math.cos(phi) * math.cos(a), radius * math.cos(phi) * math.sin(a),
                       inside_base + radius * math.sin(phi)))
    for row in range(7):
        p0, p1 = row * math.pi / 16, (row + 1) * math.pi / 16
        for sector in range(32):
            a0, a1 = sector * TAU / 32, (sector + 1) * TAU / 32
            border = [point(p0, a0), point(p0, a1), point(p1, a1), point(p1, a0)]
            center = sum(border, Vector()) / 4
            inset = [center + (v - center) * .73 for v in border]
            inset = [v + (v - Vector((0, 0, inside_base))).normalized() * .18 for v in inset]
            inward = Vector((0, 0, inside_base)) - center
            for k in range(4):
                mb.poly_n([border[k], border[(k + 1) % 4], inset[(k + 1) % 4], inset[k]], TRIM, inward)
            mb.poly_n(inset, RECESS, inward)
    # Rosette at the zenith closes the ceiling, leaving the whole room open below it.
    mb.lathe([(0, inside_base + inner), (3.22, inside_base + inner * .9808)], 32, TRIM, smooth=True)


def rotunda(mb):
    # Each octagonal pier is open on either side and grounded independently.
    for i in range(8):
        theta = math.pi / 8 + i * math.pi / 4
        radial = Vector((math.cos(theta), math.sin(theta), 0))
        tangent = Vector((-math.sin(theta), math.cos(theta), 0))
        mb.push(Matrix.Rotation(theta - math.pi / 2, 4, "Z"))
        # No circular floor slab: just the podium at the base of each real pier.
        for step in range(3):
            mb.boxc(0, 22.2, .30 + step * .45, 6.9 - step * .5, 5.8 - step * .4, .60, STONE)
            collider_box(mb, "pier-step", -(6.9 - step * .5) / 2, 22.2 - (5.8 - step * .4) / 2,
                         step * .45, (6.9 - step * .5) / 2, 22.2 + (5.8 - step * .4) / 2, .6 + step * .45)
        mb.boxc(0, 22.2, 2.6, 5.5, 4.4, 2.8, STONE)
        collider_box(mb, "pier-podium", -2.75, 20.0, 1.2, 2.75, 24.4, 4.0)
        mb.pop()
        for side in [-1, 1]:
            p = radial * 23.0 + tangent * (side * 1.9)
            column(mb, p.x, p.y, 3.8, 22.5, 1.03, theta)
        p = radial * 18.35
        column(mb, p.x, p.y, .15, 26.15, .95, theta)
        # Monumental urns bracket each pier rather than obstructing the central aisle.
        for side in [-1, 1]:
            p = radial * 25.5 + tangent * (side * 3.6)
            mb.boxc(p.x, p.y, 1.7, 2.35, 2.35, 3.4, STONE)
            collider_box(mb, "urn-plinth", p.x - 1.175, p.y - 1.175, 0, p.x + 1.175, p.y + 1.175, 3.4)
            urn(mb, p.x, p.y, 3.4, 1.12)
        arch(mb, i * math.pi / 4)
    # Eight-sided entablature, projected cornices and a high decorated attic drum.
    for inner, outer, low, high, mat in [
        (18.8, 24.0, 26.3, 27.0, TRIM), (18.8, 23.5, 27.0, 28.4, STONE),
        (18.7, 24.25, 28.4, 28.8, TRIM), (18.8, 23.6, 28.8, 29.5, STONE),
        (18.6, 24.4, 29.5, 30.2, TRIM), (17.9, 21.15, 30.2, 32.2, STONE),
        (16.7, 21.5, 32.2, 32.55, TRIM),
    ]:
        ring(mb, inner, outer, low, high, mat, 8)
    for i in range(8):
        theta = i * math.pi / 4
        panel_radius = 21.15 * math.cos(math.pi / 8) + .04
        mb.push(translation(panel_radius * math.cos(theta), panel_radius * math.sin(theta), 0) @ Matrix.Rotation(theta - math.pi / 2, 4, "Z"))
        mb.boxc(0, .06, 31.0, 8.0, .22, 1.65, RECESS)
        # Simplified high-relief wreath/rinceau: six warm stone lozenges per attic panel.
        for k in range(6):
            mb.push(translation(-3.1 + 1.24 * k, .23, 31.0) @ Matrix.Rotation(math.pi / 4, 4, "Y"))
            mb.boxc(0, 0, 0, .73, .27, .73, STONE)
            mb.pop()
        mb.pop()
    # Cushion ring and dentils under the dome.
    ring(mb, 16.5, 18.0, 32.45, 32.8, TRIM)
    for i in range(64):
        theta = i * TAU / 64
        mb.push(translation(23.6 * math.cos(theta), 23.6 * math.sin(theta), 29.5) @ Matrix.Rotation(theta, 4, "Z"))
        mb.boxc(0, 0, 0, .65, .35, .45, TRIM)
        mb.pop()
    dome(mb)


# Walkable aisle centre lines sampled from the actual north/south monument footprints.
# Local +X is south, local +Y is toward the lagoon; the exhibition hall stays behind -Y.
NORTH = [(-28.4, -31.6), (-49.0, -23.3), (-66.1, -10.9), (-79.4, 10.0), (-80.8, 23.5), (-106.8, 23.5)]
SOUTH = [(30.6, -28.1), (52.3, -17.0), (68.3, -2.3), (76.3, 18.1), (76.0, 34.0), (103.6, 36.3)]


def colonnade(mb, points):
    # Double rows bound the aisle. Segment changes follow the real curved footprint,
    # not a symmetric invented crescent that would intrude on the exhibition hall.
    for i, p in enumerate(points):
        q = points[min(len(points) - 1, i + 1)] if i + 1 < len(points) else points[i - 1]
        dx, dy = q[0] - p[0], q[1] - p[1]
        length = math.hypot(dx, dy)
        nx, ny = -dy / length, dx / length
        for side in [-1, 1]:
            x, y = p[0] + nx * side * 1.65, p[1] + ny * side * 1.65
            column(mb, x, y, .2, 18.6, .70, math.atan2(dy, dx))
        for j in range(i + 1, min(i + 2, len(points))):
            q = points[j]
            length = math.hypot(q[0] - p[0], q[1] - p[1])
            angle = math.atan2(q[1] - p[1], q[0] - p[0])
            mb.push(translation((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) @ Matrix.Rotation(angle, 4, "Z"))
            for offset in [-1.65, 1.65]:
                mb.boxc(0, offset, 19.4, length, 1.55, 1.6, STONE)
                mb.boxc(0, offset, 20.3, length + .25, 1.9, .3, TRIM)
                mb.boxc(0, offset, 18.6, length, 1.75, .22, TRIM)
                collider_box(mb, "colonnade-beam", -length / 2 - .125, offset - .95, 18.49,
                             length / 2 + .125, offset + .95, 20.45, True)
                # Greek fret on the frieze, cut as shallow relief and batched with the beam.
                for k in range(max(1, int(length / 2))):
                    x = -length / 2 + (k + .5) * length / max(1, int(length / 2))
                    mb.boxc(x, offset + math.copysign(.80, offset), 19.45, .85, .08, .14, TRIM)
            mb.pop()
    # Tall planting boxes at the principal grouped-column pylons.
    for p in [points[0], points[2], points[4], points[-1]]:
        mb.boxc(p[0], p[1], 20.7, 5.4, 5.2, .6, TRIM)
        mb.boxc(p[0], p[1], 21.3, 4.95, 4.75, .6, STONE)
        mb.boxc(p[0], p[1], 21.75, 5.35, 5.15, .3, TRIM)
        collider_box(mb, "pylon-roof", p[0] - 2.7, p[1] - 2.6, 20.4, p[0] + 2.7, p[1] + 2.6, 23.59, True)
        for sx in [-1, 1]:
            for sy in [-1, 1]:
                # Small, abstract draped corner figures; no real person's likeness.
                mb.push(translation(p[0] + sx * 2.25, p[1] + sy * 2.15, 21.85))
                mb.lathe([(.30, 0), (.43, .25), (.30, 1.05), (.17, 1.36)], 6, STONE)
                mb.sphere((0, 0, 1.52), .22, 6, 3, STONE)
                mb.pop()


def terminal(mb, x, y):
    # Detached terminal pylons from the inventory remain detached, preserving passages.
    for sx in [-1, 1]:
        for sy in [-1, 1]:
            column(mb, x + sx * 2.0, y + sy * 1.8, .2, 18.6, .72)
    mb.boxc(x, y, 19.5, 6.0, 5.6, 1.8, STONE)
    mb.boxc(x, y, 20.6, 6.4, 6.0, .35, TRIM)
    mb.boxc(x, y, 21.15, 5.8, 5.4, .7, STONE)
    mb.boxc(x, y, 21.65, 6.2, 5.8, .3, TRIM)
    collider_box(mb, "terminal-roof", x - 3.2, y - 3.0, 18.6, x + 3.2, y + 3.0, 21.8, True)


root = fc.empty("palace_of_fine_arts")
root["fcActor"] = "palace-of-fine-arts"
root["landmark"] = True
root["openRotunda"] = True
root["front"] = "lagoon"
root["frontBearingDeg"] = 84.44334179005355
root["source"] = "Original parametric geometry; SF footprint placement; California landmark record dimensions"
body = fc.MeshBuilder()
rotunda(body)
rotunda_mesh = body.build("rotunda", root)
# Roof ribs have thickness; preserve the surveyed apex as the overall envelope.
for vertex in rotunda_mesh.data.vertices:
    vertex.co.z = min(vertex.co.z, APEX)
wings = fc.MeshBuilder()
colonnade(wings, NORTH)
colonnade(wings, SOUTH)
terminal(wings, -104.9, 6.9)
terminal(wings, 103.7, 19.6)
wings.build("colonnades", root)
fc.export_glb("palace-of-fine-arts.glb", budget=BUDGET)
layout = {
    "id": "palace-of-fine-arts",
    "version": 1,
    "world": "sf",
    "frame": "glTF local metres, +Y up, -Z front",
    "origin": {"lat": 37.802923311185815, "lon": -122.44840925561012,
               "headingDeg": 84.44334179005355},
    "source": "Original geometry from assets/blender/models/palace_of_fine_arts.py, positioned against DataSF footprint records. Heights and footprints are shared with the architectural model.",
    "replacesBuildingIds": ["201006.0000986", "201006.0000986-tower", "201006.0006360",
                           "201006.0006456", "201006.0156555", "201006.0157252"],
    "colliders": COLLIDERS,
}
layout_path = os.path.join(fc.REPO, "content", "palace-of-fine-arts.json")
fc.write_json(layout_path, layout)
print(f"[fc] wrote content/palace-of-fine-arts.json: {len(COLLIDERS)} collision primitives")
