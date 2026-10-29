import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { Box3, Matrix4, Vector3, Group } from "three";
import { createTileLoader } from "../../src/render/gltf-loader.ts";
import { ModelRegistry } from "../../src/render/model-registry.ts";
import { AgentLayer, AGENT_DRAW_CALL_BUDGET } from "../../src/render/agent-layer.ts";
import type { SimState } from "../../src/sim/contract.ts";
import type { AgentState } from "../../src/sim/agents.ts";
import type { Object3D, InstancedMesh } from "three";
import { VEHICLE_MODELS, VEHICLE_MODEL_FILES, vehicleModelForActor } from "../../src/render/vehicle-models.ts";

describe("normalized licensed civilian families",()=>{
 it("ships five actual distinct bodies with matching hashes, four centered wheels and measured dimensions",async()=>{
  await MeshoptDecoder.ready;
  const io=new NodeIO().registerExtensions([EXTMeshoptCompression]).registerDependencies({"meshopt.decoder":MeshoptDecoder});
  expect(VEHICLE_MODELS).toHaveLength(5);expect(new Set(VEHICLE_MODELS.map(m=>m.sha256)).size).toBe(5);
  for(const family of VEHICLE_MODELS){
   expect(VEHICLE_MODEL_FILES[`civilian:${family.id}`]).toBe(family.url);
   const bytes=readFileSync(resolve("public",family.url));expect(createHash("sha256").update(bytes).digest("hex")).toBe(family.sha256);
   expect(bytes.length).toBeLessThan(300000);
   const doc=await io.readBinary(bytes);expect(doc.getRoot().listTextures()).toHaveLength(0);
   const bounds=new Box3();let triangles=0;
   for(const node of doc.getRoot().listNodes())for(const primitive of node.getMesh()?.listPrimitives()??[]){
    const p=primitive.getAttribute("POSITION")!,matrix=new Matrix4().fromArray(node.getWorldMatrix());triangles+=(primitive.getIndices()?.getCount()??p.getCount())/3;
    for(let i=0;i<p.getCount();i++)bounds.expandByPoint(new Vector3().fromArray(p.getElement(i,[0,0,0])).applyMatrix4(matrix));
   }
   expect(triangles).toBe(family.triangles);expect(triangles).toBeLessThan(3500);
   const size=bounds.getSize(new Vector3());expect(size.z).toBeCloseTo(family.lengthM,4);expect(size.x).toBeCloseTo(family.totalWidthM,4);expect(size.y).toBeCloseTo(family.heightM,4);expect(bounds.min.y).toBeCloseTo(0,5);
   expect(size.z).toBeLessThanOrEqual(4.6001);expect(size.x).toBeLessThanOrEqual(2.0001);
   for(const name of ["wheel_FL","wheel_FR","wheel_RL","wheel_RR"]){
    const wheel=doc.getRoot().listNodes().find(n=>n.getName()===name)!;expect(wheel,name).toBeDefined();const hub=wheel.getWorldTranslation();
    expect(hub[1]).toBeCloseTo(family.wheelRadiusM,6);expect(Math.abs(hub[2]!)*2).toBeCloseTo(family.wheelbaseM,6);expect(name.includes("_F")?hub[2]!<0:hub[2]!>0).toBe(true);expect(name.endsWith("L")?hub[0]!<0:hub[0]!>0).toBe(true);
    expect(wheel.getExtras()).toMatchObject({radius:family.wheelRadiusM,spinAxis:[1,0,0],steer:name.includes("_F")});
    const local=new Box3();for(const primitive of wheel.getMesh()!.listPrimitives()){const pos=primitive.getAttribute("POSITION")!;for(let i=0;i<pos.getCount();i++)local.expandByPoint(new Vector3().fromArray(pos.getElement(i,[0,0,0])));}
    expect(local.getCenter(new Vector3()).length()).toBeLessThan(.00001);const dimensions=local.getSize(new Vector3());expect(dimensions.y).toBeCloseTo(family.wheelRadiusM*2,4);expect(dimensions.z).toBeCloseTo(dimensions.y,4);expect(dimensions.x).toBeCloseTo(family.wheelWidthM,4);
   }
   expect(doc.getRoot().listMaterials().some(m=>m.getName()==="paint")).toBe(true);
  }
 });
 it("selects all families deterministically from actual traffic identities",()=>{
  const families=new Set<string>();for(let i=1;i<=100;i++){const id=200007+i*8;families.add(vehicleModelForActor(id).id);expect(vehicleModelForActor(id)).toBe(vehicleModelForActor(id));}expect(families.size).toBe(5);
 });
 it("loads all five through the native renderer and draws separate family LOD batches within budget",async()=>{
  const loader=createTileLoader();
  const registry=new ModelRegistry<Object3D>({load:async url=>{const bytes=readFileSync(resolve("public",url));return (await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer,"")).scene;},clone:o=>o.clone(true),fallback:()=>new Group(),available:new Set(VEHICLE_MODELS.map(f=>f.url))});
  const layer=new AgentLayer(registry);
  await Promise.all(VEHICLE_MODELS.map(f=>registry.get(`civilian:${f.id}`)));
  const actors=Array.from({length:50},(_,i)=>({id:200007+i*8,kind:"robotaxi",x:(i%5)*4-8,y:0,z:-8-i*3,heading:0,pitch:0,speed:8,mode:"go"})) as unknown as AgentState[];
  const state={tick:1,players:{},ext:{agents:{nextId:300000,list:actors}}} as unknown as SimState;
  layer.update(state,state,1,{x:0,z:0,fx:0,fz:-1},1/60,0);
  expect(layer.info().drawn).toBe(50);expect(layer.info().drawCalls).toBeLessThanOrEqual(AGENT_DRAW_CALL_BUDGET);
  const used=new Set<string>();layer.group.traverse(o=>{const mesh=o as InstancedMesh;if(mesh.isInstancedMesh&&mesh.count>0&&mesh.name.startsWith("agents:civilian:"))used.add(mesh.name.split(":")[2]!);});
  expect([...used].sort()).toEqual(VEHICLE_MODELS.map(f=>f.id).sort());
  for(const family of VEHICLE_MODELS){const budget=layer.budgets()[`civilian:${family.id}`]!;expect(budget.source).toBe("file");expect(budget.near).toBe(family.triangles);expect(budget.far).toBeLessThan(budget.near);}
  layer.dispose();
 });

});
