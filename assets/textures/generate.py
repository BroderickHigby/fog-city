"""Procedural PBR texture sets for the Ferry Building showcase -> public/models/textures/<set>_{albedo,normal,orm}.webp

Generated only (no photographs; WebP, never JPEG: the privacy test bans JPEG bytes in public/): every map is synthesised from seeded noise, so the sets are
reproducible byte for byte (numpy + Pillow, fixed seeds, no threads in the maths). All maps tile
seamlessly: the noise is spectral (white noise filtered in the frequency domain, which is periodic
by construction) and every stamp, crack and joint wraps around the edges.

  albedo  sRGB base colour
  normal  tangent-space normal map (OpenGL convention, +Y up), from the height field
  orm     glTF packing: R ambient occlusion, G roughness, B metalness

Each set covers SIZE_M metres per repeat (the renderer reads TEXTURES[name].sizeM from
public/models/textures/textures.json, which this script writes).

  python3 assets/textures/generate.py            # every set
  python3 assets/textures/generate.py asphalt    # one set
"""

import json
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, "public", "models", "textures")
N = 1024


def rng(seed):
    return np.random.default_rng(seed)


def spectral(r, n, beta, lo=1.0, hi=None):
    """Periodic fBm-like noise: white noise shaped by 1/f^beta between frequencies lo..hi (cycles per tile)."""
    w = r.standard_normal((n, n))
    f = np.fft.fft2(w)
    fy = np.fft.fftfreq(n)[:, None] * n
    fx = np.fft.fftfreq(n)[None, :] * n
    k = np.sqrt(fx * fx + fy * fy)
    k[0, 0] = 1.0
    amp = k ** (-beta)
    amp[k < lo] = 0.0
    if hi is not None:
        amp *= np.exp(-((k / hi) ** 2))
    amp[0, 0] = 0.0
    out = np.real(np.fft.ifft2(f * amp))
    out -= out.mean()
    return out / (out.std() + 1e-9)


def norm01(a):
    a = a - a.min()
    return a / (a.max() + 1e-9)


def blur(a, sigma_px):
    """Periodic Gaussian blur in the frequency domain."""
    n = a.shape[0]
    fy = np.fft.fftfreq(n)[:, None]
    fx = np.fft.fftfreq(n)[None, :]
    g = np.exp(-2 * (np.pi * sigma_px) ** 2 * (fx * fx + fy * fy))
    return np.real(np.fft.ifft2(np.fft.fft2(a) * g))


def normal_map(h, strength):
    """Tangent-space normal from a height field in metres per pixel units scaled by strength (wraps)."""
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5 * strength
    dy = (np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5 * strength
    # Image rows run down; OpenGL normal maps have +Y up the texture (v up).
    nx, ny, nz = -dx, dy, np.ones_like(h)
    l = np.sqrt(nx * nx + ny * ny + nz * nz)
    return np.stack([nx / l, ny / l, nz / l], -1) * 0.5 + 0.5


def cavity_ao(h, sigma_px, k):
    """Cheap AO: how far a pixel sits below its blurred surroundings."""
    d = h - blur(h, sigma_px)
    return np.clip(1.0 + d * k, 0.35, 1.0)


def stroke(canvas, r, start, steps, step_px, width_px, depth, wander):
    """A wandering crack, wrapped on the torus, cut into the height field `canvas`."""
    n = canvas.shape[0]
    y, x = start
    ang = r.uniform(0, 2 * np.pi)
    for _ in range(steps):
        ang += r.normal(0, wander)
        x = (x + np.cos(ang) * step_px) % n
        y = (y + np.sin(ang) * step_px) % n
        w = max(1, int(round(width_px * r.uniform(0.6, 1.3))))
        ys = (np.arange(-w, w + 1) + int(y)) % n
        xs = (np.arange(-w, w + 1) + int(x)) % n
        yy, xx = np.meshgrid(np.arange(-w, w + 1), np.arange(-w, w + 1), indexing="ij")
        fall = np.clip(1 - np.sqrt(yy * yy + xx * xx) / (w + 0.5), 0, 1)
        canvas[np.ix_(ys, xs)] = np.minimum(canvas[np.ix_(ys, xs)], -depth * fall)


def save(name, albedo, normal, ao, rough, metal=None, size_m=1.0, meta=None):
    os.makedirs(OUT, exist_ok=True)
    a8 = (np.clip(albedo, 0, 1) ** (1 / 2.2) * 255 + 0.5).astype(np.uint8)  # linear -> sRGB-ish
    Image.fromarray(a8, "RGB").save(os.path.join(OUT, f"{name}_albedo.webp"), quality=90, method=6)
    n8 = (np.clip(normal, 0, 1) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(n8, "RGB").save(os.path.join(OUT, f"{name}_normal.webp"), quality=94, method=6)
    m = np.zeros_like(ao) if metal is None else metal
    orm = np.stack([ao, rough, m], -1)
    o8 = (np.clip(orm, 0, 1) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(o8, "RGB").save(os.path.join(OUT, f"{name}_orm.webp"), quality=90, method=6)
    mean = [round(float(v), 5) for v in np.clip(albedo, 0, 1).reshape(-1, 3).mean(0)]
    entry = {"sizeM": size_m, "meanLinear": mean, "albedo": f"{name}_albedo.webp", "normal": f"{name}_normal.webp", "orm": f"{name}_orm.webp", "source": "generated: assets/textures/generate.py", "licence": "project-owned (procedural, no photographs)"}
    entry.update(meta or {})
    print(f"[fc] wrote textures/{name} ({size_m} m per repeat)")
    return entry


def tint(base, var, *fields):
    """Colour = base * (1 + sum of fields * var)."""
    b = np.array(base, dtype=np.float64)[None, None, :]
    s = np.zeros(fields[0].shape)
    for f, v in zip(fields, var):
        s = s + f * v
    return b * (1 + s[..., None])


# ------------------------------------------------------------------ sets

def asphalt():
    """Worn city asphalt, 4 m per repeat: aggregate, polished wheel paths, patches, cracks, oil."""
    r = rng(101)
    px_m = 4.0 / N
    agg = spectral(r, N, 0.2, lo=180, hi=420)  # 1-2 cm stones
    stones = np.clip(agg - 0.9, 0, None)
    mid = spectral(r, N, 1.2, lo=4, hi=80)
    big = spectral(r, N, 2.0, lo=1, hi=6)
    h = agg * 0.0012 + mid * 0.0015
    # Cracks: a few long wandering lines and a crazed patch.
    cr = np.zeros((N, N))
    for _ in range(5):
        stroke(cr, r, (r.uniform(0, N), r.uniform(0, N)), 260, 2.0, 1.2, 0.006, 0.18)
    for _ in range(30):
        stroke(cr, r, (r.uniform(0, N), r.uniform(0, N)), 25, 2.0, 0.8, 0.004, 0.5)
    h = h + cr
    # A patch: a smoother, darker rectangle of newer asphalt with a seam.
    patch = np.zeros((N, N))
    py, pxx = int(N * 0.62), int(N * 0.18)
    ph, pw = int(N * 0.22), int(N * 0.31)
    ys, xs = (np.arange(py, py + ph) % N), (np.arange(pxx, pxx + pw) % N)
    patch[np.ix_(ys, xs)] = 1.0
    patch = np.clip(blur(patch, 1.5), 0, 1)
    seam = np.clip(1 - np.abs(blur(patch, 0.8) - 0.5) * 6, 0, 1)
    h = h * (1 - 0.6 * patch) - seam * 0.002
    # Oil and tyre grime: soft dark blobs.
    oil = np.clip(spectral(r, N, 2.2, lo=2, hi=24) - 1.0, 0, None)
    oil = norm01(blur(oil, 6)) ** 1.5
    grey = 0.075 * (1 + 0.10 * big + 0.06 * mid + 0.22 * agg) * (1 - 0.35 * oil) * (1 - 0.25 * patch)
    grey = grey + stones * 0.09
    grey = grey * (1 + 2.5 * np.minimum(cr, 0) / 0.006 * 0.25)
    albedo = np.stack([grey * 1.0, grey * 1.0, grey * 1.04], -1)
    rough = np.clip(0.88 - 0.12 * oil - 0.05 * patch + 0.04 * mid - 0.06 * stones, 0.55, 0.98)
    ao = cavity_ao(h, 3, 220)
    return save("asphalt", albedo, normal_map(h / px_m, 1.0), ao, rough, size_m=4.0)


def concrete():
    """Broom-finished sidewalk concrete, 3 m per repeat: grain, broom streaks, gum spots, stains. No joints: the
    sidewalk shader scores them every 1.5 m along the walk line, which world-mapped texture cannot follow."""
    r = rng(202)
    size = 3.0
    px_m = size / N
    fine = spectral(r, N, 0.6, lo=60, hi=500)
    broom = blur(r.standard_normal((N, N)), 0.6)
    broom = np.real(np.fft.ifft2(np.fft.fft2(broom) * np.exp(-((np.fft.fftfreq(N)[:, None] * 40) ** 2))))  # streaks along v
    broom = broom / (broom.std() + 1e-9)
    mid = spectral(r, N, 1.5, lo=2, hi=40)
    h = fine * 0.0004 + broom * 0.0003
    # Joints: grooves at u, v = 0 and 1/2 (1.5 m), 8 mm wide, 6 mm deep, with rounded edges.
    u = np.arange(N) / N
    j1 = np.minimum(np.abs(((u * 2) % 1.0) - 0.0), np.abs(((u * 2) % 1.0) - 1.0)) * (size / 2)  # metres to nearest joint
    jx = np.clip(1 - j1 / 0.006, 0, 1)
    joint = np.maximum(jx[None, :], jx[:, None]) * 0.0  # kept for the slab maths; drawn by the shader
    h = h - joint * 0.006
    # Slab-to-slab tone: each 1.5 m slab a slightly different pour.
    slab = np.zeros((N, N))
    half = N // 2
    for i in range(2):
        for k in range(2):
            slab[i * half:(i + 1) * half, k * half:(k + 1) * half] = r.normal(0, 0.05) * 0.0
    gum = np.zeros((N, N))
    for _ in range(40):
        y, x = r.integers(0, N, 2)
        rad = r.uniform(2, 5)
        yy, xx = np.ogrid[-6:7, -6:7]
        d = np.clip(1 - np.sqrt(yy * yy + xx * xx) / rad, 0, 1)
        gum[np.ix_((np.arange(-6, 7) + y) % N, (np.arange(-6, 7) + x) % N)] += d
    gum = np.clip(gum, 0, 1)
    stain = norm01(np.clip(spectral(r, N, 2.0, lo=1, hi=12) - 0.6, 0, None))
    g = 0.40 * (1 + 0.12 * fine + 0.05 * mid + slab) * (1 - 0.15 * stain) * (1 - 0.45 * gum) * (1 - 0.6 * joint)
    albedo = np.stack([g * 1.0, g * 0.985, g * 0.955], -1)
    rough = np.clip(0.9 - 0.08 * gum + 0.03 * fine, 0.6, 0.98)
    ao = cavity_ao(h, 4, 120) * (1 - 0.3 * joint)
    return save("concrete", albedo, normal_map(h / px_m, 1.0), ao, rough, size_m=size)


def pavers():
    """Granite setts / plaza pavers in running bond, 0.6 x 0.3 m, 2.4 m per repeat (Harry Bridges Plaza)."""
    r = rng(303)
    size = 2.4
    px_m = size / N
    cols, rows = 4, 8  # 0.6 m by 0.3 m
    cw, rh = N // cols, N // rows
    h = np.zeros((N, N))
    tone = np.zeros((N, N, 3))
    grain = spectral(r, N, 0.3, lo=200, hi=500)
    speck = np.clip(spectral(r, N, 0.1, lo=300, hi=512) - 1.3, 0, None)
    yy, xx = np.mgrid[0:N, 0:N]
    for row in range(rows):
        off = (cw // 2) * (row % 2)
        for c in range(cols + 1):
            x0 = c * cw + off
            ys = np.arange(row * rh, (row + 1) * rh)
            xs = np.arange(x0, x0 + cw) % N
            ly = (ys - row * rh)[:, None]
            lx = np.arange(cw)[None, :]
            e = np.minimum(np.minimum(ly, rh - 1 - ly), np.minimum(lx, cw - 1 - lx)) * px_m  # metres from the stone's edge
            bevel = np.clip(e / 0.012, 0, 1) ** 0.5
            dome = r.normal(0, 0.0015) + (r.uniform(-1, 1) * (lx / cw - 0.5) + r.uniform(-1, 1) * (ly / rh - 0.5)) * 0.002
            h[np.ix_(ys, xs)] = bevel * 0.01 + dome - (1 - bevel) * 0.004
            base = np.array([0.20, 0.195, 0.19]) * (1 + r.normal(0, 0.12)) + r.normal(0, 0.004)
            tone[np.ix_(ys, xs)] = base
    h = h + grain * 0.0004
    grout = np.clip(1 - (h + 0.004) / 0.008, 0, 1)
    albedo = tone * (1 + 0.22 * grain[..., None]) + speck[..., None] * 0.16
    albedo = albedo * (1 - 0.55 * grout[..., None]) + grout[..., None] * np.array([0.12, 0.115, 0.11])
    rough = np.clip(0.78 + 0.12 * grout - 0.08 * speck + 0.03 * grain, 0.5, 0.97)
    ao = cavity_ao(h, 5, 90)
    return save("pavers", albedo, normal_map(h / px_m, 1.0), ao, rough, size_m=size)


def sandstone():
    """Dressed sandstone ashlar (the Ferry Building's Colusa sandstone, cream-buff), 1.2 m blocks by 0.6 m courses, 2.4 m per repeat."""
    r = rng(404)
    size = 2.4
    px_m = size / N
    cols, rows = 2, 4
    cw, rh = N // cols, N // rows
    h = np.zeros((N, N))
    tone = np.zeros((N, N))
    tool = spectral(r, N, 0.5, lo=80, hi=480)
    mot = spectral(r, N, 1.8, lo=2, hi=60)
    for row in range(rows):
        off = (cw // 2) * (row % 2)
        for c in range(cols + 1):
            ys = np.arange(row * rh, (row + 1) * rh)
            xs = np.arange(c * cw + off, c * cw + off + cw) % N
            ly = (ys - row * rh)[:, None]
            lx = np.arange(cw)[None, :]
            e = np.minimum(np.minimum(ly, rh - 1 - ly), np.minimum(lx, cw - 1 - lx)) * px_m
            bev = np.clip(e / 0.015, 0, 1) ** 0.6
            h[np.ix_(ys, xs)] = bev * 0.006 - (1 - bev) * 0.003
            tone[np.ix_(ys, xs)] = r.normal(0, 0.035)
    h = h + tool * 0.0005
    joint = np.clip(1 - (h + 0.003) / 0.006, 0, 1)
    # Weathering: soot gathers in the joints and streaks down from them.
    soot = blur(joint, 2.0)
    streak = np.real(np.fft.ifft2(np.fft.fft2(np.clip(spectral(r, N, 1.0, lo=8, hi=200) - 0.8, 0, None)) * np.exp(-((np.fft.fftfreq(N)[None, :] * 300) ** 2))))
    streak = norm01(streak)
    lum = (1 + 0.05 * tool + 0.08 * mot + tone) * (1 - 0.35 * soot - 0.12 * streak)
    base = np.array([0.62, 0.55, 0.44])
    albedo = base[None, None, :] * lum[..., None]
    rough = np.clip(0.82 + 0.05 * tool + 0.08 * joint, 0.6, 0.98)
    ao = cavity_ao(h, 4, 160)
    return save("sandstone", albedo, normal_map(h / px_m, 1.0), ao, rough, size_m=size)


def paint():
    """Road paint wear mask, 2 m per repeat: albedo is white paint with grit, alpha-like coverage in ORM.b? No: coverage in albedo's luminance is not usable, so the set's 'orm' R channel carries coverage (1 = paint)."""
    r = rng(505)
    size = 2.0
    px_m = size / N
    wear = spectral(r, N, 1.3, lo=3, hi=180)
    pits = np.clip(spectral(r, N, 0.2, lo=150, hi=500) - 1.1, 0, None)
    cover = np.clip(0.5 + 0.55 * wear, 0, 1)
    cover = np.clip((cover - 0.18) / 0.5, 0, 1) * (1 - np.clip(pits * 2, 0, 1))
    grit = spectral(r, N, 0.4, lo=100, hi=500)
    g = 0.78 * (1 + 0.05 * grit)
    albedo = np.stack([g, g * 0.99, g * 0.96], -1)
    h = cover * 0.0006 + grit * 0.0001
    rough = np.clip(0.62 + 0.1 * grit, 0.4, 0.9)
    return save("paint", albedo, normal_map(h / px_m, 1.0), cover, rough, size_m=size, meta={"note": "orm R channel = paint coverage (wear mask), not AO"})


def grass():
    """Mown park lawn, 3 m per repeat: blades as fine streaks, clover patches, worn and dry spots."""
    r = rng(606)
    size = 3.0
    px_m = size / N
    blades = spectral(r, N, 0.1, lo=250, hi=512)
    clump = spectral(r, N, 1.0, lo=20, hi=160)
    patch = spectral(r, N, 2.0, lo=2, hi=20)
    dry = norm01(np.clip(spectral(r, N, 2.2, lo=1, hi=10) - 0.7, 0, None))
    h = blades * 0.004 + clump * 0.006
    lum = 1 + 0.25 * blades + 0.15 * clump
    green = np.array([0.075, 0.16, 0.045])
    straw = np.array([0.22, 0.2, 0.09])
    base = green[None, None, :] * (1 + 0.12 * patch[..., None])
    albedo = (base * (1 - dry[..., None] * 0.6) + straw[None, None, :] * dry[..., None] * 0.6) * lum[..., None]
    rough = np.clip(0.88 + 0.05 * blades, 0.7, 0.98)
    ao = cavity_ao(h, 3, 60)
    return save("grass", albedo, normal_map(h / px_m, 0.6), ao, rough, size_m=size)


SETS = {"asphalt": asphalt, "concrete": concrete, "pavers": pavers, "sandstone": sandstone, "paint": paint, "grass": grass}

if __name__ == "__main__":
    names = sys.argv[1:] or list(SETS)
    manifest_path = os.path.join(OUT, "textures.json")
    manifest = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {"version": 1, "textures": {}}
    for n in names:
        manifest["textures"][n] = SETS[n]()
    manifest["textures"] = dict(sorted(manifest["textures"].items()))
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
