import {it,expect} from "vitest";
import {createInitialState,playerBodies,playerCars,populate,stepAgents,POP_INTERVAL,TRUNDLE_FREE_VERSION} from "../../src/sim/index.ts";
import {gridCity} from "./fixtures.ts";
it("counts claimed legacy actors before refilling ambient population slots",()=>{
 // Every ambient body kept as it was: a v23 state (from v24 the first step takes the Trundles off the street).
 const world=gridCity(),state={...createInitialState(world,4,["p"],{x:0,z:0,heading:0}),version:TRUNDLE_FREE_VERSION-1};
 state.ext.agents={...state.ext.agents!,list:state.ext.agents!.list.map(actor=>({...actor,runtimeId:`agent:${actor.id}`,runtimeLegacy:true}))};
 const expected=populate(world,state.ext.agents,state.rng,playerBodies(state),state.seed,false,playerCars(state),[],state.version);
 const result=stepAgents(world,state,POP_INTERVAL,new Set(state.ext.agents.list.map(actor=>actor.id)))!;
 expect(result.ext.nextId).toBe(expected.ext.nextId);
 expect(result.ext.list).toHaveLength(expected.ext.list.length);
 expect(result.rng).toEqual(expected.rng);
 for(const actor of state.ext.agents.list)expect(result.ext.list.find(item=>item.id===actor.id)).toEqual(actor);
});
