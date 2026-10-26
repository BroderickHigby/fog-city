import { expect, it } from "vitest";
import { buildWorld } from "../../src/sim/world.ts";
import { lanePath, pathPoint } from "../../src/sim/roads.ts";
import type { TaxiCurb } from "../../src/modes/taxi-routes.ts";
import { createSfTaxiCatalog, taxiRoadPath, taxiRouteStatus } from "../../src/modes/taxi-routes.ts";
const world=buildWorld([],{version:1,nodes:[{id:"a",x:0,z:0},{id:"b",x:150,z:0},{id:"c",x:300,z:0}],edges:[{id:"ab",a:"a",b:"b",kind:"residential",lanes:2,oneway:true,points:[[0,0],[150,0]]},{id:"bc",a:"b",b:"c",kind:"residential",lanes:2,oneway:true,points:[[150,0],[300,0]]},{id:"ca",a:"c",b:"a",kind:"residential",lanes:2,oneway:true,points:[[300,0],[300,150],[0,150],[0,0]]}]});
function curb(edgeId:string,id:string):TaxiCurb {
  const edge=world.roads!.edges.find(value=>value.id===edgeId)!,path=lanePath(edge,1,0),at=path.len*.5,p=pathPoint(path,at);
  return {id,district:id,districtName:id,label:id,stop:{x:p.x,y:0,z:p.z,radiusM:3.8},heading:0,passenger:{x:p.x,y:0,z:p.z+2.2},edge:edge.index,edgeId:edge.id,dir:1,lane:0,at};
}
it("measures actual legal directed links and cannot reverse a one-way pickup lane",()=>{
  const a=curb("ab","downtown"),b=curb("bc","soma"),forward=taxiRoadPath(world.roads!,a,b),back=taxiRoadPath(world.roads!,b,a);
  expect(forward?.edgeIds).toEqual(["ab","bc"]);expect(back?.edgeIds).toEqual(["bc","ca","ab"]);
  expect(back!.distanceM).toBeGreaterThan(forward!.distanceM);expect(taxiRoadPath(world.roads!,{...a,dir:-1},b)).toBeNull();
});
it("refuses a stale saved graph index instead of interpreting a different road as the route",()=>{
  const a=curb("ab","downtown"),b=curb("bc","soma"),path=taxiRoadPath(world.roads!,a,b)!;
  const catalog={version:1 as const,config:{version:1 as const,id:"fixture",routes:[],shifts:[]},curbs:[a,b],roads:[{...path,edgeIds:["wrong",...path.edgeIds.slice(1)]}]};
  expect(taxiRouteStatus(world,catalog,path.id)).toBe("unknown");
});
it("fails closed when city road geometry lacks actual loaded terrain support",()=>{
  expect(()=>createSfTaxiCatalog(world)).toThrow();
  expect(()=>createSfTaxiCatalog(buildWorld([]))).toThrow("road graph");
});

it("excludes whole road/body corridors crossing protected mode areas and Chinatown even with endpoints outside",async()=>{
  const { PROTECTED_AREAS }=await import("../../src/content/places.ts"),{toLocal}=await import("../../src/geo/project.ts"),{taxiExcludedRoadEdges}=await import("../../src/modes/taxi-routes.ts");
  for(const id of ["tenderloin","civic-center","sixth-street","division-13th","chinatown"]){
    const area=PROTECTED_AREAS.find(value=>value.id===id)!,ring=area.polygon.map(([lat,lon])=>toLocal(lat,lon)),x=ring.reduce((sum,p)=>sum+p.x,0)/ring.length,z=ring.reduce((sum,p)=>sum+p.z,0)/ring.length;
    const fixture=buildWorld([],{version:1,nodes:[{id:"a",x:x-3000,z},{id:"b",x:x+3000,z}],edges:[{id:`cross-${id}`,a:"a",b:"b",kind:"residential",lanes:2,oneway:false,points:[[x-3000,z],[x+3000,z]]}]});
    expect(taxiExcludedRoadEdges(fixture.roads!).has(0),id).toBe(true);
  }
});
