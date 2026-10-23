"""Bake the dodge clips for generic-player.glb into public/models/generic-player-dodge.glb.
Usage: blender -b --python clips.py -- SOURCE_DIRECTORY OUTPUT.glb [MIXAMO_DIRECTORY]
SOURCE_DIRECTORY holds Male_Adult_01.fbx and the Rocketbox motions named below (fetch.py --dodge).
The output has no mesh or texture: only the avatar's skeleton (the same node names, so three.js
binds its tracks to generic-player.glb's bones) and these clips, baked the way convert.py bakes
idle/walk/run (world-space motion of the matching Rocketbox source skeleton, planar root travel
removed: the simulation moves the body). With MIXAMO_DIRECTORY, Mixamo clips are retargeted onto
the same rig by bone direction (see retarget_mixamo below).
"""
import bpy, math, os, sys, json, struct
from mathutils import Matrix, Vector, Quaternion

args = sys.argv[sys.argv.index('--') + 1:]
source, output = args[0], args[1]
mixamo = args[2] if len(args) > 2 else None

# (clip name, Rocketbox file): what each dodge phase plays (src/render/player-body.ts).
ROCKETBOX = [
    ('sprint', 'm_run_fast_01.max.fbx'),      # running flat out out of the way
    ('runStart', 'm_run_start.max.fbx'),      # the startled push-off into a run
    ('runStop', 'm_run_stop.max.fbx'),        # pulling up once clear
    ('recover', 'm_idle_dust_01.max.fbx'),    # brushing off, catching their breath
]
# (clip name, Mixamo file, first frame, last frame): retargeted (Mixamo, used in-game under its licence).
MIXAMO = [
    ('stumble', 'Stumble Backwards.fbx', 1, 20),  # the override's shove: staggering back, cut before any fall
    ('flinch', 'Dodging Right.fbx', 1, 44),       # a sidestep's flinch away from the car
]

bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.fbx(filepath=os.path.join(source, 'Male_Adult_01.fbx'), use_anim=False)
rig = next(o for o in bpy.context.scene.objects if o.type == 'ARMATURE')
mesh = next(o for o in bpy.context.scene.objects if o.type == 'MESH')
base_objects = set(bpy.data.objects)
root = bpy.data.objects.new('generic-player', None); bpy.context.scene.collection.objects.link(root)
for obj in base_objects:
    if obj.parent is None: obj.parent = root
root.rotation_euler.z = math.pi  # as convert.py: Rocketbox faces -Y; the game faces glTF -Z
body_names = {'Bip01 Pelvis', 'Bip01 Spine', 'Bip01 Spine1', 'Bip01 Spine2', 'Bip01 Neck', 'Bip01 Head'}
body_names.update(b.name for b in rig.data.bones if any(t in b.name for t in ['Clavicle', 'UpperArm', 'Forearm', 'Hand', 'Finger', 'Thigh', 'Calf', 'Foot', 'Toe']))
rig.animation_data_create(); rig.animation_data.action = None
for old in list(bpy.data.actions): bpy.data.actions.remove(old)
bpy.context.scene.render.fps = 30
# The feet on the origin, as convert.py leaves generic-player.glb (its root is lowered by the floor).
bpy.context.view_layer.update()
floor = min((mesh.matrix_world @ v.co).z for v in mesh.data.vertices)
root.location.z -= floor
bpy.context.view_layer.update()
clip_info = []


def keyframe(label, samples):
    """Key world-space bone matrices (samples[i][bone] in rig space) as a clip, as convert.py does."""
    action = bpy.data.actions.new(label); rig.animation_data.action = action
    for index, desired in enumerate(samples):
        for name, matrix in desired.items():
            bone = rig.pose.bones[name]; parent = bone.parent
            parent_matrix = desired.get(parent.name) if parent else None
            if parent and parent_matrix is None: parent_matrix = parent.matrix
            kwargs = {'invert': True}
            if parent: kwargs.update(parent_matrix=parent_matrix, parent_matrix_local=parent.bone.matrix_local)
            basis = bone.bone.convert_local_to_pose(matrix, bone.bone.matrix_local, **kwargs)
            bone.rotation_mode = 'QUATERNION'; bone.location, bone.rotation_quaternion, bone.scale = basis.decompose()
            bone.keyframe_insert('location', frame=index + 1); bone.keyframe_insert('rotation_quaternion', frame=index + 1); bone.keyframe_insert('scale', frame=index + 1)
    for curve in action.fcurves:
        for key in curve.keyframe_points: key.interpolation = 'LINEAR'
    rig.animation_data.action = None
    track = rig.animation_data.nla_tracks.new(); track.name = label
    strip = track.strips.new(label, 1, action); strip.action_frame_start = 1; strip.action_frame_end = len(samples)


def import_actor(path):
    before = set(bpy.data.objects); before_actions = set(bpy.data.actions)
    bpy.ops.import_scene.fbx(filepath=path, use_anim=True)
    imported = list(set(bpy.data.objects) - before)
    actor = next(o for o in imported if o.type == 'ARMATURE')
    return actor, imported, before_actions


def drop(imported, before_actions):
    for obj in imported: bpy.data.objects.remove(obj, do_unlink=True)
    for other in list(set(bpy.data.actions) - before_actions):
        if other.users == 0: bpy.data.actions.remove(other)


for label, filename in ROCKETBOX:
    actor, imported, before_actions = import_actor(os.path.join(source, filename))
    src_action = actor.animation_data.action; start, end = map(int, src_action.frame_range)
    samples = []; origin = None; last = None
    for frame in range(start, end + 1):
        bpy.context.scene.frame_set(frame); bpy.context.view_layer.update()
        pelvis = actor.matrix_world @ actor.pose.bones['Bip01 Pelvis'].matrix
        xy = Vector((pelvis.translation.x, pelvis.translation.y, 0))
        if origin is None: origin = xy.copy()
        last = xy.copy()
        desired = {}
        for name in body_names:
            if name not in actor.pose.bones: continue
            world = actor.matrix_world @ actor.pose.bones[name].matrix
            world.translation -= xy
            desired[name] = rig.matrix_world.inverted() @ root.matrix_world @ world
        samples.append(desired)
    keyframe(label, samples)
    duration = (end - start) / 30
    clip_info.append({'name': label, 'source': 'Microsoft Rocketbox ' + filename, 'frames': len(samples), 'duration': duration, 'sourceSpeed': round((last - origin).length / duration, 4) if duration else 0})
    drop(imported, before_actions)

# Mixamo bone -> Rocketbox bone.
MAP = {
    'Hips': 'Bip01 Pelvis', 'Spine': 'Bip01 Spine', 'Spine1': 'Bip01 Spine1', 'Spine2': 'Bip01 Spine2', 'Neck': 'Bip01 Neck', 'Head': 'Bip01 Head',
}
for side, s in (('Left', 'L'), ('Right', 'R')):
    MAP.update({
        f'{side}Shoulder': f'Bip01 {s} Clavicle', f'{side}Arm': f'Bip01 {s} UpperArm', f'{side}ForeArm': f'Bip01 {s} Forearm', f'{side}Hand': f'Bip01 {s} Hand',
        f'{side}UpLeg': f'Bip01 {s} Thigh', f'{side}Leg': f'Bip01 {s} Calf', f'{side}Foot': f'Bip01 {s} Foot', f'{side}ToeBase': f'Bip01 {s} Toe0',
    })


def retarget_mixamo(label, path, first, last_frame):
    """
    Retarget by bone direction: each mapped Rocketbox bone takes its source bone's rotation since
    the source's rest pose, applied after first turning the target's rest pose to point its bone
    where the source's rest bone points (the T-pose/A-pose difference). The pelvis takes the source
    hips' height change, scaled by the two rigs' hip heights; planar travel is removed.
    """
    actor, imported, before_actions = import_actor(path)
    prefix = next(b.name for b in actor.data.bones if b.name.endswith('Hips'))[:-4]
    actor.animation_data.action.frame_range  # (loaded)
    # Rest: source and target world rotations and bone directions (in the target rig's space).
    to_rig = rig.matrix_world.inverted() @ root.matrix_world  # (target rig space from world: as the samples)
    src_rest = {}
    for m, r in MAP.items():
        sb = actor.data.bones.get(prefix + m)
        if sb is None or r not in rig.pose.bones: continue
        # (A hand's end: its middle finger; a foot's: its toe.)
        src_rest[r] = (actor.matrix_world @ sb.matrix_local)
    tgt_rest = {r: (rig.matrix_world @ rig.data.bones[r].matrix_local) for r in src_rest}
    # The correction turns each limb bone's rest segment (its joint to its child's joint) onto
    # the source's (the T-pose/A-pose difference: arms out vs down); a bone with no mapped child
    # (hand, foot, toe, head) takes its parent's. The biped's own bone axes are not used: 3ds Max
    # bones do not run along Blender's Y.
    inv = {r: m for m, r in MAP.items()}
    child_of = {}
    for m, r in MAP.items():
        for m2, r2 in MAP.items():
            b2 = rig.data.bones.get(r2)
            if b2 is not None and b2.parent is not None and b2.parent.name == r and r2 in src_rest:
                child_of.setdefault(r, r2)
    child_of['Bip01 Spine2'] = 'Bip01 Neck'
    child_of['Bip01 Neck'] = 'Bip01 Head'
    corr = {}
    for b in rig.data.bones:
        r = b.name
        if r not in src_rest: continue
        c = child_of.get(r)
        # (Both rigs stand upright and flat-footed at rest: the trunk, the head and the feet need no turn.)
        upright = r in ('Bip01 Pelvis', 'Bip01 Spine', 'Bip01 Spine1', 'Bip01 Spine2', 'Bip01 Neck', 'Bip01 Head') or 'Foot' in r or 'Toe' in r
        if upright:
            corr[r] = Quaternion()
        elif c is not None:
            ds = (src_rest[c].translation - src_rest[r].translation).normalized()
            dt = (tgt_rest[c].translation - tgt_rest[r].translation).normalized()
            corr[r] = dt.rotation_difference(ds)
        else:
            parent = b.parent
            while parent is not None and parent.name not in corr: parent = parent.parent
            corr[r] = corr[parent.name] if parent is not None else Quaternion()
    hip_src = src_rest['Bip01 Pelvis'].translation.z
    hip_tgt = tgt_rest['Bip01 Pelvis'].translation.z
    k = hip_tgt / hip_src if hip_src > 1e-6 else 1
    samples = []; origin = None
    for frame in range(first, last_frame + 1):
        bpy.context.scene.frame_set(frame); bpy.context.view_layer.update()
        desired = {}
        for m, r in MAP.items():
            pb = actor.pose.bones.get(prefix + m)
            if pb is None or r not in corr: continue
            cur = actor.matrix_world @ pb.matrix
            delta = cur.to_quaternion() @ src_rest[r].to_quaternion().inverted()
            rot = delta @ corr[r] @ tgt_rest[r].to_quaternion()
            if r == 'Bip01 Pelvis':
                t = cur.translation
                if origin is None: origin = Vector((t.x, t.y, 0))
                pos = Vector((tgt_rest[r].translation.x, tgt_rest[r].translation.y, hip_tgt + (t.z - hip_src) * k))
            else:
                pos = None
            # (World matrices carry the rig's import scale: keep the target rest's.)
            mat = Matrix.LocRotScale(pos if pos is not None else Vector(), rot, tgt_rest[r].to_scale())
            desired[r] = (mat, pos is not None)
        # Children keep their rest offsets from their parents: position each from its parent.
        world = {}
        order = [b.name for b in rig.data.bones if b.name in desired]
        for name in order:
            mat, has_pos = desired[name]
            bone = rig.data.bones[name]
            if not has_pos:
                parent = bone.parent
                while parent is not None and parent.name not in world: parent = parent.parent
                if parent is not None:
                    offset = (rig.matrix_world @ parent.matrix_local).inverted() @ (rig.matrix_world @ bone.matrix_local)
                    mat = mat.copy(); mat.translation = (world[parent.name] @ offset).translation
                else:
                    mat = mat.copy(); mat.translation = (rig.matrix_world @ bone.matrix_local).translation
            world[name] = mat
        samples.append({n: rig.matrix_world.inverted() @ world[n] for n in world})
    keyframe(label, samples)
    clip_info.append({'name': label, 'source': 'Mixamo ' + os.path.basename(path), 'frames': len(samples), 'duration': (last_frame - first) / 30, 'sourceSpeed': 0})
    drop(imported, before_actions)


if mixamo:
    for label, filename, first, last_frame in MIXAMO:
        retarget_mixamo(label, os.path.join(mixamo, filename), first, last_frame)

for obj in list(bpy.data.objects):
    if obj not in (root, rig): bpy.data.objects.remove(obj, do_unlink=True)
root['source'] = 'Microsoft Rocketbox Male_Adult_01 skeleton (MIT); clips: see assets/imports/rocketbox/README.md'
root['clips'] = json.dumps(clip_info)
bpy.context.scene.frame_set(1); bpy.context.view_layer.update()
bpy.ops.export_scene.gltf(filepath=output, export_format='GLB', export_extras=True, export_yup=True, export_animations=True, export_animation_mode='NLA_TRACKS', export_force_sampling=True, export_frame_step=1, export_optimize_animation_size=True, export_skins=True, export_def_bones=False, export_morph=False)
with open(output, 'rb') as handle: glb = handle.read()
json_length = struct.unpack_from('<I', glb, 12)[0]
document = json.loads(glb[20:20 + json_length])
with open(os.path.join(os.path.dirname(__file__), 'LICENSE.md')) as handle: notice = handle.read()
document['asset']['copyright'] = notice
encoded = json.dumps(document, separators=(',', ':')).encode('utf8')
encoded += b' ' * ((-len(encoded)) % 4)
remaining = glb[20 + json_length:]
with open(output, 'wb') as handle:
    handle.write(struct.pack('<4sII', b'glTF', 2, 20 + len(encoded) + len(remaining)))
    handle.write(struct.pack('<II', len(encoded), 0x4e4f534a)); handle.write(encoded); handle.write(remaining)
print('DODGE_CLIPS_INFO', json.dumps({'clips': clip_info, 'output': output, 'bytes': os.path.getsize(output)}))
