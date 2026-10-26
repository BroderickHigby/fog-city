import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as THREE from "three";
import { describe,expect,it } from "vitest";
import { BuildingDetailLayer,BUILDING_DETAIL_COUNT,BUILDING_DETAIL_TRIANGLES,addBuildingCharacter,characterizeBuildings,type BuildingCharacter } from "../../src/render/building-character.ts";
import { createTileLoader } from "../../src/render/gltf-loader.ts";
import { geometryFromMeshData } from "../../src/render/props.ts";
import { MeshBuilder,addBuilding } from "../../src/render/tile-geometry.ts";
import type { BuildingCollider,TileCollider } from "../../src/sim/world.ts";
import { ROOT } from "../helpers.ts";

function sample(id="building-1",x=0,z=0):{building:BuildingCollider;geo:THREE.BufferGeometry;character:BuildingCharacter}{
  const building={id,footprint:[[x,z],[x+18,z],[x+18,z+12],[x,z+12]] as Array<[number,number]>,baseY:8,topY:36};
  const mb=new MeshBuilder({uv:true,facade:true});addBuilding(mb,building,{detail:false});
  const geo=geometryFromMeshData(mb.build()),character=characterizeBuildings(geo,new THREE.Matrix4(),new Map([[id,building]]))[0]!;
  return{building,geo,character};
}
function finish(layer:BuildingDetailLayer,x=10,z=10):void{for(let i=0;i<100&&!layer.settled();i++)layer.update(x,z,100);expect(layer.settled()).toBe(true);}

describe("building character and relief",()=>{
  it("assigns stable identity and base/height per building without altering source geometry or collider",()=>{
    const {building,geo,character}=sample(),before=JSON.stringify(building),pos=geo.getAttribute("position").array.slice(),index=geo.getIndex()!.array.slice();
    const again=characterizeBuildings(geo,new THREE.Matrix4(),new Map([[building.id,building]]))[0]!;
    expect(again).toEqual(character);expect(geo.getAttribute("_building").getY(0)).toBeCloseTo(8,5);expect(geo.getAttribute("_building").getZ(0)).toBeCloseTo(28,5);
    expect(geo.getAttribute("position").array).toEqual(pos);expect(geo.getIndex()!.array).toEqual(index);expect(JSON.stringify(building)).toBe(before);
    expect(character.walls).toHaveLength(4);expect(character.walls.every(w=>Math.abs(w.baseY-building.baseY)<.01)).toBe(true);
    expect(sample("building-2").character.seed).not.toBe(character.seed);
    geo.dispose();
  });

  it("reads world metres and authored baseY through the actual quantized committed SF GLB transform",async()=>{
    const tile=JSON.parse(readFileSync(join(ROOT,"public/tiles/sf/t0_0.collider.json"),"utf8")) as TileCollider;
    const bytes=readFileSync(join(ROOT,"public/tiles/sf/t0_0.glb"));
    const gltf=await createTileLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),"");gltf.scene.updateMatrixWorld(true);
    const mesh=gltf.scene.getObjectByName("buildings") as THREE.Mesh;
    mesh.geometry.userData.fcBuildings=mesh.userData.buildings;
    const characters=characterizeBuildings(mesh.geometry,mesh.matrixWorld,new Map(tile.buildings.map(b=>[b.id,b])));
    expect(characters.length).toBeGreaterThan(15);
    for(const b of characters){
      const collider=tile.buildings.find(c=>c.id===b.id)!;
      expect(Math.abs(b.baseY-collider.baseY),b.id).toBeLessThan(.2);
      expect(b.height,b.id).toBeGreaterThan(.5);expect(b.height,b.id).toBeLessThan(200);
      expect(b.walls.every(w=>w.ax>-60&&w.ax<560&&w.az>-60&&w.az<560)).toBe(true);
    }
    const attr=mesh.geometry.getAttribute("_building");expect(Array.from(attr.array).every(Number.isFinite)).toBe(true);
    gltf.scene.traverse(o=>{if((o as THREE.Mesh).isMesh)(o as THREE.Mesh).geometry.dispose();});
  });

  it("keeps different architectural families physical, stable and safely above navigation",()=>{
    const {character}=sample();const signatures=new Set<string>();
    for(const family of[0,1,2,3,4] as const){
      const mb=new MeshBuilder();addBuildingCharacter(mb,{...character,family});const geometry=mb.build();
      expect(geometry.indices.length).toBeGreaterThan(100);expect(geometry.indices.length/3).toBeLessThanOrEqual(4800);
      expect(Array.from(geometry.positions).every(Number.isFinite)).toBe(true);
      for(let i=1;i<geometry.positions.length;i+=3)expect(geometry.positions[i]).toBeGreaterThanOrEqual(character.baseY+3-.001);
      const second=new MeshBuilder();addBuildingCharacter(second,{...character,family});expect(second.build()).toEqual(geometry);
      signatures.add(`${geometry.indices.length}:${Array.from(geometry.positions.slice(0,24)).join(",")}`);
    }
    expect(signatures.size).toBeGreaterThanOrEqual(4);
  });

  it("bounds detail count/triangles/draw calls and drops hidden or unloaded buildings immediately",()=>{
    const parent=new THREE.Group(),layer=new BuildingDetailLayer(parent);
    const buildings=Array.from({length:70},(_,i)=>sample(`b${i}`,i%10*22,Math.floor(i/10)*18).character);
    layer.register("tile",buildings);finish(layer,45,45);
    expect(layer.stats().buildings).toBeGreaterThan(0);expect(layer.stats().buildings).toBeLessThanOrEqual(BUILDING_DETAIL_COUNT);
    expect(layer.stats().triangles).toBeLessThanOrEqual(BUILDING_DETAIL_TRIANGLES);expect(layer.stats().drawCalls).toBe(1);
    const mesh=parent.getObjectByName("building-character-details") as THREE.Mesh;let disposed=0;mesh.geometry.addEventListener("dispose",()=>disposed++);
    layer.hide(buildings.map(b=>b.id));expect(parent.children).toHaveLength(0);expect(disposed).toBe(1);finish(layer,45,45);expect(layer.stats().triangles).toBe(0);
    layer.unregister("tile");finish(layer);expect(layer.stats().registered).toBe(0);layer.dispose();expect(parent.children).toHaveLength(0);
  });

  it("leaves distant buildings and overhead spans free of added physical detail",()=>{
    const parent=new THREE.Group(),layer=new BuildingDetailLayer(parent),b=sample("bridge",1000,1000).character;
    layer.register("far",[b]);finish(layer);expect(layer.stats().triangles).toBe(0);
    layer.register("span",[{...sample("span").character,underY:7}]);finish(layer);expect(layer.stats().triangles).toBe(0);layer.dispose();
  });

  it("keeps raised details over three metres clear of a steep uphill street",()=>{
    const {character}=sample(),mb=new MeshBuilder();
    const ground=(x:number,_z:number)=>8+x*.35;
    addBuildingCharacter(mb,character,BUILDING_DETAIL_TRIANGLES,ground);
    const mesh=mb.build();expect(mesh.indices.length).toBeGreaterThan(0);
    for(let i=0;i<mesh.positions.length;i+=3){
      const x=mesh.positions[i]!,y=mesh.positions[i+1]!,z=mesh.positions[i+2]!;
      expect(y-ground(x,z)).toBeGreaterThan(3);
    }
  });
});
