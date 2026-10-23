import { expect,it } from "vitest";
import { Action } from "../../../src/sim/contract.ts";
import { PI } from "../../../src/sim/dmath.ts";
import { createObservedGameplayProvider } from "../../../src/sim/player/adapter.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import type { CombatActor } from "../../../src/sim/combat-contract.ts";
const robot=(id:string,x:number,z:number):CombatActor=>({id,x,y:0,z,heading:0,speed:0,kind:"robot",model:"footman",firmware:"bad",radius:.4,height:1.8});
it("uses recorded reticle aim for Watch while retaining body-heading fallback",()=>{
 const world=buildWorld([]),state=createInitialState(world,1,["p"],{x:0,z:0,heading:0});
 const provider=createObservedGameplayProvider({actors:()=>[robot("north",0,-20),robot("east",20,0)]});
 const watch=(aimYaw?:number)=>provider({world,previous:state,state,events:[],inputs:{p:{throttle:0,steer:0,brake:0,actions:Action.watch,...(aimYaw===undefined?{}:{aimYaw})}}}).observations[0]!.watchingActorId;
 expect(watch(PI/2)).toBe("east");expect(watch()).toBe("north");expect(watch(NaN)).toBe("north");
});
