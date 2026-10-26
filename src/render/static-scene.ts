// Static world ownership adapted from Slop New York scene-culling.js (MIT, Mr.doob, 2026).
// See assets/imports/slop-new-york/LICENSE.md. Fog's existing tile stream is the cell boundary.
import * as THREE from "three";

export const STATIC_SHADOW_LAYER = 3;
export interface StaticSceneStats { roots:number; frozenObjects:number; proxies:number; triangles:number; sourceAttributeBytes:number; proxyAttributeBytes:number; ownedBufferBytes:number; indexUpdates:number }
interface ProxyRecord {source:THREE.Mesh;geometry:THREE.BufferGeometry;proxy:THREE.Mesh;index:THREE.BufferAttribute|null;indexVersion:number;castShadow:boolean;sourceBytes:number;proxyBytes:number;ownedBytes:number;triangles:number}
interface StaticRecord {root:THREE.Object3D;frozen:number;proxies:ProxyRecord[];flags:Array<{object:THREE.Object3D;local:boolean;world:boolean}>}
interface ProxyMaterialOptions {side:THREE.Side;shadowSide:THREE.Side|null}
export interface StaticSceneOptions {shadowCameras?:readonly THREE.Camera[];material?:(options:ProxyMaterialOptions)=>THREE.Material}

function dynamic(object:THREE.Object3D):boolean {
  const mesh=object as THREE.Mesh;
  return !!((mesh as THREE.SkinnedMesh).isSkinnedMesh||(object as THREE.Bone).isBone||mesh.morphTargetInfluences
    ||object.userData.dynamic||object.userData.animated);
}
/** Fail closed for an unexpected animated tile; dynamic actor hierarchies are never admitted. */
export function freezeStaticRoot(root:THREE.Object3D):number {
  let movable=false;root.traverse(object=>{movable ||= dynamic(object);});if(movable)return 0;
  root.updateWorldMatrix(true,true,true);
  let count=0;root.traverse(object=>{object.matrixAutoUpdate=false;object.matrixWorldAutoUpdate=false;count++;});
  return count;
}
function eligible(mesh:THREE.Mesh):boolean {
  const material=mesh.material as THREE.Material&{positionNode?:unknown;vertexNode?:unknown;castShadowPositionNode?:unknown;castShadowNode?:unknown;alphaTestNode?:unknown;maskNode?:unknown;maskShadowNode?:unknown;depthNode?:unknown;displacementMap?:unknown;alphaMap?:unknown;alphaTest?:number};
  return !!mesh.isMesh&&!!mesh.parent&&!dynamic(mesh)&&!(mesh as THREE.InstancedMesh).isInstancedMesh&&mesh.castShadow&&mesh.visible
    &&mesh.layers.mask===1&&!mesh.userData.staticShadowProxy&&!!mesh.geometry.getAttribute("position")
    &&(mesh.name==="buildings"||/^fc:building/.test(material.name??"")||Array.isArray(mesh.geometry.userData.fcBuildings))
    &&!Array.isArray(mesh.material)&&!material.transparent&&!(material.alphaTest!>0)&&!material.alphaMap&&!material.displacementMap
    &&!material.positionNode&&!material.vertexNode&&!material.castShadowPositionNode&&!material.castShadowNode&&!material.alphaTestNode
    &&!material.maskNode&&!material.maskShadowNode&&!material.depthNode
    &&Object.values(mesh.geometry.morphAttributes).every(attributes=>!attributes?.length)
    &&(material.onBeforeCompile===THREE.Material.prototype.onBeforeCompile||/^fc:building/.test(material.name??""));
}
function attributeBytes(geometry:THREE.BufferGeometry):number {
  return Object.values(geometry.attributes).reduce((sum,a)=>sum+a.count*a.itemSize*a.array.BYTES_PER_ELEMENT,0);
}
/** Owns only admitted tile wrappers/proxy buffers; never copies a world or borrows source GPU attributes. */
export class StaticScene {
  private readonly roots=new Map<THREE.Object3D,StaticRecord>();
  private readonly materials=new Map<string,THREE.Material>();
  private updates=0;
  private disposed=false;
  constructor(privateOptions:StaticSceneOptions={}) {
    this.options=privateOptions;
    for(const camera of privateOptions.shadowCameras??[])camera.layers.enable(STATIC_SHADOW_LAYER);
  }
  private readonly options:StaticSceneOptions;
  admit(root:THREE.Object3D):void {
    if(this.disposed||this.roots.has(root))return;
    const sources:THREE.Mesh[]=[];let movable=false;
    root.traverse(object=>{movable ||= dynamic(object);});if(movable)return;
    root.updateWorldMatrix(true,true,true);
    root.traverseVisible(object=>{const mesh=object as THREE.Mesh;if(mesh.isMesh&&eligible(mesh))sources.push(mesh);});
    const flags:StaticRecord["flags"]=[];root.traverse(object=>flags.push({object,local:object.matrixAutoUpdate,world:object.matrixWorldAutoUpdate}));
    const record:StaticRecord={root,frozen:0,proxies:[],flags};
    if((this.options.shadowCameras?.length??0)>0)for(const source of sources){
      const material=source.material as THREE.Material,key=`${material.side}:${material.shadowSide}`;
      let proxyMaterial=this.materials.get(key);
      if(!proxyMaterial){
        const options={side:material.side,shadowSide:material.shadowSide};
        proxyMaterial=this.options.material?.(options)??new THREE.MeshBasicMaterial({color:0,side:material.side});
        proxyMaterial.name="static-shadow-proxy";proxyMaterial.shadowSide=material.shadowSide;this.materials.set(key,proxyMaterial);
      }
      const geometry=new THREE.BufferGeometry(),position=source.geometry.getAttribute("position"),positions=new Float32Array(position.count*3);
      for(let i=0;i<position.count;i++){positions[i*3]=position.getX(i);positions[i*3+1]=position.getY(i);positions[i*3+2]=position.getZ(i);}
      geometry.setAttribute("position",new THREE.BufferAttribute(positions,3));
      const index=source.geometry.getIndex();if(index)geometry.setIndex(index.clone());
      geometry.setDrawRange(source.geometry.drawRange.start,source.geometry.drawRange.count);geometry.computeBoundingSphere();
      const proxy=new THREE.Mesh(geometry,proxyMaterial);proxy.name=`shadow:${source.name}`;proxy.layers.set(STATIC_SHADOW_LAYER);
      proxy.castShadow=true;proxy.receiveShadow=false;proxy.frustumCulled=true;proxy.userData.staticShadowProxy=true;
      proxy.position.copy(source.position);proxy.quaternion.copy(source.quaternion);proxy.scale.copy(source.scale);proxy.matrix.copy(source.matrix);proxy.matrixAutoUpdate=false;
      source.parent?.add(proxy);source.castShadow=false;
      const count=Math.max(0,Math.min((index?.count??position.count)-source.geometry.drawRange.start,source.geometry.drawRange.count));
      record.proxies.push({source,geometry:source.geometry,proxy,index,indexVersion:index?.version??0,castShadow:true,
        sourceBytes:attributeBytes(source.geometry),proxyBytes:positions.byteLength,ownedBytes:positions.byteLength+(geometry.getIndex()?.array.byteLength??0),triangles:Math.floor(count/3)});
    }
    record.frozen=freezeStaticRoot(root);this.roots.set(root,record);
  }
  /** Landmark hiding edits only indices. Mirror that exact topology, never an old caster silhouette. */
  update():void {
    for(const record of this.roots.values())for(let i=record.proxies.length-1;i>=0;i--){
      const p=record.proxies[i]!,index=p.source.geometry.getIndex();
      if(p.source.geometry!==p.geometry||(index?.count??0)!==(p.index?.count??0)){
        this.release(p);record.proxies.splice(i,1);continue;
      }
      p.proxy.visible=p.source.visible;
      if(index&&(index!==p.index||index.version!==p.indexVersion)){
        const target=p.proxy.geometry.getIndex()!;target.array.set(index.array);target.needsUpdate=true;p.index=index;p.indexVersion=index.version;this.updates++;
      }
      p.proxy.geometry.setDrawRange(p.source.geometry.drawRange.start,p.source.geometry.drawRange.count);
    }
  }
  private release(record:ProxyRecord):void {
    record.source.castShadow=record.castShadow;record.proxy.removeFromParent();record.proxy.dispose();record.proxy.geometry.dispose();
  }
  remove(root:THREE.Object3D):void {const record=this.roots.get(root);if(!record)return;this.roots.delete(root);for(const p of record.proxies)this.release(p);for(const flag of record.flags){flag.object.matrixAutoUpdate=flag.local;flag.object.matrixWorldAutoUpdate=flag.world;}}
  info():StaticSceneStats {
    const stats:StaticSceneStats={roots:this.roots.size,frozenObjects:0,proxies:0,triangles:0,sourceAttributeBytes:0,proxyAttributeBytes:0,ownedBufferBytes:0,indexUpdates:this.updates};
    for(const record of this.roots.values()){
      stats.frozenObjects+=record.frozen;for(const p of record.proxies){stats.proxies++;stats.triangles+=p.triangles;stats.sourceAttributeBytes+=p.sourceBytes;stats.proxyAttributeBytes+=p.proxyBytes;stats.ownedBufferBytes+=p.ownedBytes;}
    }return stats;
  }
  dispose():void {if(this.disposed)return;this.disposed=true;for(const root of [...this.roots.keys()])this.remove(root);for(const material of this.materials.values())material.dispose();this.materials.clear();}
}
