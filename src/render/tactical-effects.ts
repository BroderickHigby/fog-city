/** Read-only, bounded presentation for actual SIM21 devices and explicitly uncertain AI marks. */
import * as THREE from "three";
import {mergeGeometries} from "three/addons/utils/BufferGeometryUtils.js";
import type {SimState} from "../sim/contract.ts";
import type {Gadget} from "../sim/combat-contract.ts";
import {playerPose} from "../sim/ride.ts";
import {agentsRuntimeOf} from "../sim/agents/runtime.ts";
import {retireRenderTree} from "./renderer-warmup.ts";
export const TACTICAL_LIMIT=32,TACTICAL_RANGE=250,CONFIDENCE_LIMIT=24;
export interface TacticalMark {id:string;x:number;y:number;z:number;hallucination:boolean}
export function tacticalProjection(state:Readonly<SimState>,playerId:string):{devices:Gadget[];marks:TacticalMark[]} {
  const player=state.players[playerId],combat=state.ext.combat;if(state.version<24||!player||!combat)return {devices:[],marks:[]};
  const body=playerPose(player),distance=(point:{x:number;z:number})=>(point.x-body.x)**2+(point.z-body.z)**2;
  const devices=combat.gadgets.filter(gadget=>gadget.untilTick>state.tick&&[gadget.x,gadget.y,gadget.z,gadget.radius].every(Number.isFinite)&&distance(gadget)<=TACTICAL_RANGE**2)
    .sort((a,b)=>distance(a)-distance(b)||a.id-b.id).slice(0,TACTICAL_LIMIT);
  const runtime=agentsRuntimeOf(state),marks:TacticalMark[]=[],occupied=new Set(Object.values(state.players).flatMap(player=>player.ride?[player.ride.agentId]:[]));
  for(const mark of combat.players[playerId]?.marks??[]){
    const actor=runtime?.actors[mark.targetId];if(!actor||actor.retired||actor.fidelity==="abstract"||actor.fidelity==="despawn"||actor.protected||actor.child||actor.mobilityAid||actor.model==="robotaxi"&&(occupied.has(actor.numericId)||actor.legacyId!==null&&occupied.has(actor.legacyId))||
      mark.untilTick<=state.tick||(combat.targets[actor.id]?.phase??"active")!=="active"||distance(actor)>150**2)continue;
    marks.push({id:actor.id,x:actor.x,y:actor.y+actor.height+.7,z:actor.z,hallucination:mark.hallucination});
  }
  return {devices,marks:marks.sort((a,b)=>distance(a)-distance(b)||(a.id<b.id?-1:1)).slice(0,CONFIDENCE_LIMIT)};
}
const TITLES:Record<Gadget["kind"],string>={sprinkler:"SPRINKLER",speaker:"DECOY SPEAKER",parrots:"BUZZWORD PARROTS",tensor:"HOLD INTERACT · LOAD BOOST",blimp:"AD BLIMP",hydrants:"OPEN HYDRANT",microclimate:"MICROCLIMATE"};
const COLORS:Record<Gadget["kind"],number>={sprinkler:0x66cbd9,speaker:0x6e8189,parrots:0x98bf58,tensor:0xc5a46b,blimp:0xe7c493,hydrants:0x6dcced,microclimate:0xb5dae0};
function join(parts:THREE.BufferGeometry[]):THREE.BufferGeometry {const geometry=mergeGeometries(parts,false);for(const part of parts)part.dispose();if(!geometry)throw new Error("Device geometry could not be combined");return geometry;}
function geometry(kind:Gadget["kind"]):THREE.BufferGeometry {
  if(kind==="sprinkler")return join([new THREE.CylinderGeometry(.12,.2,.12,8).translate(0,.08,0),new THREE.CylinderGeometry(.035,.035,.4,6).translate(0,.28,0),new THREE.BoxGeometry(.45,.06,.06).translate(0,.48,0)]);
  if(kind==="speaker")return join([new THREE.BoxGeometry(.38,.54,.25).translate(0,.3,0),new THREE.CylinderGeometry(.13,.13,.03,12).rotateX(Math.PI/2).translate(0,.35,-.14),new THREE.BoxGeometry(.28,.08,.3).translate(0,.04,0)]);
  if(kind==="tensor")return join([new THREE.BoxGeometry(.85,.65,.8).translate(0,.35,0),new THREE.BoxGeometry(.92,.06,.86).translate(0,.65,0),new THREE.BoxGeometry(.92,.06,.86).translate(0,.1,0)]);
  if(kind==="blimp")return join([new THREE.SphereGeometry(1,12,6).scale(3,1,1.15).translate(0,14,0),new THREE.BoxGeometry(1,.35,.6).translate(0,12.9,0),new THREE.BoxGeometry(.12,1.2,1.4).translate(2.5,14,0)]);
  if(kind==="parrots"){
    const bird=()=>join([new THREE.SphereGeometry(.13,6,4).scale(1,.9,1.6),new THREE.ConeGeometry(.3,.08,3).rotateZ(Math.PI/2).translate(.21,0,0),new THREE.ConeGeometry(.3,.08,3).rotateZ(-Math.PI/2).translate(-.21,0,0)]);
    return join([bird().translate(-.7,2.8,0),bird().translate(.7,3.2,.3),bird().translate(0,3.7,-.4)]);
  }
  if(kind==="hydrants")return join([new THREE.CylinderGeometry(.06,.13,1.8,7).translate(0,1.5,0),new THREE.SphereGeometry(.16,7,4).translate(0,2.4,0)]);
  return join([new THREE.TorusGeometry(1,.015,3,32).rotateX(Math.PI/2).scale(8,1,8).translate(0,.12,0),new THREE.TorusGeometry(1,.012,3,24).rotateX(Math.PI/2).scale(5,1,5).translate(0,.6,0)]);
}
interface Batch {body:THREE.InstancedMesh;label?:THREE.InstancedMesh}
export class TacticalEffectsLayer {
  readonly root=new THREE.Group();private batches=new Map<Gadget["kind"],Batch>();private confidence:THREE.InstancedMesh[]=[];
  private matrix=new THREE.Matrix4();private position=new THREE.Vector3();private scale=new THREE.Vector3(1,1,1);private facing=new THREE.Quaternion();private identity=new THREE.Quaternion();
  private disposed=false;private counts={devices:0,marks:0};private textures:THREE.Texture[]=[];
  private readonly scene:THREE.Scene;private readonly doc:Document|undefined;
  constructor(scene:THREE.Scene,doc?:Document){this.scene=scene;this.doc=doc;this.root.name="tactical-effects";this.root.visible=false;}
  private mesh(geometry:THREE.BufferGeometry,material:THREE.Material,limit:number,name:string):THREE.InstancedMesh {
    const mesh=new THREE.InstancedMesh(geometry,material,limit);mesh.name=name;mesh.count=0;mesh.frustumCulled=false;mesh.castShadow=false;mesh.receiveShadow=false;mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);this.root.add(mesh);return mesh;
  }
  private label(text:string,color:string,limit:number):THREE.InstancedMesh|undefined {
    if(!this.doc)return undefined;const canvas=this.doc.createElement("canvas");canvas.width=512;canvas.height=64;const context=canvas.getContext("2d");if(!context)return undefined;
    context.fillStyle="#10252ce8";context.fillRect(0,0,512,64);context.font="bold 25px monospace";context.fillStyle=color;context.textAlign="center";context.textBaseline="middle";context.fillText(text,256,33,496);
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;this.textures.push(texture);
    return this.mesh(new THREE.PlaneGeometry(3.6,.45),new THREE.MeshBasicMaterial({map:texture,transparent:true,depthTest:true,depthWrite:false,toneMapped:false}),limit,text);
  }
  private batch(kind:Gadget["kind"]):Batch {
    let hit=this.batches.get(kind);if(!hit){hit={body:this.mesh(geometry(kind),new THREE.MeshStandardMaterial({color:COLORS[kind],roughness:.65,metalness:kind==="tensor"?0:.25,transparent:kind==="microclimate",opacity:kind==="microclimate"?.6:1}),TACTICAL_LIMIT,`device-${kind}`),label:this.label(TITLES[kind],"#e4f1db",TACTICAL_LIMIT)};this.batches.set(kind,hit);}return hit;
  }
  update(state:Readonly<SimState>,playerId:string,camera:THREE.Camera):void {
    if(this.disposed)return;const projection=tacticalProjection(state,playerId);this.counts={devices:projection.devices.length,marks:projection.marks.length};this.root.visible=!!(this.counts.devices||this.counts.marks);
    for(const batch of this.batches.values()){batch.body.count=0;if(batch.label)batch.label.count=0;}for(const mesh of this.confidence)mesh.count=0;
    if(!this.root.visible)return;if(!this.root.parent)this.scene.add(this.root);camera.getWorldQuaternion(this.facing);
    for(const device of projection.devices){const batch=this.batch(device.kind),index=batch.body.count++;
      this.position.set(device.x,device.y,device.z);this.scale.setScalar(device.kind==="microclimate"?device.radius/8:1);this.matrix.compose(this.position,this.identity,this.scale);batch.body.setMatrixAt(index,this.matrix);
      if(batch.label){this.position.y+=device.kind==="blimp"?16:device.kind==="parrots"?4.4:device.kind==="hydrants"?2.8:1.15;this.matrix.compose(this.position,this.facing,this.scale);batch.label.setMatrixAt(batch.label.count++,this.matrix);}
    }
    if(projection.marks.length&&!this.confidence.length){const uncertain=this.label("98% · AI ESTIMATE","#9fe9e9",CONFIDENCE_LIMIT),hallucination=this.label("98% · HALLUCINATION","#edc4ff",CONFIDENCE_LIMIT);if(uncertain&&hallucination)this.confidence=[uncertain,hallucination];}
    for(const mark of projection.marks){const mesh=this.confidence[mark.hallucination?1:0];if(!mesh)continue;this.position.set(mark.x,mark.y,mark.z);this.scale.set(1,1,1);this.matrix.compose(this.position,this.facing,this.scale);mesh.setMatrixAt(mesh.count++,this.matrix);}
    for(const batch of this.batches.values()){batch.body.instanceMatrix.needsUpdate=true;if(batch.label)batch.label.instanceMatrix.needsUpdate=true;}for(const mesh of this.confidence)mesh.instanceMatrix.needsUpdate=true;
  }
  info(){return {...this.counts,drawCalls:this.root.visible?this.root.children.filter(child=>(child as THREE.InstancedMesh).count>0).length:0,textures:this.textures.length};}
  dispose(){if(this.disposed)return;this.disposed=true;this.root.visible=false;void retireRenderTree(this.root,()=>{for(const child of this.root.children){const mesh=child as THREE.InstancedMesh;mesh.dispose();mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}for(const texture of this.textures)texture.dispose();this.root.clear();this.batches.clear();this.confidence=[];this.textures=[];});}
}
