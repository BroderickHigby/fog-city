import { describe, expect, it } from "vitest";
import type { RoadGraph } from "../../src/render/types.ts";
import { streetNameAt } from "../../src/ui/street-name.ts";

describe("street label projection",()=>{
  const roads:RoadGraph={version:1,nodes:[],edges:[
    {id:"clay",a:"a",b:"b",kind:"residential",lanes:2,oneway:false,name:"Clay St",points:[[0,0],[300,0]]},
    {id:"montgomery",a:"c",b:"d",kind:"arterial",lanes:2,oneway:false,name:"Montgomery St",points:[[200,-200],[200,200]]},
    {id:"overpass",a:"e",b:"f",kind:"freeway",lanes:2,oneway:true,name:"Overpass",points:[[0,10],[300,10]]},
  ]};
  it("uses real nearby surface streets across spatial cell boundaries",()=>{
    expect(streetNameAt(roads,127,8)).toBe("Clay St");
    expect(streetNameAt(roads,130,8)).toBe("Clay St");
    expect(streetNameAt(roads,204,100)).toBe("Montgomery St");
    expect(roads.edges[0]!.points).toEqual([[0,0],[300,0]]);
  });
  it("leaves distant, missing and invalid locations without an invented label",()=>{
    expect(streetNameAt(roads,100,100)).toBeUndefined();
    expect(streetNameAt(null,10,0)).toBeUndefined();
    expect(streetNameAt(roads,NaN,0)).toBeUndefined();
  });
});
