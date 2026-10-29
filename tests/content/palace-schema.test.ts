import{describe,it,expect}from"vitest";
import Ajv2020 from"ajv/dist/2020.js";
import {readJson}from"../helpers.ts";
const ajv=new Ajv2020({strict:true});ajv.addSchema(readJson("schemas/provenance.schema.json"));
const lagoon=ajv.compile(readJson("schemas/palace-lagoon.schema.json")),palace=ajv.compile(readJson("schemas/palace-of-fine-arts.schema.json"));
const copy=(name:string)=>structuredClone(readJson<Record<string,any>>(`content/${name}.json`));
describe("generated Palace metadata contracts",()=>{
 it("accepts the actual authored collider layout and lagoon contour",()=>{expect(lagoon(copy("palace-lagoon"))).toBe(true);expect(palace(copy("palace-of-fine-arts"))).toBe(true)});
 it("rejects non-planar/short contours and missing source attribution",()=>{
  for(const change of[(d:any)=>d.ring=[[0,0],[1,0]],(d:any)=>d.ring[0]=[0,0,0],(d:any)=>delete d.source]){const d=copy("palace-lagoon");change(d);expect(lagoon(d)).toBe(false)}
 });
 it("rejects duplicate replacement records, malformed collider support and an unknown coordinate frame",()=>{
  for(const change of[(d:any)=>d.replacesBuildingIds.push(d.replacesBuildingIds[0]),(d:any)=>delete d.colliders[0].topY,(d:any)=>d.colliders[0].underY="above",(d:any)=>d.frame="unknown"]){const d=copy("palace-of-fine-arts");change(d);expect(palace(d)).toBe(false)}
 });
});
