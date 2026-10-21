"""Look-dev scene helpers (Cycles CPU): import the exported GLBs into a lit set and render.

The renders exist for art sign-off. They import public/models/*.glb (not the build scripts'
in-memory scenes), so what is signed off is exactly what the game loads.

World frame: Blender +X = east, +Y = north (glTF -Z), +Z up, metres. A landmark placed at
game-local (x, z) with heading h sits at Blender (x, -z) rotated -h about Z, exactly as the
renderer does with rotation.y = -heading.
"""

from __future__ import annotations

import math
import os
import random

import bpy
from mathutils import Quaternion, Vector

import fc

LOOKDEV_DIR = os.path.join(fc.BLENDER_DIR, "lookdev")


def setup(res=(960, 540), samples=64, exposure=0.0, look="AgX - Medium High Contrast"):
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.use_denoising = True
    sc.cycles.denoiser = "OPENIMAGEDENOISE"
    sc.cycles.max_bounces = 6
    sc.cycles.transparent_max_bounces = 16
    sc.cycles.blur_glossy = 1.0
    sc.cycles.sample_clamp_indirect = 8.0
    sc.render.resolution_x, sc.render.resolution_y = res
    sc.render.resolution_percentage = 100
    # quick drafts: FC_LOOKDEV_DRAFT=1 renders at 40% with 8 samples (into FC_LOOKDEV_OUT)
    if os.environ.get("FC_LOOKDEV_DRAFT"):
        sc.render.resolution_percentage = 40
        sc.cycles.samples = 8
    sc.render.threads_mode = "FIXED"
    sc.render.threads = int(os.environ.get("FC_RENDER_THREADS", "2"))
    sc.view_settings.view_transform = "AgX"
    try:
        sc.view_settings.look = look
    except TypeError:
        pass
    sc.view_settings.exposure = exposure
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    sc.render.image_settings.compression = 100
    return sc


def world_gradient(stops, strength=1.0, sun_dir=None, sun_color=(1, 0.8, 0.5), sun_glow=0.0):
    """Sky from a colour ramp over elevation: stops = [(pos 0..1 from nadir to zenith, hex)].

    sun_glow adds a soft halo toward sun_dir (a unit vector toward the sun).
    """
    sc = bpy.context.scene
    w = bpy.data.worlds.new("sky")
    sc.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    mr = nt.nodes.new("ShaderNodeMapRange")
    mr.inputs["From Min"].default_value = -1.0
    mr.inputs["From Max"].default_value = 1.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    cr = ramp.color_ramp
    cr.elements.remove(cr.elements[1])
    first = True
    for pos, hx in stops:
        e = cr.elements[0] if first else cr.elements.new(pos)
        e.position = pos
        e.color = (*fc.hex_rgb(hx), 1.0)
        first = False
    nt.links.new(tc.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
    nt.links.new(mr.outputs["Result"], ramp.inputs["Fac"])
    col = ramp.outputs["Color"]
    if sun_dir is not None and sun_glow > 0:
        dot = nt.nodes.new("ShaderNodeVectorMath")
        dot.operation = "DOT_PRODUCT"
        dot.inputs[1].default_value = tuple(Vector(sun_dir).normalized())
        nt.links.new(tc.outputs["Generated"], dot.inputs[0])
        pw = nt.nodes.new("ShaderNodeMath")
        pw.operation = "POWER"
        nt.links.new(dot.outputs["Value"], pw.inputs[0])
        pw.inputs[1].default_value = 24.0
        cl = nt.nodes.new("ShaderNodeClamp")
        nt.links.new(pw.outputs[0], cl.inputs["Value"])
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "ADD"
        nt.links.new(cl.outputs[0], mix.inputs["Factor"])
        nt.links.new(col, mix.inputs["A"])
        mix.inputs["B"].default_value = (sun_color[0] * sun_glow, sun_color[1] * sun_glow, sun_color[2] * sun_glow, 1)
        col = mix.outputs["Result"]
    nt.links.new(col, bg.inputs["Color"])
    bg.inputs["Strength"].default_value = strength
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    return w


def sun(azimuth_deg, elevation_deg, energy, color="#ffffff", angle_deg=1.0):
    """A sun shining FROM the compass azimuth (0 = north = +Y, 90 = east = +X)."""
    a, e = math.radians(azimuth_deg), math.radians(elevation_deg)
    to_sun = Vector((math.sin(a) * math.cos(e), math.cos(a) * math.cos(e), math.sin(e)))
    lamp = bpy.data.lights.new("sun", "SUN")
    lamp.energy = energy
    lamp.color = fc.hex_rgb(color)
    lamp.angle = math.radians(angle_deg)
    ob = bpy.data.objects.new("sun", lamp)
    ob.rotation_euler = (-to_sun).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(ob)
    return ob, to_sun


def point_light(loc, energy, color="#ffd29a", radius=0.15, kind="POINT", size=None, rot=None, spot=None):
    lamp = bpy.data.lights.new("lamp", kind)
    if kind == "SPOT" and spot is not None:
        lamp.spot_size, lamp.spot_blend = spot
    lamp.energy = energy
    lamp.color = fc.hex_rgb(color)
    if kind == "POINT" or kind == "SPOT":
        lamp.shadow_soft_size = radius
    if kind == "AREA" and size is not None:
        lamp.shape = "RECTANGLE"
        lamp.size, lamp.size_y = size
    ob = bpy.data.objects.new("lamp", lamp)
    ob.location = loc
    if rot is not None:
        ob.rotation_euler = rot
    bpy.context.scene.collection.objects.link(ob)
    return ob


def camera(loc, look_at, lens=35.0, clip_end=3000.0):
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    cam.data.lens = lens
    cam.data.clip_end = clip_end
    cam.location = loc
    cam.rotation_euler = (Vector(look_at) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


def compositor(mist=None, glare=None, mist_falloff="QUADRATIC"):
    """Mist (start, depth, hex colour, max fog) from the mist pass; glare = bloom threshold."""
    sc = bpy.context.scene
    sc.use_nodes = True
    nt = sc.node_tree
    nt.nodes.clear()
    rl = nt.nodes.new("CompositorNodeRLayers")
    comp = nt.nodes.new("CompositorNodeComposite")
    img = rl.outputs["Image"]
    if mist is not None:
        start, depth, hx, maxf = mist
        sc.view_layers[0].use_pass_mist = True
        sc.world.mist_settings.start = start
        sc.world.mist_settings.depth = depth
        sc.world.mist_settings.falloff = mist_falloff
        mul = nt.nodes.new("CompositorNodeMath")
        mul.operation = "MULTIPLY"
        nt.links.new(rl.outputs["Mist"], mul.inputs[0])
        mul.inputs[1].default_value = maxf
        mix = nt.nodes.new("CompositorNodeMixRGB")
        nt.links.new(mul.outputs[0], mix.inputs["Fac"])
        nt.links.new(img, mix.inputs[1])
        mix.inputs[2].default_value = (*fc.hex_rgb(hx), 1.0)
        img = mix.outputs["Image"]
    if glare is not None:
        g = nt.nodes.new("CompositorNodeGlare")
        try:
            g.glare_type = "BLOOM"
        except TypeError:
            g.glare_type = "FOG_GLOW"
        g.quality = "HIGH"
        g.threshold = glare
        try:
            g.size = 7
        except (TypeError, AttributeError):
            pass
        nt.links.new(img, g.inputs["Image"])
        img = g.outputs["Image"]
    nt.links.new(img, comp.inputs["Image"])


def import_glb(file, x=0.0, y=0.0, z=0.0, heading_deg=0.0, game_xz=None):
    """Import public/models/<file>; place its root at Blender (x, y, z) or game (x, z)."""
    before = set(bpy.data.objects)
    try:  # skinned files: no display shapes for the bones (they would be extra roots)
        bpy.ops.import_scene.gltf(filepath=os.path.join(fc.MODELS_OUT, file), disable_bone_shape=True)
    except TypeError:
        bpy.ops.import_scene.gltf(filepath=os.path.join(fc.MODELS_OUT, file))
    new = [o for o in bpy.data.objects if o not in before]
    roots = [o for o in new if o.parent is None]
    assert len(roots) == 1, f"{file}: expected one root, got {[r.name for r in roots]}"
    root = roots[0]
    if game_xz is not None:
        x, y = game_xz[0], -game_xz[1]
    root.location = (x, y, z)
    root.rotation_mode = "XYZ"
    root.rotation_euler = (0.0, 0.0, -math.radians(heading_deg))
    return root, {o.name: o for o in new}


def set_clock(objs, minute_of_day):
    """Turn every clock hand (extras clockHand) to the time: clockwise about glTF local +Z."""
    m = minute_of_day % 720.0
    for o in objs.values():
        kind = o.get("clockHand")
        if kind not in ("hour", "minute"):
            continue
        turn = (m / 720.0) if kind == "hour" else ((minute_of_day % 60.0) / 60.0)
        # glTF local +Z is Blender local -Y; clockwise seen from the front = negative about +Z
        q = Quaternion((0.0, -1.0, 0.0), -2 * math.pi * turn)
        o.rotation_mode = "QUATERNION"
        o.rotation_quaternion = o.rotation_quaternion @ q


def emission(objs_or_mats, strength, prefix="light_", color=None):
    """Turn up (night) or off (day) the night lights: every light_* material."""
    mats = set()
    for o in objs_or_mats:
        if isinstance(o, bpy.types.Material):
            mats.add(o)
        elif getattr(o, "data", None) is not None and hasattr(o.data, "materials"):
            mats.update(m for m in o.data.materials if m)
    for m in mats:
        if not m.name.startswith(prefix) or not m.use_nodes:
            continue
        for n in m.node_tree.nodes:
            if n.type == "BSDF_PRINCIPLED":
                n.inputs["Emission Strength"].default_value = strength
                if color is not None:
                    n.inputs["Emission Color"].default_value = (*fc.hex_rgb(color), 1.0)


def flat_material(name, color, rough=0.8, metal=0.0, emission=None, strength=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*fc.hex_rgb(color), 1.0)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emission is not None:
        b.inputs["Emission Color"].default_value = (*fc.hex_rgb(emission), 1.0)
        b.inputs["Emission Strength"].default_value = strength
    return m


def noisy_material(name, c1, c2, scale=0.6, rough=0.85, bump=0.0):
    """Paving/asphalt: two colours mixed by noise, optional bump."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes["Principled BSDF"]
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = 6.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (*fc.hex_rgb(c1), 1)
    ramp.color_ramp.elements[1].color = (*fc.hex_rgb(c2), 1)
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    if bump > 0:
        bp = nt.nodes.new("ShaderNodeBump")
        bp.inputs["Strength"].default_value = bump
        nt.links.new(noise.outputs["Fac"], bp.inputs["Height"])
        nt.links.new(bp.outputs["Normal"], b.inputs["Normal"])
    return m


def quad(name, x0, y0, x1, y1, z, mat):
    mb = fc.MeshBuilder()
    mb.poly([(x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z)], mat)
    return mb.build(name)


def palm(mb_trunk: fc.MeshBuilder, mb_fronds: fc.MeshBuilder, x, y, h, trunk_mat, frond_mat, seed=0, fronds=16):
    """A Canary Island date palm: a stout trunk with a bulb under a round crown of fronds."""
    rnd = random.Random(seed)
    mb_trunk.push(fc.Matrix.Translation((x, y, 0)))
    mb_trunk.lathe([(0.65, 0.0), (0.55, 0.6), (0.45, 1.5), (0.42, h * 0.8), (0.55, h - 0.4), (0.7, h), (0.35, h + 0.5), (0.0, h + 0.7)],
                   10, trunk_mat, smooth=True)
    mb_trunk.pop()
    for k in range(fronds):
        a = 2 * math.pi * k / fronds + rnd.uniform(-0.15, 0.15)
        tilt = rnd.uniform(0.15, 0.75)
        L = rnd.uniform(4.0, 5.2)
        pts = []
        for i in range(7):
            t = i / 6
            r = L * t
            z = h + 0.4 + math.sin(tilt) * r * 1.2 - 2.6 * t * t * (0.6 + tilt)
            pts.append((x + r * math.cos(a), y + r * math.sin(a), z))
        side = (-math.sin(a), math.cos(a), 0.0)
        for i in range(6):
            w0 = 0.55 * math.sin(math.pi * (i / 6) * 0.9 + 0.15)
            w1 = 0.55 * math.sin(math.pi * ((i + 1) / 6) * 0.9 + 0.15)
            p0, p1 = pts[i], pts[i + 1]
            q = [
                (p0[0] - side[0] * w0, p0[1] - side[1] * w0, p0[2] + 0.05),
                (p1[0] - side[0] * w1, p1[1] - side[1] * w1, p1[2] + 0.05),
                (p1[0] + side[0] * w1, p1[1] + side[1] * w1, p1[2] + 0.05),
                (p0[0] + side[0] * w0, p0[1] + side[1] * w0, p0[2] + 0.05),
            ]
            mb_fronds.poly(q, frond_mat, smooth=True)


def strip_png_text(path):
    """Drop the PNG's text chunks (Blender writes the date and render timings there), so a
    re-render of an unchanged scene is byte-identical and leaves git status clean."""
    import struct

    with open(path, "rb") as f:
        data = f.read()
    out, i = [data[:8]], 8
    while i < len(data):
        n = struct.unpack(">I", data[i : i + 4])[0]
        kind = data[i + 4 : i + 8]
        if kind not in (b"tEXt", b"zTXt", b"iTXt"):
            out.append(data[i : i + 12 + n])
        i += 12 + n
    with open(path, "wb") as f:
        f.write(b"".join(out))


def render(name):
    sc = bpy.context.scene
    if os.environ.get("FC_LOOKDEV_DRAFT"):
        sc.cycles.samples = 8
    out_dir = os.environ.get("FC_LOOKDEV_OUT", LOOKDEV_DIR)
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, name)
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    strip_png_text(path)
    print(f"[lookdev] wrote {os.path.relpath(path, fc.REPO)} ({os.path.getsize(path) // 1024} KiB)")
    return path
