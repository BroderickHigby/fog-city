import { readFileSync } from "node:fs";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Actors, disposeTree, makeBoxCar, type CarPose } from "../../src/render/actors.ts";
import { rollWheel } from "../../src/render/agent-lod.ts";
import { NightLights } from "../../src/render/lights.ts";
import { ModelRegistry } from "../../src/render/model-registry.ts";
import { CAR } from "../../src/sim/car.ts";

const disposables: Array<{dispose():void}> = [];
afterEach(() => { for (const value of disposables.splice(0).reverse()) value.dispose(); });
const pose: CarPose = { x:0,y:0,z:0,heading:0,pitch:0,roll:0,steer:0,speed:0 };

async function model(): Promise<THREE.Object3D> {
  const bytes = readFileSync(new URL("../../public/models/civilian-car.glb", import.meta.url));
  const data = bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer;
  const root = await new Promise<THREE.Object3D>((resolve,reject) => new GLTFLoader().parse(data,"",g=>resolve(g.scene),reject));
  disposables.push({dispose:()=>disposeTree(root)});
  return root;
}
function registry(load:()=>Promise<THREE.Object3D>, available:ReadonlySet<string>|null=null): ModelRegistry<THREE.Object3D> {
  return new ModelRegistry({load,fallback:()=>new THREE.Group(),clone:root=>root.clone(true),available});
}
function actors(reg:ModelRegistry<THREE.Object3D>): Actors {
  const result = new Actors(reg,new NightLights());
  disposables.push(result);
  return result;
}
function addedCar(view:Actors,id:string,at:CarPose=pose):THREE.Object3D {
  const before = new Set(view.group.children);
  view.setCar(id,at);
  const car = view.group.children.find(child=>!before.has(child));
  expect(car).toBeDefined();
  return car!;
}
/** Actual vertices in the car's physical frame: retain fitted scale, remove only its world pose. */
function physicalBounds(car:THREE.Object3D):THREE.Box3 {
  car.updateWorldMatrix(true,true);
  const inversePose = new THREE.Matrix4().compose(car.position,car.quaternion,new THREE.Vector3(1,1,1)).invert();
  const bounds = new THREE.Box3(),point = new THREE.Vector3();
  car.traverse(node=>{
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    for(let i=0;i<mesh.geometry.getAttribute("position").count;i++) {
      mesh.getVertexPosition(i,point).applyMatrix4(mesh.matrixWorld).applyMatrix4(inversePose);
      bounds.expandByPoint(point);
    }
  });
  return bounds;
}
function fits(car:THREE.Object3D):void {
  const bounds = physicalBounds(car);
  expect(bounds.min.x).toBeGreaterThanOrEqual(-CAR.halfWidth-1e-7);
  expect(bounds.max.x).toBeLessThanOrEqual(CAR.halfWidth+1e-7);
  expect(bounds.min.z).toBeGreaterThanOrEqual(-CAR.halfLength-1e-7);
  expect(bounds.max.z).toBeLessThanOrEqual(CAR.halfLength+1e-7);
  expect(bounds.min.y).toBeCloseTo(0,6);
  expect(car.scale.x).toBeCloseTo(car.scale.y,12);
  expect(car.scale.x).toBeCloseTo(car.scale.z,12);
}
function authoredNodes(root:THREE.Object3D):unknown[] {
  const result:unknown[] = [];
  for(const child of root.children) child.traverse(node=>{
    // The body-motion pivot (render/actors.ts rigChassis) is added by the renderer, an identity at rest.
    if(node.name==="chassis") return;
    const mesh = node as THREE.Mesh;
    result.push([node.name,node.position.toArray(),node.quaternion.toArray().map(value=>value===0?0:value),node.scale.toArray(),
      mesh.isMesh ? Array.from(mesh.geometry.getAttribute("position").array) : null]);
  });
  return result;
}

describe("personal car geometry and its authoritative footprint",()=>{
  it("fits the actual GLB and fallback, so side contact cannot overlap their drawn bodies",async()=>{
    const prototype = await model();
    expect(physicalBounds(prototype).getSize(new THREE.Vector3()).x).toBeGreaterThan(CAR.halfWidth*2+0.3);
    const fallback = makeBoxCar(0xffffff);
    expect(physicalBounds(fallback).getSize(new THREE.Vector3()).x).toBeGreaterThan(CAR.halfWidth*2);
    disposeTree(fallback);
    const warm = registry(async()=>prototype);
    await warm.get("player-car");
    for(const reg of [warm,registry(async()=>new THREE.Group(),new Set())]) {
      const view = actors(reg),a = addedCar(view,"p1"),b = addedCar(view,"p2",{...pose,x:CAR.halfWidth*2});
      fits(a); fits(b);
      expect(new THREE.Box3().setFromObject(a).max.x).toBeLessThanOrEqual(new THREE.Box3().setFromObject(b).min.x+1e-7);
    }
  });

  it("fits delayed adoption in local coordinates without changing the copied pose or authored geometry",async()=>{
    const prototype = await model();
    // An authored deformation belongs to the model; fitting must only scale its instance root.
    prototype.getObjectByName("body")!.scale.y=0.91;
    const authored = authoredNodes(prototype);
    let resolve!: (root:THREE.Object3D)=>void;
    const pending = new Promise<THREE.Object3D>(done=>{resolve=done;});
    const view = actors(registry(()=>pending));
    view.hideFor("p1");
    const at = {...pose,x:730,y:4,z:-950,heading:1.13,pitch:0.18,roll:-0.07};
    const fallback = addedCar(view,"p1",at);
    fits(fallback);
    const position=fallback.position.clone(),quaternion=fallback.quaternion.clone();
    resolve(prototype);
    await vi.waitFor(()=>expect(view.carSources().p1).toBe("file"));
    const replacement = view.group.children.find(child=>child!==fallback&&child.name===prototype.name)!;
    expect(replacement).toBeDefined();
    fits(replacement);
    expect(replacement.position.equals(position)).toBe(true);
    expect(replacement.quaternion.equals(quaternion)).toBe(true);
    expect(replacement.visible).toBe(false);
    expect(authoredNodes(replacement)).toEqual(authored);
    expect(authoredNodes(prototype)).toEqual(authored);
    expect(prototype.scale.toArray()).toEqual([1,1,1]);
  });

  it("retains the same fit on repeated poses and cached-model reuse, and rolls by the fitted wheel radius",async()=>{
    const prototype = await model(),reg = registry(async()=>prototype);
    await reg.get("player-car");
    for(const source of [reg,registry(async()=>new THREE.Group(),new Set())]) {
      const view = actors(source),car=addedCar(view,"p1"),scale=car.scale.x;
      const wheel=car.getObjectByName("wheel_FL")!;
      const rawRadius=wheel.userData.radius as number,distance=rawRadius*scale;
      expect(wheel.rotation.x).toBe(0);
      view.setCar("p1",{...pose,z:-distance,speed:1});
      expect(wheel.rotation.x).toBeCloseTo(rollWheel(0,distance,rawRadius*scale),12);
      expect(wheel.userData.radius).toBe(rawRadius);
      for(let i=0;i<4;i++)view.setCar("p1",{...pose,z:-distance,speed:1});
      expect(car.scale.toArray()).toEqual([scale,scale,scale]);
      expect(wheel.rotation.x).toBeCloseTo(-1,12);
      view.setLookSlot("p1",9);
      const reused=addedCar(view,"p1");
      expect(reused).not.toBe(car);
      expect(reused.scale.toArray()).toEqual([scale,scale,scale]);
      fits(reused);
    }
    expect(prototype.scale.toArray()).toEqual([1,1,1]);
  });
});
