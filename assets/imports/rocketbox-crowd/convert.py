"""Convert one Microsoft Rocketbox (MIT) adult avatar into a crowd pedestrian GLB.
Usage: blender -b --python convert.py -- SOURCE_DIRECTORY CHARACTER GENDER OUTPUT.glb
SOURCE_DIRECTORY is fetch.py's output. The same conversion as the player's
(assets/imports/rocketbox/convert.py): the original skinned mesh and rig, idle/walk/run clips
retargeted from the matching library skeleton with planar root travel removed, facing glTF -Z,
feet at the origin. Crowd textures are capped at 512 pixels (pedestrians are seen from metres away).
"""
import bpy, math, os, sys, json, struct
from mathutils import Matrix, Vector
args=sys.argv[sys.argv.index('--')+1:]
source,character,gender,output=args
import glob
char_dir=os.path.join(source,character)
prefix=os.path.basename(sorted(glob.glob(os.path.join(char_dir,'*_body_color.tga')))[0]).split('_body_color')[0]
spec=json.load(open(os.path.join(os.path.dirname(__file__),'crowd.json')))
clips=spec['clips'][gender]
IDLE_FRAMES=150
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
bpy.ops.import_scene.fbx(filepath=os.path.join(char_dir,character+'.fbx'),use_anim=False)
rig=next(o for o in bpy.context.scene.objects if o.type=='ARMATURE')
mesh=next(o for o in bpy.context.scene.objects if o.type=='MESH')
mesh.name='crowd_body'
base_objects=set(bpy.data.objects)
# Preserve the original skin's bind matrices. A parent normalizes the world orientation.
root=bpy.data.objects.new('crowd:'+character,None);bpy.context.scene.collection.objects.link(root)
for obj in base_objects:
 if obj.parent is None:obj.parent=root
root.rotation_euler.z=math.pi # Rocketbox faces -Y; the game requires glTF -Z (= Blender +Y).
root['source']='Microsoft Rocketbox '+character;root['license']='MIT';root['heightM']=1.7
root['gender']=gender;root['walkSpeedMps']=1.35;root['runSpeedMps']=3.5
# glTF has base color and tangent-space normal textures, with high detail on the face.
for mat in mesh.data.materials:
 part='head' if 'head' in mat.name else 'opacity' if 'opacity' in mat.name else 'body'
 mat.name='crowd_'+('face' if part=='head' else 'hair' if part=='opacity' else 'body')
 mat.use_nodes=True;mat.node_tree.nodes.clear()
 nodes=mat.node_tree.nodes;links=mat.node_tree.links
 shader=nodes.new('ShaderNodeBsdfPrincipled');out=nodes.new('ShaderNodeOutputMaterial');links.new(shader.outputs['BSDF'],out.inputs['Surface'])
 shader.inputs['Roughness'].default_value=.64 if part=='body' else .56
 shader.inputs['Metallic'].default_value=0
 color=bpy.data.images.load(os.path.join(char_dir,prefix+'_'+part+'_color.tga'),check_existing=False)
 target=512
 if color.size[0]>target:color.scale(target,target)
 color.file_format='PNG' if part=='opacity' else 'JPEG'
 if part!='opacity':
  converted=os.path.join(source,'converted');os.makedirs(converted,exist_ok=True)
  color.filepath_raw=os.path.join(converted,character+'_'+part+'_color.jpg');color.save()
  color=bpy.data.images.load(color.filepath_raw,check_existing=False)
 color.pack();tex=nodes.new('ShaderNodeTexImage');tex.image=color;links.new(tex.outputs['Color'],shader.inputs['Base Color'])
 if part=='opacity':
  links.new(tex.outputs['Alpha'],shader.inputs['Alpha']);mat.surface_render_method='DITHERED';mat.use_transparency_overlap=False
 else:
  image=bpy.data.images.load(os.path.join(char_dir,prefix+'_'+part+'_normal.tga'),check_existing=False);image.colorspace_settings.name='Non-Color'
  if image.size[0]>512:image.scale(512,512)
  image.file_format='PNG';image.pack();normal_tex=nodes.new('ShaderNodeTexImage');normal_tex.image=image
  normal=nodes.new('ShaderNodeNormalMap');links.new(normal_tex.outputs['Color'],normal.inputs['Color']);links.new(normal.outputs['Normal'],shader.inputs['Normal'])
# Bake world-space motion from matching Rocketbox source skeletons into the avatar's bind rig.
# Root XY motion is removed: gameplay supplies translation. Head facial joints remain neutral.
body_names={'Bip01 Pelvis','Bip01 Spine','Bip01 Spine1','Bip01 Spine2','Bip01 Neck','Bip01 Head'}
body_names.update(b.name for b in rig.data.bones if any(t in b.name for t in ['Clavicle','UpperArm','Forearm','Hand','Finger','Thigh','Calf','Foot','Toe']))
rig.animation_data_create();rig.animation_data.action=None
for old in list(bpy.data.actions):bpy.data.actions.remove(old)
bpy.context.scene.render.fps=30
clip_info=[]
for label in ['idle','walk','run']:
 filename=os.path.basename(clips[label])
 before=set(bpy.data.objects);before_actions=set(bpy.data.actions)
 bpy.ops.import_scene.fbx(filepath=os.path.join(source,filename),use_anim=True)
 imported=list(set(bpy.data.objects)-before);actor=next(o for o in imported if o.type=='ARMATURE')
 src_action=actor.animation_data.action;start,end=map(int,src_action.frame_range)
 if label=='idle':end=min(end,start+IDLE_FRAMES-1) # a 5 s idle loop keeps each crowd file small
 samples=[];origin=None;last_origin=None
 for frame in range(start,end+1):
  bpy.context.scene.frame_set(frame);bpy.context.view_layer.update()
  pelvis=actor.matrix_world@actor.pose.bones['Bip01 Pelvis'].matrix
  xy=Vector((pelvis.translation.x,pelvis.translation.y,0))
  if origin is None:origin=xy.copy()
  last_origin=xy.copy()
  desired={}
  for name in body_names:
   if name not in actor.pose.bones:continue
   world=actor.matrix_world@actor.pose.bones[name].matrix
   world.translation-=xy
   desired[name]=rig.matrix_world.inverted()@root.matrix_world@world
  samples.append(desired)
 # Source clips supply a compatible biped pose, even though their FBX bind pose differs.
 # Convert each desired pose against target rest matrices explicitly, independent of update order.
 action=bpy.data.actions.new(label);rig.animation_data.action=action
 for index,desired in enumerate(samples):
  for name,matrix in desired.items():
   bone=rig.pose.bones[name];parent=bone.parent
   parent_matrix=desired.get(parent.name) if parent else None
   if parent and parent_matrix is None:parent_matrix=parent.matrix
   kwargs={'invert':True}
   if parent:kwargs.update(parent_matrix=parent_matrix,parent_matrix_local=parent.bone.matrix_local)
   basis=bone.bone.convert_local_to_pose(matrix,bone.bone.matrix_local,**kwargs)
   bone.rotation_mode='QUATERNION';bone.location,bone.rotation_quaternion,bone.scale=basis.decompose()
   bone.keyframe_insert('location',frame=index+1);bone.keyframe_insert('rotation_quaternion',frame=index+1);bone.keyframe_insert('scale',frame=index+1)
 for curve in action.fcurves:
  for key in curve.keyframe_points:key.interpolation='LINEAR'
 duration=(end-start)/30
 speed=(last_origin-origin).length/duration if duration else 0
 if label=='walk' and speed>.1:root['walkSpeedMps']=round(speed,4)
 if label=='run' and speed>.1:root['runSpeedMps']=round(speed,4)
 clip_info.append({'name':label,'frames':len(samples),'duration':duration,'sourceSpeed':speed})
 rig.animation_data.action=None
 track=rig.animation_data.nla_tracks.new();track.name=label;strip=track.strips.new(label,1,action);strip.action_frame_start=1;strip.action_frame_end=len(samples)
 # FBX helper/temporary rigs are never exported.
 for obj in imported:bpy.data.objects.remove(obj,do_unlink=True)
 for other in list(set(bpy.data.actions)-before_actions):
  if other!=action and other.users==0:bpy.data.actions.remove(other)
# Foot origin of the authored A-pose; animation translations remain relative to it.
rig.animation_data.action=None
for track in rig.animation_data.nla_tracks:track.mute=True
for bone in rig.pose.bones:bone.matrix_basis=Matrix.Identity(4)
bpy.context.scene.frame_set(1);bpy.context.view_layer.update()
points=[mesh.matrix_world@v.co for v in mesh.data.vertices];floor=min(p.z for p in points)
root.location.z-=floor
root['heightM']=round(max(p.z for p in points)-floor,4)
bpy.context.view_layer.update()
# A glTF skinned mesh ignores parent transforms; keep mesh and rig as scene roots.
world_matrix=mesh.matrix_world.copy();mesh.parent=None;mesh.matrix_world=world_matrix
for track in rig.animation_data.nla_tracks:track.mute=False
# Remove FBX footprint helpers, keep only character hierarchy.
for obj in list(bpy.data.objects):
 if obj!=root and obj!=rig and obj!=mesh:bpy.data.objects.remove(obj,do_unlink=True)
bpy.context.scene.frame_set(1);bpy.context.view_layer.update()
bpy.ops.export_scene.gltf(filepath=output,export_format='GLB',export_extras=True,export_yup=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_frame_step=1,export_optimize_animation_size=True,export_skins=True,export_def_bones=False,export_tangents=True,export_morph=False,export_image_format='AUTO',export_jpeg_quality=90)
# Keep the complete upstream MIT notice embedded even in encoded game-asset packs.
with open(output,'rb') as handle: glb=handle.read()
json_length=struct.unpack_from('<I',glb,12)[0]
document=json.loads(glb[20:20+json_length])
with open(os.path.join(os.path.dirname(__file__),'LICENSE.md')) as handle: notice=handle.read()
document['asset']['copyright']=notice
encoded=json.dumps(document,separators=(',',':')).encode('utf8')
encoded+=b' '*((-len(encoded))%4)
remaining=glb[20+json_length:]
with open(output,'wb') as handle:
 handle.write(struct.pack('<4sII',b'glTF',2,20+len(encoded)+len(remaining)))
 handle.write(struct.pack('<II',len(encoded),0x4e4f534a));handle.write(encoded);handle.write(remaining)
print('CROWD_INFO',json.dumps({'character':character,'height':root['heightM'],'clips':clip_info,'output':output,'bytes':os.path.getsize(output)}))
