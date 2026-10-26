import { describe, expect, it } from "vitest";
import { assembleWorldFiles, buildLoadedWorld, loadWorldFiles, type WorldManifestLike } from "../../src/io/world-load.ts";
import { worldFingerprint } from "../../src/net/world-id.ts";
import type { RoadsFile } from "../../src/sim/roads.ts";
import type { TrafficSignalFile } from "../../src/sim/traffic-signals.ts";
import type { Assets } from "../../src/io/assets.ts";

const roads: RoadsFile = {
  version: 1,
  nodes: [{id:"center",x:0,z:0},{id:"west",x:-80,z:0},{id:"east",x:80,z:0},{id:"north",x:0,z:-80},{id:"south",x:0,z:80}],
  edges: ["west","east","north","south"].map((name, i) => ({
    id:name, a:"center", b:name, kind:"residential", lanes:2, oneway:false,
    points:[[0,0], [i===0?-80:i===1?80:0,i===2?-80:i===3?80:0]],
  })),
};
const signals:TrafficSignalFile={signals:[{node:"center",kind:"signal",ped:true}]};
const manifest:WorldManifestLike={spawn:{x:50,z:20,heading:0},tiles:[],roads:"roads.json",layers:{signals:"signals.json"}};

describe("traffic signals in the shared world loader",()=>{
  it("loads the declared signal inventory and gives browser/server builds the same phases",async()=>{
    const assets:Assets={mode:"loose",defaultWorld:null,worlds:null,has:()=>true,bytes:async()=>new Uint8Array(),json:async<T>(path:string):Promise<T>=>{
      if(path.endsWith("manifest.json"))return manifest as T;
      if(path.endsWith("roads.json"))return roads as T;
      if(path.endsWith("signals.json"))return signals as T;
      throw new Error(`missing ${path}`);
    }};
    const loaded=await loadWorldFiles(assets,"test");
    const direct=assembleWorldFiles(manifest,{json:[]},roads,null,{signals});
    const world=buildLoadedWorld(loaded),node=world.signals?.get("center");
    expect(node?.groupCount).toBe(2);
    expect([...node!.approaches]).toEqual([...buildLoadedWorld(direct).signals!.get("center")!.approaches]);
    expect(worldFingerprint(loaded)).toBe(worldFingerprint(direct));
    expect(worldFingerprint({...direct,signals:undefined})).not.toBe(worldFingerprint(direct));
    expect(signals.signals).toEqual([{node:"center",kind:"signal",ped:true}]);
  });

  it("fails a declared missing signal layer instead of letting peers run different junction rules",async()=>{
    const assets:Assets={mode:"loose",defaultWorld:null,worlds:null,has:()=>true,bytes:async()=>new Uint8Array(),json:async<T>(path:string):Promise<T>=>{
      if(path.endsWith("manifest.json"))return manifest as T;
      if(path.endsWith("roads.json"))return roads as T;
      throw new Error("missing");
    }};
    await expect(loadWorldFiles(assets,"test")).rejects.toThrow("traffic-signals layer signals.json");
    expect(buildLoadedWorld(assembleWorldFiles({...manifest,layers:{}},{json:[]},roads,null)).signals).toBeUndefined();
  });
});
