"""Shared pieces for road vehicles: lofted bodies, greenhouses, wheels, light strips.

Blender frame: the vehicle faces +Y, x is its right side, z up, origin on the ground at the
centre of its length and width. Wheels are separate objects whose origin is the hub centre
and which spin about their local X (glTF X); their geometry is baked so rest rotation is
the identity for every wheel.
"""

from __future__ import annotations

import math

from mathutils import Matrix, Vector

import fc


def interp(stations, y):
    """Linear interpolation of a station table [(y, a, b, ...), ...] (y decreasing or not)."""
    st = sorted(stations, key=lambda s: s[0])
    if y <= st[0][0]:
        return list(st[0][1:])
    if y >= st[-1][0]:
        return list(st[-1][1:])
    for s0, s1 in zip(st, st[1:]):
        if s0[0] <= y <= s1[0]:
            t = (y - s0[0]) / (s1[0] - s0[0])
            return [a + (b - a) * t for a, b in zip(s0[1:], s1[1:])]
    raise AssertionError


def half_section(hw, zb, zs, zc, rb=0.06, tumble=0.05, sr=0.09, crown_k=0.55, mid=0.55):
    """Right half of a body cross-section, bottom centre -> top centre, as (x, z)."""
    h = max(zs - zb, 0.05)
    return [
        (0.0, zb),
        (hw - rb, zb),
        (hw, zb + min(rb, h * 0.3)),
        (hw, zb + mid * h),
        (hw - tumble * 0.5, zs - sr * 0.6),
        (hw - tumble - sr, zs),
        (hw * crown_k, zs + 0.75 * (zc - zs)),
        (0.0, zc),
    ]


def full_ring(half):
    return half + [(-x, z) for x, z in reversed(half[1:-1])]


def outward_quad(mb, pts, mat, axis_z, smooth=True, uv=None):
    """Add a polygon oriented away from the vehicle's long axis (the line x=0, z=axis_z)."""
    c = Vector((sum(p[0] for p in pts), sum(p[1] for p in pts), sum(p[2] for p in pts))) / len(pts)
    out = Vector((c.x, 0.0, c.z - axis_z))
    mb.poly_n(pts, mat, tuple(out), smooth, uv)


def loft_body(mb, ys, section_at, mat_for_segment, axis_z, cap_front=None, cap_rear=None):
    """Loft closed rings along y. section_at(y) -> ring [(x, z)...]; ys from front to rear.

    mat_for_segment(j, y0, y1) -> material for the quad between ring points j, j+1.
    """
    rings = [[(x, y, z) for x, z in section_at(y)] for y in ys]
    n = len(rings[0])
    for i in range(len(rings) - 1):
        for j in range(n):
            j2 = (j + 1) % n
            q = [rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j]]
            outward_quad(mb, q, mat_for_segment(j, ys[i], ys[i + 1]), axis_z)
    if cap_front is not None:
        mb.poly_n(rings[0], cap_front, (0, 1, 0))
    if cap_rear is not None:
        mb.poly_n(rings[-1], cap_rear, (0, -1, 0))
    return rings


def weld(mb: fc.MeshBuilder, eps=1e-5) -> fc.MeshBuilder:
    """Merge coincident vertices and drop the faces that collapse (for degenerate lofts)."""
    key = {}
    remap = []
    verts = []
    for p in mb.verts:
        k = (round(p[0] / eps), round(p[1] / eps), round(p[2] / eps))
        if k not in key:
            key[k] = len(verts)
            verts.append(p)
        remap.append(key[k])
    out = fc.MeshBuilder()
    out.verts = verts
    out.mats = list(mb.mats)
    for f, mi, sm, uv in zip(mb.faces, mb.face_mat, mb.face_smooth, mb.face_uv):
        idx = []
        uvs = []
        for n, i in enumerate(f):
            r = remap[i]
            if not idx or idx[-1] != r:
                idx.append(r)
                if uv is not None:
                    uvs.append(uv[n])
        if len(idx) > 1 and idx[0] == idx[-1]:
            idx.pop()
            if uv is not None:
                uvs.pop()
        if len(set(idx)) < 3:
            continue
        out.faces.append(tuple(idx))
        out.face_mat.append(mi)
        out.face_smooth.append(sm)
        out.face_uv.append(uvs if uv is not None else None)
    return out


def wheel(name, radius, width, tire, rim, hub=None, seg=18, spokes=5, side=1, parent=None,
          location=(0, 0, 0), rim_r=None, extras=None):
    """A wheel spinning about X: tyre (lathe), recessed rim disc and spokes on the outer face.

    side=+1 puts the rim face toward +X (right side of the vehicle), -1 toward -X.
    """
    mb = fc.MeshBuilder()
    w = width / 2
    rr = rim_r if rim_r is not None else radius * 0.64
    # lathe about local Z, then rotate so Z -> X
    mb.push(Matrix.Rotation(math.pi / 2 * side, 4, "Y"))
    prof = [
        (rr, -w),
        (radius - 0.035, -w),
        (radius, -w + 0.04),
        (radius, w - 0.04),
        (radius - 0.035, w),
        (rr, w),
        (rr * 0.98, w - 0.02),
    ]
    mb.lathe(prof, seg, tire, smooth=True)
    # inner face of the tyre (toward the vehicle) closed by a dark disc
    mb.lathe([(0.0, -w + 0.01), (rr, -w + 0.01)], seg, tire, smooth=False)
    # rim: dish recessed into the outer face, spokes and a hub cap
    mb.lathe([(rr * 0.98, w - 0.02), (rr * 0.9, w - 0.05), (0.0, w - 0.06)], seg, hub or rim, smooth=False)
    for k in range(spokes):
        a = 2 * math.pi * k / spokes
        mb.push(Matrix.Rotation(a, 4, "Z"))
        mb.box(-0.032, rr * 0.18, w - 0.06, 0.032, rr * 0.95, w - 0.015, rim)
        mb.pop()
    mb.lathe([(rr * 0.26, w - 0.06), (rr * 0.26, w - 0.01), (0.0, w - 0.005)], 10, rim, smooth=False)
    mb.pop()
    ob = mb.build(name, parent=parent, location=location)
    ob["wheel"] = name.replace("wheel_", "")
    ob["spinAxis"] = [1, 0, 0]
    ob["radius"] = round(radius, 3)
    for k, v in (extras or {}).items():
        ob[k] = v
    return ob


def strip(mb, x0, x1, y0, y1, z, h, mat):
    """A thin light strip (box) spanning x0..x1, y0..y1, centred at height z."""
    mb.box(x0, y0, z - h / 2, x1, y1, z + h / 2, mat)


def car_body(stations, glass_stations, axles, wheel_r, arch_r, mats, pillars, axis_z=0.55,
             tumble=0.05, sr=0.09, clad_segments=1, mid=0.55):
    """Smooth, welded car skin: lofted lower body with round wheel arches, plus greenhouse.

    stations:       [(y, half width, sill z, shoulder z, centre-top z)], front to rear
    glass_stations: [(y, roof half width | None, roof z | None, crown)], None = glass meets body
    axles:          [y of each axle]
    mats:           dict paint, glass, trim, under, roof (roof optional: glass roof otherwise)
    pillars:        dict b=(y0, y1) trim band, c=y (side faces behind y are paint)
    """

    def sill(y, zb):
        z = zb
        for yw in axles:
            d = y - yw
            if abs(d) < arch_r:
                z = max(z, wheel_r + 0.02 + math.sqrt(arch_r**2 - d**2) * 0.98)
        return z

    ys = {s[0] for s in stations} | {s[0] for s in glass_stations}
    for yw in axles:
        for k in range(11):
            ys.add(round(yw + arch_r * 1.02 * math.cos(math.pi * k / 10), 4))
    ys = sorted(ys, reverse=True)

    def section(y):
        hw, zb, zs, zc = interp(stations, y)
        return full_ring(half_section(hw, sill(y, zb), zs, zc, tumble=tumble, sr=sr, mid=mid))

    n_half = 8
    last = 2 * n_half - 2  # segments in the ring

    def seg_mat(j, y0, y1):
        if j == 0 or j == last - 1:
            return mats["under"]
        if 1 <= j <= clad_segments or last - 1 - clad_segments <= j <= last - 2:
            return mats["trim"]
        return mats["paint"]

    body = fc.MeshBuilder()
    loft_body(body, ys, section, seg_mat, axis_z=axis_z, cap_front=mats["paint"], cap_rear=mats["paint"])

    rows = []
    for (y, hr, zr, cr) in glass_stations:
        hw, zb, zs, zc = interp(stations, y)
        hb = hw - tumble - sr
        if hr is None:
            rows.append([(hb, y, zs), (hb, y, zs), (0.0, y, zc), (-hb, y, zs), (-hb, y, zs)])
        else:
            rows.append([(hb, y, zs), (hr, y, zr), (0.0, y, zr + cr), (-hr, y, zr), (-hb, y, zs)])
    ys_g = [s[0] for s in glass_stations]
    roof_y = (glass_stations[1][0], glass_stations[-2][0])
    for i in range(len(rows) - 1):
        y0, y1 = ys_g[i], ys_g[i + 1]
        for j in range(4):
            q = [rows[i][j], rows[i][j + 1], rows[i + 1][j + 1], rows[i + 1][j]]
            if j in (0, 3):
                m = mats["paint"] if y0 <= pillars["c"] else mats["glass"]
                b0, b1 = pillars["b"]
                if y0 <= b1 and y1 >= b0:
                    m = mats["trim"]
            else:
                in_roof = y0 <= roof_y[0] and y1 >= roof_y[1]
                m = mats.get("roof", mats["glass"]) if in_roof else mats["glass"]
            outward_quad(body, q, m, axis_z=axis_z)
    return weld(body), rows
