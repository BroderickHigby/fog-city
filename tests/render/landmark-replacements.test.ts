import { describe,it,expect } from "vitest";
import { landmarkRenderReplacements } from "../../src/render/landmark-replacements.ts";
import type { TileCollider } from "../../src/sim/world.ts";
const one={id:"record-1",footprint:[[0,0],[2,0],[2,2],[0,2]] as [number,number][],baseY:0,topY:30};
const neighbour={...one,id:"neighbour"};
const tiles:TileCollider[]=[{tileId:"t0_0",ground:null,buildings:[one,neighbour]}];
const doc={landmarks:[{id:"dedicated",model:"models/tower.glb",lat:37.7,lon:-122.4,headingDeg:0,replacesBuildingIds:["record-1"]}]};
it("offers exact existing records as visible fallbacks without changing canonical collision",()=>{
  const before=JSON.stringify(tiles),result=landmarkRenderReplacements(doc,tiles);
  expect(result).toHaveLength(1);expect(result[0]!.sources).toEqual([one]);expect(result[0]!.colliders[0]).toBe(one);
  expect(result[0]!.sources).not.toContain(neighbour);expect(JSON.stringify(tiles)).toBe(before);
});
it("keeps an authored open-arch replacement and never replaces it with a solid record",()=>{
  const arches={id:"dedicated",version:1,sources:[one],colliders:[{...one,id:"column",topY:8}]};
  const result=landmarkRenderReplacements(doc,tiles,[arches]);expect(result).toEqual([arches]);expect(result[0]).toBe(arches);
});
it("missing site records never hide a neighbouring building or create an invisible collision object",()=>{
  expect(landmarkRenderReplacements(doc,[])).toEqual([]);expect(landmarkRenderReplacements(null,tiles)).toEqual([]);
});
