import {describe,it,expect} from "vitest";
import {assembleWorldFiles,buildLoadedWorld,loadWorldFiles,type WorldManifestLike} from "../../src/io/world-load.ts";
import type {Assets} from "../../src/io/assets.ts";
import type {PipelineSidewalks} from "../../src/sim/agents/pipeline-navigation.ts";
import type {GameplayWorldData} from "../../src/sim/gameplay-world.ts";
import type {TransitLayer} from "../../src/sim/agents/transit-runtime.ts";

const manifest:WorldManifestLike={spawn:{x:0,z:0,heading:0},tiles:[],layers:{gameplay:"gameplay.json",sidewalks:"sidewalks.json",transit:"muni.json"}};
const sidewalks:PipelineSidewalks={version:1,nodes:[{id:"a",x:0,y:0,z:0},{id:"b",x:10,y:0,z:0}],edges:[{id:"ab",a:"a",b:"b",kind:"sidewalk",points:[[4,1]]}]};
const gameplay:GameplayWorldData={version:1,world:"test",sourceSnapshot:"test",refills:[],anchors:[],tiles:[],territories:[]};
const transit:TransitLayer={version:1,routes:[],stops:[]};
describe("shared world loading",()=>{
  it("builds the same authored metadata and sidewalk curves without changing source files",()=>{
    const before=JSON.stringify({sidewalks,gameplay,transit});
    const files=assembleWorldFiles(manifest,{json:[]},null,null,{gameplay,sidewalks,transit});
    const world=buildLoadedWorld(files);
    expect(world.gameplay).toBe(gameplay);expect(world.transit).toBe(transit);
    expect(world.sidewalks?.edges[0]?.path.xs).toEqual([0,4,10]);
    expect(world.sidewalks?.edges[0]?.path.zs).toEqual([0,1,0]);
    expect(JSON.stringify({sidewalks,gameplay,transit})).toBe(before);
  });
  it("fails a declared missing layer instead of silently running a different world",async()=>{
    const assets:Assets={mode:"loose",defaultWorld:null,worlds:null,has:()=>true,bytes:async()=>new Uint8Array(),json:async<T>(path:string):Promise<T>=>{
      if(path.endsWith("manifest.json"))return manifest as T;
      if(path.endsWith("sidewalks.json"))return sidewalks as T;
      if(path.endsWith("muni.json"))return transit as T;
      throw new Error("missing");
    }};
    await expect(loadWorldFiles(assets,"test")).rejects.toThrow("gameplay layer gameplay.json");
  });
});
