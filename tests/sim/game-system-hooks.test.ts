import {describe,it,expect} from "vitest";
import {buildWorld,step} from "../../src/sim/index.ts";
import {createGameSystems} from "../../src/sim/game-systems.ts";
import {createMatchSession,modeSessionOf} from "../../src/sim/modes/session.ts";

describe("configured gameplay composition",()=>{
 it("runs mode hooks with accepted actor poses and explicit carry-in equipment",()=>{
  const world=buildWorld([]),initial=createMatchSession(world,{id:"configured",mode:"botSweep",seed:7,players:["a"],relayId:"relay"},{x:0,z:0,heading:0});
  let calls=0;
  const systems=createGameSystems({wave:5,
   agents:()=>({services:false,spawns:[{id:"relay",numericId:77,model:"footman",firmware:"bad",x:10,y:0,z:10,heading:0,radius:.4,height:1.8}]}),
   combat:()=>({mode:"bot-sweep",rivalPlayerIds:{a:[]},loadouts:{a:{tankTier:2}}}),
   matchContext:context=>{calls++;expect(context.state.ext.combat!.targets.relay).toBeDefined();return {tick:context.state.tick,positions:{a:context.state.players.a!.car},inputs:{},combatEvents:context.state.ext.combat!.events};},
  });
  const state=step(world,initial,{},[],systems);
  expect(calls).toBe(1);
  expect(state.ext.combat!.players.a!.water).toBe(16);
  expect(state.ext.robots!.actors.relay).toBeDefined();
  expect(modeSessionOf(state)!.match.tick).toBe(1);
 });
});
