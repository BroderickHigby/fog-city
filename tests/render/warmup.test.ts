import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { GpuEngine, createGpuScenePass } from "../../src/render/gpu-engine.ts";
import { RendererWarmup, compileForTarget } from "../../src/render/renderer-warmup.ts";

describe("admitted GPU shader warmup",()=>{
  it("compiles for the actual scene-pass target and MRT while restoring live renderer state",async()=>{
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(),mesh=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());scene.add(mesh);
    const scenePass=createGpuScenePass(scene,camera,"webgl-node"),mrt={name:"real-scene-mrt"};scenePass.setMRT(mrt as never);
    const oldTarget=new THREE.RenderTarget(),oldMrt={name:"outer-mrt"};let target:unknown=oldTarget,currentMrt:unknown=oldMrt;
    const during:Array<{target:unknown;mrt:unknown}>=[];
    const renderer={getRenderTarget:()=>target,setRenderTarget:(value:unknown)=>{target=value;},getMRT:()=>currentMrt,setMRT:(value:unknown)=>{currentMrt=value;},compileAsync:async()=>{during.push({target,mrt:currentMrt});}};
    await GpuEngine.prototype.prewarm.call(Object.assign(Object.create(GpuEngine.prototype),{renderer,scenePass,scene,camera,postEnabled:true,pipeline:{render:()=>{}}}) as GpuEngine,scene,camera);
    expect(during.length).toBeGreaterThan(0);expect(during.every(x=>x.target===scenePass.renderTarget&&x.mrt===mrt)).toBe(true);
    expect(target).toBe(oldTarget);expect(currentMrt).toBe(oldMrt);
    scenePass.dispose();oldTarget.dispose();mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();
  });

  it("finishes boot compilation before resolving, then releases its queue and ignores runtime admissions",async()=>{
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(),initial=mesh();scene.add(initial);
    let finish!:()=>void;
    const compile=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const engine=bootEngine(compile);
    let ready=false;
    const boot=engine.prewarm(scene,camera).then(()=>{ready=true;});
    await vi.waitFor(()=>expect(compile).toHaveBeenCalledTimes(1));
    expect(ready).toBe(false);
    finish();await boot;
    expect(ready).toBe(true);
    expect(engine.warmupInfo).toMatchObject({admitted:0,cachedLayouts:0,pending:0,active:false,compiled:1});
    const late=mesh();engine.admit(late);scene.add(late);
    await engine.prewarm(scene,camera);
    expect(compile).toHaveBeenCalledTimes(1);
    expect(engine.warmupInfo).toMatchObject({admitted:0,pending:0,active:false,compiled:1});
  });

  it("cancels asset arrivals outside the boot snapshot without retaining their objects",async()=>{
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(),initial=mesh();scene.add(initial);
    let finish!:()=>void;
    const compile=vi.fn(()=>new Promise<void>(resolve=>{finish=resolve;}));
    const engine=bootEngine(compile),boot=engine.prewarm(scene,camera);
    await vi.waitFor(()=>expect(compile).toHaveBeenCalledTimes(1));
    engine.admit(mesh());expect(engine.warmupInfo.pending).toBe(1);
    finish();await boot;
    expect(compile).toHaveBeenCalledTimes(1);
    expect(engine.warmupInfo).toMatchObject({admitted:0,cachedLayouts:0,pending:0,active:false,compiled:1,cancelled:1});
  });

  it("closes boot work and propagates a failed shader instead of leaving a live retry queue",async()=>{
    const error=vi.spyOn(console,"error").mockImplementation(()=>{});
    try {
      const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();scene.add(mesh());
      const compile=vi.fn(async()=>{throw new Error("boot shader failed");}),engine=bootEngine(compile);
      await expect(engine.prewarm(scene,camera)).rejects.toThrow("boot shader failed");
      expect(engine.warmupInfo).toMatchObject({admitted:0,pending:0,active:false,failed:1});
      engine.admit(mesh());expect(engine.warmupInfo.admitted).toBe(0);
      expect(compile).toHaveBeenCalledTimes(1);
    } finally {error.mockRestore();}
  });
});

const mesh=(material=new THREE.MeshBasicMaterial()):THREE.Mesh=>new THREE.Mesh(new THREE.BoxGeometry(),material);
function bootEngine(compileAsync:()=>Promise<void>):GpuEngine {
  return Object.assign(Object.create(GpuEngine.prototype),{
    renderer:{getRenderTarget:()=>null,setRenderTarget:()=>{},getMRT:()=>null,setMRT:()=>{},compileAsync},
    warmupQueue:null,warmupClosed:false,scene:null,camera:null,postEnabled:false,pipeline:null,
    disposed:false,failureMessage:null,error:null,loggedErrors:new Set<string>(),
  }) as GpuEngine;
}
describe("bounded admitted pipeline work",()=>{
  it("deduplicates compatible ordinary layouts and skips zero instance placeholders until admitted",async()=>{
    const root=new THREE.Group(),material=new THREE.MeshBasicMaterial(),a=mesh(material),b=mesh(material);root.add(a,b);
    const compile=vi.fn(async()=>{}),queue=new RendererWarmup(compile,{yieldTask:async()=>{}});queue.admit(root);
    expect(queue.info()).toMatchObject({admitted:2,pending:1});await queue.drain();expect(compile).toHaveBeenCalledTimes(1);
    const instanced=new THREE.InstancedMesh(new THREE.BoxGeometry(),material,4);instanced.count=0;root.add(instanced);queue.admit(instanced);expect(queue.info().pending).toBe(0);
    instanced.count=2;queue.admit(instanced);await queue.drain();expect(compile).toHaveBeenCalledTimes(2);
    queue.admit(root);expect(queue.info().pending).toBe(0);queue.dispose();
    console.info("warmup representative work",JSON.stringify({validMeshes:3,compiledRepresentatives:2,zeroPlaceholderCompiles:0}));
  });
  it("cancels a retired active owner and keeps its disposal barrier until existing compile work finishes",async()=>{
    const root=new THREE.Group(),a=mesh();root.add(a);let finish!:()=>void,started=false;
    const compile=()=>{started=true;return new Promise<void>(resolve=>{finish=resolve;});},errors:unknown[]=[];
    const queue=new RendererWarmup(compile,{yieldTask:async()=>{},onError:e=>errors.push(e)});queue.admit(root);const running=queue.pump();
    await vi.waitFor(()=>expect(started).toBe(true));let released=false;const retirement=queue.retire(root);expect(retirement).toBeDefined();
    void retirement!.then(()=>{released=true;});expect(released).toBe(false);finish();await retirement;await running;
    expect(released).toBe(true);expect(queue.info()).toMatchObject({admitted:0,pending:0,active:false,compiled:0,cancelled:1});expect(errors).toEqual([]);queue.dispose();
  });
  it("substitutes another live representative when a queued owner leaves",async()=>{
    const root=new THREE.Group(),material=new THREE.MeshBasicMaterial(),a=mesh(material),b=mesh(material);root.add(a,b);
    const compile=vi.fn(async()=>{}),queue=new RendererWarmup(compile,{yieldTask:async()=>{}});queue.admit(root);queue.retire(a);await queue.drain();
    expect(compile).toHaveBeenCalledExactlyOnceWith(b);expect(queue.info()).toMatchObject({admitted:1,compiled:1,cancelled:1});queue.dispose();
  });
  it("keeps completed layouts only while at least one admitted owner remains",async()=>{
    const root=new THREE.Group(),material=new THREE.MeshBasicMaterial(),a=mesh(material),b=mesh(material);root.add(a,b);
    const queue=new RendererWarmup(async()=>{},{yieldTask:async()=>{}});queue.admit(root);await queue.drain();
    expect(queue.info().cachedLayouts).toBe(1);queue.retire(a);expect(queue.info().cachedLayouts).toBe(1);
    material.needsUpdate=true;queue.admit(b);expect(queue.info().cachedLayouts).toBe(0);await queue.drain();
    expect(queue.info()).toMatchObject({cachedLayouts:1,compiled:2});queue.retire(b);
    expect(queue.info()).toMatchObject({admitted:0,cachedLayouts:0,pending:0});queue.dispose();
  });
  it("never overlaps compilers and recompiles a changed context instead of accepting stale completion",async()=>{
    const root=new THREE.Group(),a=mesh();root.add(a);let finish!:()=>void,active=0,maxActive=0,count=0;
    const queue=new RendererWarmup(async()=>{count++;active++;maxActive=Math.max(maxActive,active);if(count===1)await new Promise<void>(r=>{finish=r;});active--;},{yieldTask:async()=>{}});
    queue.admit(root);const first=queue.pump();expect(queue.pump()).toBe(first);await vi.waitFor(()=>expect(count).toBe(1));queue.invalidate();finish();await first;
    expect(queue.info().compiled).toBe(0);await queue.drain();expect(count).toBe(2);expect(maxActive).toBe(1);expect(queue.info().compiled).toBe(1);queue.dispose();
  });
  it("retains the boot target/MRT throughout async compilation and restores it on success or failure",async()=>{
    const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(),a=mesh();scene.add(a);let target:unknown="old",mrt:unknown="old-mrt",finish!:()=>void;
    const during:unknown[]=[];const renderer={getRenderTarget:()=>target,setRenderTarget:(x:unknown)=>{target=x;},getMRT:()=>mrt,setMRT:(x:unknown)=>{mrt=x;},compileAsync:()=>{during.push([target,mrt]);return new Promise<void>(r=>{finish=r;});}};
    const pending=compileForTarget(renderer,{renderTarget:"actual",getMRT:()=>"actual-mrt"},a,camera,scene);
    expect(during).toEqual([["actual","actual-mrt"]]);expect([target,mrt]).toEqual(["actual","actual-mrt"]);
    expect(a.frustumCulled).toBe(false);finish();await pending;
    expect([target,mrt]).toEqual(["old","old-mrt"]);expect(a.frustumCulled).toBe(true);
    await expect(compileForTarget({...renderer,compileAsync:()=>{throw new Error("compile failure");}},{renderTarget:"actual",getMRT:()=>"actual-mrt"},a,camera,scene)).rejects.toThrow("compile failure");
    expect([target,mrt]).toEqual(["old","old-mrt"]);
    await expect(compileForTarget({...renderer,compileAsync:async()=>{throw new Error("async compile failure");}},{renderTarget:"actual",getMRT:()=>"actual-mrt"},a,camera,scene)).rejects.toThrow("async compile failure");
    expect([target,mrt]).toEqual(["old","old-mrt"]);
  });
});
