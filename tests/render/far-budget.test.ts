import * as THREE from "three";
import type { GLTF } from "three/addons/loaders/GLTFLoader.js";
import { describe, expect, it, vi } from "vitest";
import { FarLayer, type FarCell } from "../../src/render/far-layer.ts";
import { selectFarCells, softwareFarBudget } from "../../src/render/far-selection.ts";
import type { Manifest } from "../../src/render/types.ts";

const cells: FarCell[] = [
  { id: "east", glb: "east.glb", bbox: [1000, -50, 1100, 50] },
  { id: "home", glb: "home.glb", bbox: [-50, -50, 50, 50] },
  { id: "west", glb: "west.glb", bbox: [-1100, -50, -1000, 50] },
];
const manifest = { version: 1, tileSizeM: 500, tiles: [], far: cells } as unknown as Manifest;
function model(): GLTF {
  const scene = new THREE.Group();
  const geo = new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0.2, 0, 0.2, 0.8, 0, 0.2, 0.2, 1, 0.8], 3));
  scene.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial()));
  return { scene } as unknown as GLTF;
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

describe("software far-city budget", () => {
  it("opts down only recognized software devices and preserves normal GPU quality", () => {
    for (const name of ["ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))", "llvmpipe (LLVM 15.0)", "Microsoft Basic Render Driver"]) expect(softwareFarBudget(name)).toBeDefined();
    for (const name of ["ANGLE (NVIDIA GeForce RTX 4060)", "Apple M3", "AMD Radeon", "Intel Iris Xe", "WebKit WebGL", ""]) expect(softwareFarBudget(name)).toBeUndefined();
    expect(selectFarCells(cells, 0, 0).map(c => c.id)).toEqual(["home", "east", "west"]);
    expect(selectFarCells(cells, 1050, 0, 200).map(c => c.id)).toEqual(["east"]);
  });

  it("travels between regions, releases the old geometry and keeps the current queue bounded", async () => {
    const requested: string[] = [], released: string[] = [];
    const layer = new FarLayer({ manifest, base: "/", budget: { radius: 200, retainRadius: 300, maxCells: 1 }, load: async url => {
      requested.push(url);
      const gltf = model();
      (gltf.scene.children[0] as THREE.Mesh).geometry.addEventListener("dispose", () => released.push(url));
      return gltf;
    } });
    layer.start(); await flush();
    expect(requested).toEqual(["/home.glb"]);
    expect(layer.info()).toMatchObject({ loaded: 1, triangles: 1, radius: 200, queued: 0, loading: 0 });
    layer.update(1050, 0); await flush();
    expect(requested).toEqual(["/home.glb", "/east.glb"]);
    expect(released).toContain("/home.glb");
    expect(layer.group.children.map(child => child.name)).toEqual(["far:east"]);
    expect(layer.info()).toMatchObject({ loaded: 1, triangles: 1 });
    expect(layer.settled()).toBe(true);
    layer.dispose(); expect(released).toContain("/east.glb");
  });

  it("keeps the full skyline without the software budget", async () => {
    const requested: string[] = [];
    const layer = new FarLayer({ manifest, base: "/", maxConcurrent: 1, load: async url => { requested.push(url); return model(); } });
    layer.start(); await flush();
    expect(requested).toEqual(["/home.glb", "/east.glb", "/west.glb"]);
    layer.update(100000, 0);
    expect(layer.info()).toMatchObject({ loaded: 3, triangles: 3, radius: null });
    layer.dispose();
  });

  it("discards an obsolete in-flight region when the camera moves", async () => {
    let resolveHome!: (gltf: GLTF) => void;
    const layer = new FarLayer({ manifest, base: "/", maxConcurrent: 1, budget: { radius: 200, retainRadius: 300, maxCells: 1 }, load: url => url === "/home.glb" ? new Promise(resolve => { resolveHome = resolve; }) : Promise.resolve(model()) });
    layer.start(); layer.update(1050, 0);
    resolveHome(model()); await flush();
    expect(layer.group.children.map(child => child.name)).toEqual(["far:east"]);
    expect(layer.info().loaded).toBe(1);
    layer.dispose();
  });

  it("reserves preparation slots and accounts each root only after interleaved lawn work finishes",async()=>{
    const finish=new Map<string,()=>void>();
    const layer=new FarLayer({manifest,base:"/",maxConcurrent:2,load:async url=>{
      const gltf=model();(gltf.scene.children[0] as THREE.Mesh).geometry.userData.file=url;return gltf;
    },lawnTerrain:async geo=>{
      const file=geo.userData.file as string;
      await new Promise<void>(resolve=>finish.set(file,resolve));
      geo.setIndex(file==="/home.glb"?[0,1,2,0,1,2,0,1,2]:[0,1,2,0,1,2]);
      return 0;
    }});
    layer.start();await flush();
    expect([...finish.keys()]).toEqual(["/home.glb","/east.glb"]);
    expect(layer.info()).toMatchObject({loaded:0,triangles:0,loading:2});expect(layer.settled()).toBe(false);
    finish.get("/east.glb")!();await flush();
    expect(layer.info()).toMatchObject({loaded:1,triangles:2,loading:2});
    finish.get("/home.glb")!();await flush();
    expect(layer.info()).toMatchObject({loaded:2,triangles:5,loading:1});
    finish.get("/west.glb")!();await flush();
    expect(layer.info()).toMatchObject({loaded:3,triangles:7,loading:0});expect(layer.settled()).toBe(true);
    layer.dispose();
  });

  it("drops a region made obsolete during asynchronous preparation without disposing shared material",async()=>{
    let release!:()=>void,released=false,materialDisposed=false;
    const layer=new FarLayer({manifest,base:"/",maxConcurrent:1,budget:{radius:200,retainRadius:300,maxCells:1},load:async url=>{
      const gltf=model();if(url==="/home.glb")(gltf.scene.children[0] as THREE.Mesh).geometry.addEventListener("dispose",()=>{released=true;});return gltf;
    },lawnTerrain:async()=>{if(!release)await new Promise<void>(resolve=>{release=resolve;});return 0;}});
    layer.material.addEventListener("dispose",()=>{materialDisposed=true;});
    layer.start();await flush();layer.update(1050,0);release();await flush();
    expect(released).toBe(true);expect(materialDisposed).toBe(false);
    expect(layer.group.children.map(child=>child.name)).toEqual(["far:east"]);
    expect(layer.info()).toMatchObject({loaded:1,triangles:1,loading:0});layer.dispose();
  });

  it("disposes prepared geometry after shutdown and never admits it or changes counters",async()=>{
    let release!:()=>void,released=false;
    const layer=new FarLayer({manifest,base:"/",maxConcurrent:1,load:async()=>{
      const gltf=model();(gltf.scene.children[0] as THREE.Mesh).geometry.addEventListener("dispose",()=>{released=true;});return gltf;
    },lawnTerrain:async()=>{await new Promise<void>(resolve=>{release=resolve;});return 0;}});
    layer.start();await flush();layer.dispose();release();await flush();
    expect(released).toBe(true);expect(layer.group.children).toHaveLength(0);
    expect(layer.info()).toMatchObject({loaded:0,triangles:0,loading:0});expect(layer.settled()).toBe(true);
  });

  it("cleans up failed lawn preparation and records a failure without leaked counters",async()=>{
    let released=false;
    const warning=vi.spyOn(console,"warn").mockImplementation(()=>{});
    const one={...manifest,far:[cells[1]!]} as Manifest;
    const layer=new FarLayer({manifest:one,base:"/",load:async()=>{
      const gltf=model();(gltf.scene.children[0] as THREE.Mesh).geometry.addEventListener("dispose",()=>{released=true;});return gltf;
    },lawnTerrain:async()=>{throw new Error("fixture preparation failure");}});
    try {
      layer.start();await flush();expect(released).toBe(true);
      expect(layer.info()).toMatchObject({failed:1,loaded:0,triangles:0,loading:0});expect(layer.settled()).toBe(true);
    } finally {layer.dispose();warning.mockRestore();}
  });
});
