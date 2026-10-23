import { expect,it } from "vitest";
import { combatFacts } from "../../../src/sim/player/adapter.ts";
it("normalizes real refill and cone impacts without counting a taxi cone twice",()=>{
 const event=(id:number,kind:string,targetId:string)=>({id,kind,targetId,tick:10,sourceId:"p",amount:1,detail:""});
 const facts=combatFacts([event(3,"vehicle.pull-over","taxi"),event(1,"refill.complete","hydrant"),event(2,"robot.blinded","taxi"),event(4,"weapon.cone","")]);
 expect(facts.map(f=>f.kind)).toEqual(["water.refilled","cone.placed","weapon.cone"]);
 expect(facts.map(f=>f.sequence)).toEqual([1,2,4]);
});
