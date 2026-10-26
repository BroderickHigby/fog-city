import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { LandmarkFallbacks } from "../../src/render/landmark-fallback.ts";
import { LandmarkLayer } from "../../src/render/landmark-layer.ts";
import { ModelRegistry } from "../../src/render/model-registry.ts";
import { setRenderRetirementOwner } from "../../src/render/renderer-warmup.ts";
import type { LandmarkWorldReplacement } from "../../src/io/landmark-world.ts";

const rectangle=(x:number,z:number,w:number,d:number):Array<[number,number]>=>[[x-w/2,z-d/2],[x+w/2,z-d/2],[x+w/2,z+d/2],[x-w/2,z+d/2]];
const replacement:LandmarkWorldReplacement={id:"test",version:1,
  sources:[{id:"old-solid",footprint:rectangle(0,0,20,20),baseY:0,topY:20}],
  colliders:[
    {id:"new-column",footprint:rectangle(5,0,2,2),baseY:0,topY:10},
    {id:"new-roof",footprint:rectangle(0,0,20,20),baseY:0,underY:10,topY:12},
  ],
};
const doc={landmarks:[{id:"test",model:"models/test.glb",lat:37.7955,lon:-122.3937,headingDeg:0,replacesBuildingIds:["old-solid"]}]};

describe("matching landmark fallback",()=>{
  it("is one visible mesh with an open underpass, and survives a rejected model load",async()=>{
    const hide=vi.fn(),fallback=new LandmarkFallbacks([replacement],hide);
    expect(hide).toHaveBeenCalledWith(["old-solid","new-column","new-roof"]);
    const mesh=fallback.group.children[0] as THREE.Mesh;
    expect(fallback.group.children).toHaveLength(1);expect(mesh.visible).toBe(true);
    mesh.updateMatrixWorld(true);
    expect(new THREE.Raycaster(new THREE.Vector3(0,2,0),new THREE.Vector3(0,0,1),0,9).intersectObject(mesh)).toHaveLength(0);
    const roof=new THREE.Raycaster(new THREE.Vector3(0,2,0),new THREE.Vector3(0,1,0),0,15).intersectObject(mesh)[0];
    expect(roof?.point.y).toBeCloseTo(10);
    const registry=new ModelRegistry<THREE.Object3D>({load:async()=>{throw new Error("asset unavailable");},clone:m=>m.clone(true),fallback:()=>new THREE.Group()},{});
    const layer=new LandmarkLayer(doc,registry,()=>0,hide,root=>fallback.retire(root.name.slice("landmark:".length)));
    await registry.get("landmark:test");await Promise.resolve();
    expect(layer.missingIds).toContain("test");expect(layer.count).toBe(0);
    expect(fallback.group.children).toEqual([mesh]);expect(mesh.visible).toBe(true);
    fallback.dispose();
  });

  it("retires and disposes its own resources exactly once when the detailed model arrives",async()=>{
    const fallback=new LandmarkFallbacks([replacement],()=>{}),mesh=fallback.group.children[0] as THREE.Mesh;
    const geometryDispose=vi.spyOn(mesh.geometry,"dispose"),materialDispose=vi.spyOn(mesh.material as THREE.Material,"dispose");
    let finish!:(object:THREE.Object3D)=>void;
    const registry=new ModelRegistry<THREE.Object3D>({load:()=>new Promise(resolve=>{finish=resolve;}),clone:m=>m.clone(true),fallback:()=>new THREE.Group()},{});
    const layer=new LandmarkLayer(doc,registry,()=>0,()=>{},root=>fallback.retire(root.name.slice("landmark:".length)));
    expect(fallback.group.children).toHaveLength(1);
    finish(new THREE.Group());await registry.get("landmark:test");await Promise.resolve();
    expect(layer.count).toBe(1);expect(fallback.group.children).toHaveLength(0);
    expect(geometryDispose).toHaveBeenCalledTimes(1);expect(materialDispose).toHaveBeenCalledTimes(1);
    fallback.retire("test");fallback.dispose();
    expect(geometryDispose).toHaveBeenCalledTimes(1);expect(materialDispose).toHaveBeenCalledTimes(1);
  });

  it("detaches immediately but waits for an active GPU borrower before disposing",async()=>{
    const fallback=new LandmarkFallbacks([replacement],()=>{}),mesh=fallback.group.children[0] as THREE.Mesh;
    const geometryDispose=vi.spyOn(mesh.geometry,"dispose"),materialDispose=vi.spyOn(mesh.material as THREE.Material,"dispose");
    let release!:()=>void;
    setRenderRetirementOwner(mesh,{retire:()=>new Promise<void>(resolve=>{release=resolve;})});
    fallback.dispose();
    expect(fallback.group.children).toHaveLength(0);expect(geometryDispose).not.toHaveBeenCalled();expect(materialDispose).not.toHaveBeenCalled();
    release();await Promise.resolve();await Promise.resolve();
    expect(geometryDispose).toHaveBeenCalledTimes(1);expect(materialDispose).toHaveBeenCalledTimes(1);
  });
});
