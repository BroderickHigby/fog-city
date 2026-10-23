import { expect,it } from "vitest";
import { Action } from "../../../src/sim/contract.ts";
import { createObservedGameplayProvider } from "../../../src/sim/player/adapter.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import type { CombatActor } from "../../../src/sim/combat-contract.ts";

it("watches the observed robot in front of the player and respects a blocked sightline",()=>{
 const actor=(id:string,z:number):CombatActor=>({id,z,x:0,y:0,heading:0,speed:0,kind:"robot",firmware:"bad",model:"footman",radius:.4,height:1.8});
 const world=buildWorld([]),state=createInitialState(world,1,["p"],{x:0,z:0,heading:0});
 const provider=createObservedGameplayProvider({actors:()=>[actor("behind",2),actor("ahead",-5)]});
 const ctx={world,state,previous:state,inputs:{p:{throttle:0,steer:0,brake:0,actions:Action.watch}},events:[]};
 expect(provider(ctx).observations[0]!.watchingActorId).toBe("ahead");
 const blocked=buildWorld([{tileId:"0/0",ground:null,buildings:[{id:"wall",baseY:0,topY:10,footprint:[[-2,-3],[2,-3],[2,-2],[-2,-2]]}]}]);
 expect(provider({...ctx,world:blocked}).observations[0]!.watchingActorId).toBeUndefined();
});
