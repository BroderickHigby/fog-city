import { expect,it } from "vitest";
import { combatFacts } from "../../../src/sim/player/adapter.ts";
it("normalizes real refill and cone impacts without counting a taxi cone twice",()=>{
 const event=(id:number,kind:string,targetId:string)=>({id,kind,targetId,tick:10,sourceId:"p",amount:1,detail:""});
 const facts=combatFacts([event(3,"vehicle.pull-over","taxi"),event(1,"refill.complete","hydrant"),event(2,"robot.blinded","taxi"),event(4,"weapon.cone","")]);
 expect(facts.map(f=>f.kind)).toEqual(["water.refilled","cone.placed","weapon.cone"]);
 expect(facts.map(f=>f.sequence)).toEqual([1,2,4]);
});
it("attributes attack damage to its player target and interrupted updates to their interrupter",()=>{
 const facts=combatFacts([{id:1,tick:5,kind:"player.runway",sourceId:"pusher",targetId:"p",amount:-1,detail:"shove"},{id:2,tick:5,kind:"robot.blinded",sourceId:"p",targetId:"pusher",amount:180,detail:""},{id:3,tick:5,kind:"update.interrupted",sourceId:"pusher",targetId:"courier",amount:0,detail:"disabled"}]);
 expect(facts.find(f=>f.kind==="player.runway")).toMatchObject({playerId:"p",actorId:"pusher",amount:-1});
 expect(facts.find(f=>f.kind==="update.interrupted")).toMatchObject({playerId:"p",actorId:"pusher"});
});
