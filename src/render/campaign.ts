import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { Assets } from '../io/assets.ts';
import type { SimState } from '../sim/contract.ts';
import { campaignOf, placePosition, stepOf } from '../sim/missions/runtime.ts';
import { combatOf } from '../sim/combat/system.ts';
export class CampaignLayer {
  readonly group=new THREE.Group();private actors=new Map<string,THREE.Group>();private prototypes=new Map<string,Promise<THREE.Object3D>>();
  private marker=new THREE.Group();private ring:THREE.Mesh;private particleGeo=new THREE.BufferGeometry();private particles:THREE.Points;private points=new Float32Array(1024*3);
  private assets:Assets;private ground:(x:number,z:number)=>number;
  constructor(assets:Assets,privateGround:(x:number,z:number)=>number){this.assets=assets;this.ground=privateGround;
    const material=new THREE.MeshBasicMaterial({color:0x76ead0,transparent:true,opacity:.8,depthWrite:false});
    this.ring=new THREE.Mesh(new THREE.TorusGeometry(2.7,.09,6,40),material);this.ring.rotation.x=Math.PI/2;this.marker.add(this.ring);
    const arrow=new THREE.Mesh(new THREE.ConeGeometry(.7,1.2,4),material);arrow.rotation.z=Math.PI;arrow.position.y=4;this.marker.add(arrow);this.group.add(this.marker);
    this.particleGeo.setAttribute('position',new THREE.BufferAttribute(this.points,3));this.particleGeo.setDrawRange(0,0);this.particles=new THREE.Points(this.particleGeo,new THREE.PointsMaterial({color:0x9ee8ff,size:.16,transparent:true,opacity:.85}));this.particles.frustumCulled=false;this.group.add(this.particles);this.group.name='campaign';
  }
  private load(model:string):Promise<THREE.Object3D>{
    let promise=this.prototypes.get(model);if(promise)return promise;
    const file=model==='robotaxi'?'robotaxi':model==='trundle'?'sidewalk-bot':'errand-robot';
    promise=this.assets.bytes(`models/${file}.glb`).then(b=>new GLTFLoader().parseAsync(b.slice().buffer as ArrayBuffer,'')).then(g=>g.scene);this.prototypes.set(model,promise);return promise;
  }
  update(state:SimState,playerId:string):void{
    const c=campaignOf(state),run=c?.players[playerId],step=run?stepOf(run):undefined,combat=combatOf(state);const live=new Set<string>();
    for(const a of Object.values(c?.actors??{})){
      live.add(a.id);let root=this.actors.get(a.id);
      if(!root){root=new THREE.Group();root.name=`mission-actor:${a.id}`;this.actors.set(a.id,root);this.group.add(root);const captured=root;
        void this.load(a.model??'footman').then(prototype=>{const model=prototype.clone(true);model.traverse(o=>{const mesh=o as THREE.Mesh;if(mesh.isMesh){mesh.castShadow=true;mesh.receiveShadow=true;mesh.material=Array.isArray(mesh.material)?mesh.material.map(m=>m.clone()):mesh.material.clone();}});captured.add(model);}).catch(e=>console.warn('Mission model unavailable',e));
      }
      const target=combat?.targets[a.id];root.position.set(a.x,a.y,a.z);root.rotation.y=-a.heading;root.scale.set(1,target?.heightScale??1,1);root.visible=target?.phase!=='cleared';
      if(target)root.traverse(o=>{const m=o as THREE.Mesh;if(!m.isMesh)return;for(const material of Array.isArray(m.material)?m.material:[m.material]){const p=material as THREE.MeshStandardMaterial;if(!p.color)continue;p.userData.base??=p.color.clone();p.color.copy(p.userData.base as THREE.Color).lerp(new THREE.Color(0x92451f),target.rust*.85);}});
    }
    for(const [id,root]of this.actors)if(!live.has(id)){root.traverse(o=>{const m=o as THREE.Mesh;if(m.isMesh)for(const mat of Array.isArray(m.material)?m.material:[m.material])mat.dispose();});root.removeFromParent();this.actors.delete(id);}
    let destination:{x:number;y:number;z:number}|undefined;
    if(step?.type==='goto'){const p=placePosition(step.target);destination={...p,y:this.ground(p.x,p.z)};}
    if(step?.type==='trigger'){const p=placePosition(step.event.place);destination={...p,y:this.ground(p.x,p.z)};}
    if(step?.type==='objective')destination=Object.values(c?.actors??{}).find(a=>a.owner===playerId&&a.binding===step.objective.actor);
    this.marker.visible=!!destination&&run?.status==='active';if(destination){this.marker.position.set(destination.x,destination.y+.12,destination.z);this.marker.rotation.y=state.tick*.012;}
    let n=0;for(const p of combat?.projectiles??[]){if(n===1024)break;this.points[n*3]=p.x;this.points[n*3+1]=p.y;this.points[n*3+2]=p.z;n++;}this.particleGeo.setDrawRange(0,n);this.particleGeo.getAttribute('position').needsUpdate=true;
  }
}
