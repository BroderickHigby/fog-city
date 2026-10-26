// Admission-driven, one-at-a-time pipeline warmup. Based on Slop New York main.js (MIT,
// Mr.doob 2026); assets/imports/slop-new-york/LICENSE.md retains the notice. No extra scene.
import * as THREE from "three";

export interface WarmupStats {admitted:number;cachedLayouts:number;pending:number;active:boolean;compiled:number;cancelled:number;failed:number;lastError:string|null}
interface Entry {key:string;generation:number}
interface Job {mesh:THREE.Mesh;key:string;generation:number;cancelled:boolean}
export interface WarmupOptions {yieldTask?:()=>Promise<void>;onError?:(error:unknown)=>void}

/** A scene lends admitted objects to its active compiler; resource owners retire that loan. */
export interface RenderRetirementOwner { retire(root:THREE.Object3D):Promise<void>|void }
const retirementOwners=new WeakMap<THREE.Object3D,RenderRetirementOwner>();
export function setRenderRetirementOwner(object:THREE.Object3D,owner:RenderRetirementOwner):void {retirementOwners.set(object,owner);}
export function clearRenderRetirementOwner(object:THREE.Object3D,owner:RenderRetirementOwner):void {
  if(retirementOwners.get(object)===owner)retirementOwners.delete(object);
}
/** Detach/cancel first. Only the removed subtree's in-flight borrower delays its release. */
export function retireRenderTree(root:THREE.Object3D,release:()=>void):Promise<void>|void {
  const barrier=retirementOwners.get(root)?.retire(root);
  root.removeFromParent();
  if(barrier)return barrier.then(release,release);
  release();
}

function liveGeometry(mesh:THREE.Mesh):boolean {
  return mesh.visible&&!!mesh.geometry?.getAttribute("position")?.count&&(!(mesh as THREE.InstancedMesh).isInstancedMesh||(mesh as THREE.InstancedMesh).count>0)
    &&!mesh.userData.staticShadowProxy;
}
function signature(mesh:THREE.Mesh,generation:number):string {
  const materials=(Array.isArray(mesh.material)?mesh.material:[mesh.material]).map(m=>`${m.uuid}:${m.version}`).join(",");
  const attributes=Object.entries(mesh.geometry.attributes).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,a])=>`${key}:${a.itemSize}:${a.normalized}:${a.array.constructor.name}:${(a as THREE.BufferAttribute).gpuType??""}:${(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute?"i":"b"}`).join(",");
  const rig=(mesh as THREE.SkinnedMesh).isSkinnedMesh?`s${(mesh as THREE.SkinnedMesh).skeleton.bones.length}`:"m";
  // Instance bindings are per object in Three r186: never assume two wrappers share a pipeline.
  const instance=(mesh as THREE.InstancedMesh).isInstancedMesh?mesh.uuid:"";
  return `${generation}|${materials}|${attributes}|${rig}|${instance}|${Object.keys(mesh.geometry.morphAttributes).join(",")}`;
}
/** Context adapter is synchronous until compileAsync captures the real target/MRT in pinned r186. */
export function compileForTarget(
  renderer:{getRenderTarget:()=>unknown;setRenderTarget:(target:never)=>unknown;getMRT:()=>unknown;setMRT:(target:never)=>unknown;compileAsync:(object:THREE.Object3D,camera:THREE.Camera,scene:THREE.Scene)=>Promise<void>},
  target:{renderTarget:unknown;getMRT:()=>unknown}|null,object:THREE.Object3D,camera:THREE.Camera,scene:THREE.Scene,
):Promise<void> {
  const previousTarget=renderer.getRenderTarget(),previousMRT=renderer.getMRT(),culling=object.frustumCulled;
  try {
    if(target){renderer.setRenderTarget(target.renderTarget as never);renderer.setMRT(target.getMRT() as never);}
    object.frustumCulled=false;
    // The initialized renderer captures renderContext synchronously, before its async node
    // building yields. Restore borrowed state immediately so ordinary frames cannot inherit it.
    return renderer.compileAsync(object,camera,scene);
  }finally{object.frustumCulled=culling;renderer.setMRT(previousMRT as never);renderer.setRenderTarget(previousTarget as never);}
}

export class RendererWarmup {
  private readonly entries=new Map<THREE.Mesh,Entry>();
  private readonly pending=new Map<string,Job>();
  private readonly completed=new Set<string>();
  private active:Job|null=null;
  private running:Promise<void>|null=null;
  private generation=0;
  private compiled=0;
  private cancelled=0;
  private failed=0;
  private lastError:string|null=null;
  private disposed=false;
  private readonly yieldTask:()=>Promise<void>;
  constructor(privateCompile:(mesh:THREE.Mesh)=>Promise<void>,options:WarmupOptions={}){this.compile=privateCompile;this.options=options;this.yieldTask=options.yieldTask??(()=>new Promise(resolve=>setTimeout(resolve,0)));}
  private readonly compile:(mesh:THREE.Mesh)=>Promise<void>;
  private readonly options:WarmupOptions;
  admit(root:THREE.Object3D):void {
    if(this.disposed)return;
    let changed=false;
    root.traverseVisible(object=>{const mesh=object as THREE.Mesh;if(!mesh.isMesh||mesh.userData.staticShadowProxy)return;
      if(!liveGeometry(mesh))return;
      const key=signature(mesh,this.generation),entry=this.entries.get(mesh);
      if(entry?.key===key)return;
      this.entries.set(mesh,{key,generation:this.generation});this.enqueue(mesh,key);changed=true;
    });
    if(changed)this.prune();
  }
  private enqueue(mesh:THREE.Mesh,key:string):void {
    if(this.disposed||this.completed.has(key)||this.pending.has(key)||this.active?.key===key)return;
    this.pending.set(key,{mesh,key,generation:this.generation,cancelled:false});
  }
  retire(root:THREE.Object3D):Promise<void>|void {
    let activeOwned=false;
    root.traverse(object=>{const mesh=object as THREE.Mesh;this.entries.delete(mesh);
      for(const [key,job]of this.pending)if(job.mesh===mesh){this.pending.delete(key);job.cancelled=true;this.cancelled++;}
      if(this.active?.mesh===mesh){activeOwned=true;if(!this.active.cancelled){this.active.cancelled=true;this.cancelled++;}}
    });
    this.prune();
    this.reschedule();
    if(activeOwned)return this.running??Promise.resolve();
  }
  /** A streamed tile must not leave shader-key strings behind for the whole city. */
  private prune():void {
    const live=new Set([...this.entries.values()].map(entry=>entry.key));
    for(const key of this.completed)if(!live.has(key))this.completed.delete(key);
    for(const [key,job]of this.pending)if(!live.has(key)){this.pending.delete(key);job.cancelled=true;this.cancelled++;}
    if(this.active&&!live.has(this.active.key)&&!this.active.cancelled){this.active.cancelled=true;this.cancelled++;}
  }
  private reschedule():void {
    for(const [mesh,entry]of this.entries)if(entry.generation===this.generation&&liveGeometry(mesh))this.enqueue(mesh,entry.key);
  }
  /** A target/shadow format change invalidates layouts, not the owned object lifetimes. */
  invalidate():void {
    this.generation++;this.completed.clear();
    for(const job of this.pending.values()){job.cancelled=true;this.cancelled++;}this.pending.clear();
    if(this.active&&!this.active.cancelled){this.active.cancelled=true;this.cancelled++;}
    for(const [mesh]of this.entries){const key=signature(mesh,this.generation);this.entries.set(mesh,{key,generation:this.generation});if(liveGeometry(mesh))this.enqueue(mesh,key);}
  }
  /** Starts at most one compile. Calling again while active shares the same bounded work. */
  pump():Promise<void> {
    if(this.running)return this.running;
    if(this.disposed)return Promise.resolve();
    const job=this.pending.values().next().value as Job|undefined;if(!job)return Promise.resolve();
    this.pending.delete(job.key);this.active=job;
    this.running=(async()=>{
      try{
        await this.yieldTask();
        const entry=this.entries.get(job.mesh);
        if(job.cancelled||this.disposed||entry?.key!==job.key||!liveGeometry(job.mesh))return;
        await this.compile(job.mesh);
        if(!job.cancelled&&!this.disposed&&this.entries.get(job.mesh)?.key===job.key){this.completed.add(job.key);this.compiled++;}
      }catch(error){if(!job.cancelled&&!this.disposed){this.failed++;this.lastError=error instanceof Error?error.message:String(error);this.completed.add(job.key);this.options.onError?.(error);}}
      finally{this.active=null;this.running=null;this.reschedule();}
    })();
    return this.running;
  }
  /** Boot drains only its admitted snapshot; later async arrivals continue under the frame pump. */
  async drain():Promise<void>{const count=this.pending.size+(this.active?1:0);for(let i=0;i<count;i++){if(this.disposed||(!this.active&&!this.pending.size))break;await this.pump();}}
  info():WarmupStats{return{admitted:this.entries.size,cachedLayouts:this.completed.size,pending:this.pending.size,active:this.active!==null,compiled:this.compiled,cancelled:this.cancelled,failed:this.failed,lastError:this.lastError};}
  dispose():void {
    if(this.disposed)return;this.disposed=true;
    for(const job of this.pending.values()){job.cancelled=true;this.cancelled++;}this.pending.clear();
    if(this.active&&!this.active.cancelled){this.active.cancelled=true;this.cancelled++;}
    this.entries.clear();this.completed.clear();
  }
  async idle():Promise<void>{await this.running;}
}
