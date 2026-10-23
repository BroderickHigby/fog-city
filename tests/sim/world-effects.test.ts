import { describe,it,expect } from "vitest";
import { buildWorld,createInitialState,step } from "../../src/sim/index.ts";
import { createClockSystem,gameTime } from "../../src/sim/clock/calendar.ts";
import { createWorldEffectsSystem } from "../../src/sim/vehicles/world-effects.ts";
import { createPlayer } from "../../src/sim/player/system.ts";
import { createEconomy } from "../../src/sim/economy/system.ts";
import type { GameplayEvent } from "../../src/sim/gameplay-contract.ts";
const world=buildWorld([]);
const initial=()=>createInitialState(world,1,["p"],{x:0,z:0,heading:0});
const event=(kind:string,id=1,targetId="fidi-desk",amount=0):GameplayEvent=>({id,tick:0,kind,playerId:"p",targetId,amount,detail:""});
const effects=createWorldEffectsSystem({wave:3,sites:[{id:"fidi-desk",kind:"safehouse",wave:2,x:12,y:0,z:0,radius:20}]});
const systems=[createClockSystem(),effects];
describe("accepted world effects",()=>{
  it("keeps the accepted respawn through player movement and never repeats its event",()=>{
    let state=initial();state.players.p!.exitPending=true;state.ext.player={...createPlayer(),events:[event("player.respawn")]};
    state=step(world,state,{},[],systems);
    expect(state.players.p!.mode).toBe("foot");
    expect(state.players.p!.exitPending).toBe(false);
    expect(state.players.p!.foot!.x).toBe(12);
    state={...state,players:{...state.players,p:{...state.players.p!,foot:{...state.players.p!.foot!,x:16}}}};
    state=step(world,state,{},[],systems);
    expect(state.players.p!.foot!.x).toBe(16);
  });
  it("advances an accepted sleep eight game hours once",()=>{
    let state=initial();state.ext.economy={...createEconomy(),events:[event("player.slept",1,"fidi-desk",8)]};
    state=step(world,state,{},[],systems);
    expect(gameTime(state).hour).toBe(16);expect(state.ext.clock!.elapsedTicks).toBe(28801);
    state=step(world,state,{},[],systems);expect(state.ext.clock!.elapsedTicks).toBe(28802);
  });
  it("moves an acqui-hired player to FiDi the next morning",()=>{
    let state=initial();state.ext.clock={version:1,elapsedTicks:12*3600};
    state.ext.player={...createPlayer(),events:[event("player.acqui-hired"),event("player.respawn",2,"unowned")]};
    state=step(world,state,{},[],systems);
    expect(state.players.p!.foot!.x).toBe(12);expect(gameTime(state).hour).toBe(8);expect(gameTime(state).dayIndex).toBe(1);
  });
  it("keeps free-roam recovery out of a match instance",()=>{
    let state=initial();state.ext.modes={match:{}};state.ext.player={...createPlayer(),events:[event("player.respawn")]};
    state=step(world,state,{},[],systems);expect(state.players.p!.mode).toBe("vehicle");expect(state.ext.vehicles).toBeUndefined();
  });
});
