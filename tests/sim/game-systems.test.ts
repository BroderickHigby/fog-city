import {describe,it,expect} from "vitest";
import {Action,buildWorld,createInitialState,createGameSystems,makeFoot,step,datan2,type SimState,type GameplayWorldData} from "../../src/sim/index.ts";
import {MISSIONS} from "../../src/content/catalog.ts";
import {missionPlace} from "../../src/sim/missions/system.ts";
import {gameplaySnapshot} from "../../src/sim/player/adapter.ts";
import {runtimeCombatActors} from "../../src/sim/agents/runtime.ts";

describe("composed gameplay runtime",()=>{
  it("stages authored mission bodies, observes accepted positions and advances watch from real controls",()=>{
    const mission=MISSIONS.find(m=>m.id==="hot-desk")!;
    const opening=mission.steps.find(s=>s.type==="trigger")!;
    if(opening.type!=="trigger")throw new Error("opening trigger missing");
    const at=missionPlace(opening.event.place),world=buildWorld([]),systems=createGameSystems({wave:2,protectedArea:()=>false});
    let state=createInitialState(world,71,["p"],{x:at.x+15,z:at.z,heading:0});
    state={...state,players:{p:{...state.players.p!,mode:"foot",foot:makeFoot(at.x,0,at.z,0)}}};
    state=step(world,state,{},[{tick:1,kind:"gameplay.command",playerId:"p",payload:{sequence:1,kind:"mission-start",targetId:"hot-desk"}}],systems);
    for(let i=0;i<4;i++)state=step(world,state,{},[],systems);
    const thief=runtimeCombatActors(state).find(a=>a.id==="mission:hot-desk:thief");
    expect(thief).toBeDefined();
    expect(state.ext.combat!.targets[thief!.id]).toBeDefined();
    const physical=state.ext.agents!.list.find(a=>a.runtimeId===thief!.id)!;
    expect({x:thief!.x,y:thief!.y,z:thief!.z}).toEqual({x:physical.x,y:physical.y,z:physical.z});
    state={...state,players:{p:{...state.players.p!,foot:makeFoot(thief!.x,0,thief!.z+10,0)}}};
    for(let tick=0;tick<190;tick++){
      const target=runtimeCombatActors(state).find(a=>a.id===thief!.id)!;
      const p=state.players.p!.foot!;
      state={...state,players:{p:{...state.players.p!,foot:{...p,heading:datan2(target.x-p.x,-(target.z-p.z))}}}};
      state=step(world,state,{p:{throttle:0,steer:0,brake:0,actions:Action.watch}},[],systems);
    }
    expect(gameplaySnapshot({state}).missions.players.p!.stepId).toBe("melt");
    expect(state.ext.clock!.elapsedTicks).toBe(state.tick);
  });
  it("turns held interact into real refill facts and wallet/mission observations",()=>{
    const gameplay:GameplayWorldData={version:1,world:"fixture",sourceSnapshot:"fixture",refills:[{id:"hydrant",kind:"hydrant",x:10,y:0,z:10,radius:3,salt:false}],anchors:[],tiles:[],territories:[]};
    const world=buildWorld([],null,null,gameplay),systems=createGameSystems();
    let state=createInitialState(world,7,["p"],{x:25,z:10,heading:0});
    state={...state,players:{p:{...state.players.p!,mode:"foot",foot:makeFoot(10,0,10,0)}}};
    state=step(world,state,{},[],systems);
    state={...state,ext:{...state.ext,combat:{...state.ext.combat!,players:{p:{...state.ext.combat!.players.p!,water:2}}}}};
    let refilled=false;
    for(let tick=0;tick<180;tick++){
      state=step(world,state,{p:{throttle:0,steer:0,brake:0,actions:Action.interact}},[],systems);
      refilled ||= state.ext.combat!.events.some(e=>e.kind==="refill.complete");
    }
    expect(refilled).toBe(true);
    expect(state.ext.combat!.players.p!.water).toBe(8);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
