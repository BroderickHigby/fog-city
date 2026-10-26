import { readFileSync } from "node:fs";
import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Actors } from "../../src/render/actors.ts";
import { GpuEngine } from "../../src/render/gpu-engine.ts";
import { NightLights } from "../../src/render/lights.ts";
import { ModelRegistry } from "../../src/render/model-registry.ts";
import { PLAYER_BODY_FILE, PlayerBodies } from "../../src/render/player-body.ts";
import { RendererWarmup } from "../../src/render/renderer-warmup.ts";
import { SceneRenderer } from "../../src/render/scene.ts";

function deferred<T>() { let resolve!: (value:T)=>void; const promise=new Promise<T>(done=>{resolve=done;}); return {promise,resolve}; }
const pose={x:0,y:0,z:0,heading:0,pitch:0,roll:0,steer:0,speed:0};
const bodyBytes=new Uint8Array(readFileSync(new URL(`../../public/${PLAYER_BODY_FILE}`,import.meta.url)));

// Exercise the production scene admission/removal methods without constructing a canvas/GPU.
function harness() {
  const compile=deferred<void>(),started=deferred<void>();
  const queue=new RendererWarmup(async()=>{started.resolve();await compile.promise;},{yieldTask:async()=>{}});
  const gpu={backend:"webgl-node",admit:(root:THREE.Object3D)=>queue.admit(root),retire:(root:THREE.Object3D)=>queue.retire(root)};
  type View={watchGpuTree(root:THREE.Object3D):void;unwatchGpuTree(root:THREE.Object3D):Promise<void>|void};
  const view=Object.assign(Object.create(SceneRenderer.prototype),{gpu,watched:new Set<THREE.Object3D>(),disposed:false,gpuGround:()=>0}) as View;
  Object.assign(view,{gpuChildAdded:(event:{child:THREE.Object3D})=>view.watchGpuTree(event.child),gpuChildRemoved:(event:{child:THREE.Object3D})=>view.unwatchGpuTree(event.child)});
  return {queue,view,compile,started};
}
beforeEach(()=>{
  vi.stubGlobal("self",globalThis);
  vi.spyOn(THREE.TextureLoader.prototype,"load").mockImplementation((_url,loaded)=>{
    const texture=new THREE.Texture<HTMLImageElement>();queueMicrotask(()=>loaded?.(texture));return texture;
  });
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});

describe("runtime owners retire before releasing active shader inputs",()=>{
  it("holds an actual removed avatar and its prototype through an active compile, once",async()=>{
    const bodies=await PlayerBodies.load(async path=>{if(path===PLAYER_BODY_FILE)return bodyBytes;throw new Error("optional clips absent");},false);
    const h=harness();let running:Promise<void>|undefined;
    try {
      bodies.begin();bodies.add("p",0,0,0,0,0,0,new THREE.Color("red"));bodies.end();
      const root=bodies.rootOf("p")!;let skin!:THREE.SkinnedMesh;
      root.traverse(object=>{if(!skin&&(object as THREE.SkinnedMesh).isSkinnedMesh)skin=object as THREE.SkinnedMesh;});
      h.view.watchGpuTree(bodies.group);running=h.queue.pump();await h.started.promise;
      const objectDispose=vi.spyOn(skin,"dispose"),skeletonDispose=vi.spyOn(skin.skeleton,"dispose"),geometryDispose=vi.spyOn(skin.geometry,"dispose");
      bodies.remove(new Set());bodies.remove(new Set());bodies.dispose();bodies.dispose();
      expect(root.parent).toBeNull();expect(bodies.rootOf("p")).toBeNull();expect(h.queue.info().admitted).toBe(0);
      expect(objectDispose).not.toHaveBeenCalled();expect(skeletonDispose).not.toHaveBeenCalled();expect(geometryDispose).not.toHaveBeenCalled();
      h.compile.resolve();await running;await Promise.resolve();await Promise.resolve();
      expect(objectDispose).toHaveBeenCalledOnce();expect(skeletonDispose).toHaveBeenCalledOnce();expect(geometryDispose).toHaveBeenCalledOnce();
    } finally {h.compile.resolve();await running;bodies.dispose();h.queue.dispose();}
  });

  it("lets a loaded car replace an actively compiling fallback without destroying the old inputs",async()=>{
    const load=deferred<THREE.Object3D>(),registry=new ModelRegistry<THREE.Object3D>({load:()=>load.promise,fallback:()=>new THREE.Group(),clone:model=>model.clone()});
    const actors=new Actors(registry,new NightLights()),h=harness();let running:Promise<void>|undefined;
    try {
      actors.setCar("p",pose);const oldCar=actors.group.children.at(-1)!;
      const geometries=new Set<THREE.BufferGeometry>();oldCar.traverse(object=>{if((object as THREE.Mesh).isMesh)geometries.add((object as THREE.Mesh).geometry);});
      expect(geometries.size).toBeGreaterThan(0);const disposals=[...geometries].map(geometry=>vi.spyOn(geometry,"dispose"));
      h.view.watchGpuTree(actors.group);running=h.queue.pump();await h.started.promise;
      const file=new THREE.Group();file.add(new THREE.Mesh(new THREE.BoxGeometry(2,1,4),new THREE.MeshStandardMaterial({name:"paint"})));
      load.resolve(file);await vi.waitFor(()=>expect(actors.carSources().p).toBe("file"));
      expect(oldCar.parent).toBeNull();for(const dispose of disposals)expect(dispose).not.toHaveBeenCalled();
      // The replacement does not own the active fallback's compile and must retire immediately.
      actors.remove(new Set());expect(actors.carSources()).toEqual({});
      h.compile.resolve();await running;await Promise.resolve();
      for(const dispose of disposals)expect(dispose).toHaveBeenCalledOnce();
      file.traverse(object=>{const mesh=object as THREE.Mesh;if(mesh.isMesh){mesh.geometry.dispose();(mesh.material as THREE.Material).dispose();}});
    } finally {h.compile.resolve();await running;actors.dispose();h.queue.dispose();}
  });

  it("holds whole-view shutdown for a compile whose dynamic root was already detached",async()=>{
    const h=harness(),root=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());
    h.queue.admit(root);const running=h.queue.pump();await h.started.promise;h.queue.retire(root);
    const gpu=Object.assign(Object.create(GpuEngine.prototype),{warmupQueue:h.queue}) as GpuEngine;
    const barrier=gpu.retireAll();let finished=false;void barrier?.then(()=>{finished=true;});
    expect(barrier).toBeDefined();await Promise.resolve();expect(finished).toBe(false);
    h.compile.resolve();await barrier;await running;expect(finished).toBe(true);expect(h.queue.info()).toMatchObject({admitted:0,pending:0,active:false});
    root.geometry.dispose();(root.material as THREE.Material).dispose();
  });

  it("holds a loaded car's owned paint while preserving shared prototype geometry and material",async()=>{
    const file=new THREE.Group(),geometry=new THREE.BoxGeometry(2,1,4),source=new THREE.MeshStandardMaterial({name:"paint"});file.add(new THREE.Mesh(geometry,source));
    const registry=new ModelRegistry<THREE.Object3D>({load:async()=>file,fallback:()=>new THREE.Group(),clone:model=>model.clone()});await registry.get("player-car");
    const actors=new Actors(registry,new NightLights()),h=harness();let running:Promise<void>|undefined;
    try {
      actors.setCar("p",pose);const car=actors.group.children.at(-1)!,mesh=car.children[0] as THREE.Mesh;
      const paintDispose=vi.spyOn(mesh.material as THREE.Material,"dispose"),objectDispose=vi.spyOn(mesh,"dispose"),geometryDispose=vi.spyOn(geometry,"dispose"),sourceDispose=vi.spyOn(source,"dispose");
      h.view.watchGpuTree(actors.group);running=h.queue.pump();await h.started.promise;
      actors.remove(new Set());actors.remove(new Set());
      expect(car.parent).toBeNull();expect(paintDispose).not.toHaveBeenCalled();expect(objectDispose).not.toHaveBeenCalled();
      h.compile.resolve();await running;await Promise.resolve();
      expect(paintDispose).toHaveBeenCalledOnce();expect(objectDispose).toHaveBeenCalledOnce();expect(geometryDispose).not.toHaveBeenCalled();expect(sourceDispose).not.toHaveBeenCalled();
    } finally {h.compile.resolve();await running;actors.dispose();h.queue.dispose();geometry.dispose();source.dispose();}
  });
});
