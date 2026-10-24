"""Bake clips for every human on generic-player.glb's skeleton: the dodge set (public/models/anim/
dodge-clips.glb) or the crowd's varied idles and walks (public/models/anim/crowd-clips.glb).
Usage: blender -b --python clips.py -- SOURCE_DIRECTORY OUTPUT.glb [--set dodge|crowd]
SOURCE_DIRECTORY holds Male_Adult_01.fbx and the Rocketbox motions named below (fetch.py --dodge).
The output has no mesh or texture: only the avatar's skeleton (the same node names, so three.js
binds its tracks to generic-player.glb's bones) and these clips, baked the way convert.py bakes
idle/walk/run (world-space motion of the matching Rocketbox source skeleton, planar root travel
removed: the simulation moves the body). Mixamo clips for the same rig are built by
assets/imports/mixamo/build.ts (--set dodge, --set crowd), not here.
"""
import bpy, math, os, sys, json, struct
from mathutils import Matrix, Vector, Quaternion

args = sys.argv[sys.argv.index('--') + 1:]
which = 'dodge'
if '--set' in args:
    which = args[args.index('--set') + 1]
    args = [a for i, a in enumerate(args) if a != '--set' and (i == 0 or args[i - 1] != '--set')]
source, output = args[0], args[1]

# (clip name, Rocketbox file): what each dodge phase plays (src/render/human-motion.ts).
DODGE_ROCKETBOX = [
    ('sprint', 'm_run_fast_01.max.fbx'),      # running flat out out of the way
    ('runStart', 'm_run_start.max.fbx'),      # the startled push-off into a run
    ('runStop', 'm_run_stop.max.fbx'),        # pulling up once clear
    ('recover', 'm_idle_dust_01.max.fbx'),    # brushing off, catching their breath
]
# The crowd: walks and idles to vary who does what (Lane R's skinned crowd picks by agent id).
CROWD_ROCKETBOX = [
    ('walkStroll', 'm_walk_stroll_01.max.fbx'),
    ('walkSlow', 'm_walk_slow_01.max.fbx'),
    ('walkFast', 'm_walk_fast_01.max.fbx'),
    ('walkCool', 'm_walk_cool_01.max.fbx'),
    ('jog', 'm_run_slow_01.max.fbx'),
    ('idleBreathe', 'm_idle_breathe_01.max.fbx'),
    ('idleTexting', 'm_cell_phone_textmessage.max.fbx'),  # (its first ROCKETBOX_MAX_FRAMES)
    ('idleWaiting', 'm_idle_waiting_01.max.fbx'),
]
ROCKETBOX = CROWD_ROCKETBOX if which == 'crowd' else DODGE_ROCKETBOX

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


# A long Rocketbox idle is cut to its first 10 s (a loop the crowd plays from a random point).
ROCKETBOX_MAX_FRAMES = 300
for label, filename in ROCKETBOX:
    actor, imported, before_actions = import_actor(os.path.join(source, filename))
    src_action = actor.animation_data.action; start, end = map(int, src_action.frame_range)
    end = min(end, start + ROCKETBOX_MAX_FRAMES - 1)
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
