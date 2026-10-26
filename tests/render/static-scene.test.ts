import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";
import { createSharedMaterials } from "../../src/render/materials.ts";
import { createNightMaterials } from "../../src/render/props.ts";
import { TileStreamer } from "../../src/render/tile-streamer.ts";
import { StaticScene, STATIC_SHADOW_LAYER, freezeStaticRoot } from "../../src/render/static-scene.ts";

async function admitted(onUnload?:(group:THREE.Group)=>void|Promise<void>): Promise<{parent:THREE.Group;root:THREE.Object3D;streamer:TileStreamer;readyParent:THREE.Object3D|null}> {
  const parent=new THREE.Group();parent.position.set(19,4,-8);
  const glb=new THREE.Group(),mesh=new THREE.Mesh(new THREE.BoxGeometry(2,3,4),new THREE.MeshStandardMaterial({name:"building"}));
  mesh.name="buildings";mesh.position.set(3,0,2);glb.add(mesh);
  let readyParent:THREE.Object3D|null=null;
  const streamer=new TileStreamer({parent,manifest:{version:1,world:"fixture",spawn:{x:0,z:0,heading:0},tileSizeM:500,tiles:[{id:"one",bbox:[0,0,500,500],collider:"none",glb:"one.glb"}]},
    base:"/fixture/",colliders:new Map(),roads:null,ground:()=>0,materials:createSharedMaterials(),night:createNightMaterials(),radius:100,
    loadGltf:async()=>({scene:glb} as unknown as GLTF),onReady:root=>{readyParent=root.parent;},onUnload});
  for(let i=0;i<30;i++){streamer.update(0,0,50);if(streamer.settled())break;await new Promise(r=>setTimeout(r,0));}
  return{parent,root:parent.getObjectByName("tile:one")!,streamer,readyParent};
}

describe("static tile admission",()=>{
  it("admits under its real parent before lifecycle hooks compute world transforms",async()=>{
    const result=await admitted();try{
      expect(result.readyParent).toBe(result.parent);
      expect(result.root.getObjectByName("buildings")!.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([22,4,-6]);
    }finally{result.streamer.dispose();}
  });
  it("freezes world transforms of admitted static roots and descendants",async()=>{
    const result=await admitted();try{
      const nodes:THREE.Object3D[]=[];result.root.traverse(o=>nodes.push(o));
      expect(nodes.length).toBeGreaterThan(1);
      expect(nodes.every(o=>!o.matrixWorldAutoUpdate)).toBe(true);
    }finally{result.streamer.dispose();}
  });
  it("removes an unloaded tile immediately and defers its owned buffers until shader retirement settles",async()=>{
    let finish!:()=>void;const barrier=new Promise<void>(resolve=>{finish=resolve;});
    const result=await admitted(()=>barrier),geometry=(result.root.getObjectByName("buildings") as THREE.Mesh).geometry;
    const release=vi.fn();geometry.addEventListener("dispose",release);result.streamer.update(10000,10000,50);
    expect(result.root.parent).toBeNull();expect(release).not.toHaveBeenCalled();finish();await barrier;await Promise.resolve();
    expect(release).toHaveBeenCalledTimes(1);result.streamer.dispose();
  });
});

function building():THREE.Mesh {
  const mesh=new THREE.Mesh(new THREE.BoxGeometry(2,3,4),new THREE.MeshStandardMaterial({name:"fc:building"}));
  mesh.name="buildings";mesh.castShadow=true;return mesh;
}
describe("tile-owned static world and opaque shadow proxies",()=>{
  it("keeps world placement while replacing only the cascade caster with position-only owned buffers",()=>{
    const parent=new THREE.Group();parent.position.set(17,3,-9);const root=new THREE.Group();root.position.set(-5,2,8);parent.add(root);
    const source=building();source.position.set(2,4,7);source.rotation.y=.4;source.scale.set(1,2,.8);root.add(source);
    const cameras=[new THREE.PerspectiveCamera(),new THREE.PerspectiveCamera()],main=new THREE.PerspectiveCamera();
    const registry=new StaticScene({shadowCameras:cameras});registry.admit(root);
    const proxy=root.children.find(o=>o.userData.staticShadowProxy) as THREE.Mesh;
    expect(proxy).toBeDefined();expect(source.castShadow).toBe(false);expect(proxy.castShadow).toBe(true);
    expect(Object.keys(proxy.geometry.attributes)).toEqual(["position"]);
    expect(proxy.geometry.getAttribute("position").array).not.toBe(source.geometry.getAttribute("position").array);
    expect(proxy.geometry.getIndex()!.array).not.toBe(source.geometry.getIndex()!.array);
    expect(proxy.matrixWorld.elements).toEqual(source.matrixWorld.elements);
    expect(main.layers.test(proxy.layers)).toBe(false);for(const camera of cameras)expect(camera.layers.isEnabled(STATIC_SHADOW_LAYER)).toBe(true);
    const counters=registry.info();expect(counters.proxies).toBe(1);expect(counters.triangles).toBe(12);
    expect(counters.proxyAttributeBytes).toBe(288);expect(counters.sourceAttributeBytes).toBe(768);expect(counters.ownedBufferBytes).toBe(360);
    let sourceDisposals=0,proxyDisposals=0;source.geometry.addEventListener("dispose",()=>sourceDisposals++);proxy.geometry.addEventListener("dispose",()=>proxyDisposals++);
    registry.remove(root);expect(source.castShadow).toBe(true);expect(sourceDisposals).toBe(0);expect(proxyDisposals).toBe(1);expect(root.children).toEqual([source]);
    expect(registry.info().ownedBufferBytes).toBe(0);expect(source.matrixWorldAutoUpdate).toBe(true);registry.dispose();
  });
  it("synchronizes hidden-building indices and draw range, never leaving an old shadow silhouette",()=>{
    const root=new THREE.Group(),source=building();root.add(source);const registry=new StaticScene({shadowCameras:[new THREE.Camera()]});registry.admit(root);
    const proxy=root.children.find(o=>o.userData.staticShadowProxy) as THREE.Mesh,index=source.geometry.getIndex()!;
    const positions=proxy.geometry.getAttribute("position").array;index.array.fill(index.array[0]!,0,6);index.needsUpdate=true;source.geometry.setDrawRange(6,18);registry.update();
    expect(Array.from(proxy.geometry.getIndex()!.array)).toEqual(Array.from(index.array));expect(proxy.geometry.drawRange).toEqual({start:6,count:18});
    expect(proxy.geometry.getAttribute("position").array).toBe(positions);expect(registry.info().indexUpdates).toBe(1);
    registry.update();expect(registry.info().indexUpdates).toBe(1);source.visible=false;registry.update();expect(proxy.visible).toBe(false);
    registry.dispose();
  });
  it("fails closed for alpha, displacement, animated rigs, node vertex changes and unknown custom shaders",()=>{
    const root=new THREE.Group();
    const alpha=building();(alpha.material as THREE.Material).alphaTest=.4;root.add(alpha);
    const displaced=building();(displaced.material as THREE.MeshStandardMaterial).displacementMap=new THREE.Texture();root.add(displaced);
    const moving=building();(moving.material as THREE.Material&{positionNode:unknown}).positionNode={};root.add(moving);
    const custom=building();(custom.material as THREE.Material).name="unknown";custom.name="buildings";(custom.material as THREE.Material).onBeforeCompile=()=>{};root.add(custom);
    const registry=new StaticScene({shadowCameras:[new THREE.Camera()]});registry.admit(root);expect(registry.info().proxies).toBe(0);
    expect(root.children.every(o=>(o as THREE.Mesh).castShadow)).toBe(true);registry.dispose();
    const animated=new THREE.Group(),skin=new THREE.SkinnedMesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());skin.name="buildings";skin.castShadow=true;animated.add(skin);
    const safe=new StaticScene({shadowCameras:[new THREE.Camera()]});safe.admit(animated);expect(safe.info().roots).toBe(0);expect(skin.matrixWorldAutoUpdate).toBe(true);safe.dispose();
    const detached=building(),standalone=new StaticScene({shadowCameras:[new THREE.Camera()]});standalone.admit(detached);
    expect(detached.castShadow).toBe(true);expect(standalone.info().proxies).toBe(0);standalone.dispose();
  });
  it("removes repeated static world-matrix multiplies without freezing dynamic neighbours",()=>{
    const root=new THREE.Group();for(let i=0;i<20;i++){const child=new THREE.Object3D();child.position.x=i;root.add(child);}
    root.updateMatrixWorld(true);const owned=new Set(root.children.map(o=>o.matrixWorld));let multiplies=0;
    const original=THREE.Matrix4.prototype.multiplyMatrices;const spy=vi.spyOn(THREE.Matrix4.prototype,"multiplyMatrices").mockImplementation(function(this:THREE.Matrix4,a,b){if(owned.has(this))multiplies++;return original.call(this,a,b);});
    try{
      for(let i=0;i<5;i++)root.updateMatrixWorld(true);const before=multiplies;freezeStaticRoot(root);multiplies=0;
      for(let i=0;i<5;i++)root.updateMatrixWorld(true);const after=multiplies;
      expect(before).toBe(100);expect(after).toBe(0);
      const dynamic=new THREE.Group(),child=new THREE.Object3D();dynamic.add(child);dynamic.position.x=3;dynamic.updateMatrixWorld(true);expect(child.matrixWorld.elements[12]).toBe(3);
      console.info("static world work",JSON.stringify({objects:20,frames:5,multipliesBefore:before,multipliesAfter:after}));
    }finally{spy.mockRestore();}
  });
});
