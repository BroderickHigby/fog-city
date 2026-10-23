import { describe, expect, it } from "vitest";
import { buildWorld } from "../../../src/sim/world.ts";
import { hashState } from "../../../src/sim/serialize.ts";
import { createLocalMatch, localMatchView, stepLocalMatch } from "../../../src/sim/modes/playable.ts";
import { modeSessionOf } from "../../../src/sim/modes/session.ts";
import { agentsRuntimeOf } from "../../../src/sim/agents/runtime.ts";
import { defaultMatchContext } from "../../../src/sim/modes/systems.ts";

const world=buildWorld([],null,null,{version:1,world:"fixture",sourceSnapshot:"test",refills:[{id:"water",kind:"hydrant",x:0,y:0,z:10,radius:3,salt:false}],anchors:[],tiles:[],territories:[]});
const config={id:"local-1",mode:"botSweep" as const,seed:7,playerId:"p1",spawn:{x:0,z:0,heading:0}};
describe("local playable match composition",()=>{
  it("admits every objective through physical actor preparation and keeps free-roam state absent",()=>{
    const initial=createLocalMatch(world,config),session=modeSessionOf(initial)!;
    expect(initial.ext.economy).toBeUndefined();expect(session.match.remainingBad).toHaveLength(14);
    expect(session.match.relayId).toBe("mission:mode-local-1:update-relay");
    const state=stepLocalMatch(world,initial,{}),runtime=agentsRuntimeOf(state)!;
    for(const id of [...session.match.remainingBad,session.match.relayId]){
      expect(runtime.actors[id]).toBeDefined();expect(state.ext.agents!.list.some(actor=>actor.runtimeId===id)).toBe(true);
    }
    expect(localMatchView(state)?.objectivesRemaining).toBe(15);
    expect(initial.tick).toBe(0);expect(initial.ext.robots).toBeUndefined();
  });
  it("replays identical controls with bots and preserves an unrelated saved profile",()=>{
    const matchConfig={...config,mode:"cleanStreets" as const},saved={cash:42,completed:["hot-desk"]},before=JSON.stringify(saved);
    let a=createLocalMatch(world,matchConfig),b=createLocalMatch(world,matchConfig);
    for(let tick=0;tick<30;tick++){const inputs={p1:{throttle:.2,steer:.1,brake:0,actions:0}};a=stepLocalMatch(world,a,inputs);b=stepLocalMatch(world,b,inputs);}
    expect(hashState(a)).toBe(hashState(b));expect(JSON.stringify(saved)).toBe(before);
    const bot=a.players["rival:local-1"]!;expect(bot.mode).toBe("foot");
    expect(modeSessionOf(a)?.match.players).toHaveProperty("rival:local-1");
  });
  it("never treats missing objective placement as a completed match",()=>{
    const blocked=buildWorld([{tileId:"t",ground:null,buildings:[{id:"all",footprint:[[-200,-200],[200,-200],[200,200],[-200,200]],baseY:0,topY:20}]}]);
    expect(()=>createLocalMatch(blocked,config)).toThrow();
    expect(()=>createLocalMatch(world,{...config,id:"__proto__"})).toThrow();
  });
  it("restores downed players through the normal clear spawn path",()=>{
    let state=createLocalMatch(world,config);
    state=stepLocalMatch(world,state,{});
    const slot=modeSessionOf(state)!;slot.match.events=[{id:1,tick:state.tick,kind:"match.respawn-request",playerId:"p1",targetId:"",amount:4,detail:"team-spawn"}];
    state.players.p1!.car.x=80;
    const restored=stepLocalMatch(world,state,{});
    expect(Math.abs(restored.players.p1!.car.x)).toBeLessThan(20);
    expect(state.players.p1!.car.x).toBe(80);
  });
  it("credits the player who interrupted an update, without rewarding an abandoned channel",()=>{
    const state=stepLocalMatch(world,createLocalMatch(world,config),{});
    state.ext.combat!.events=[
      {id:1,tick:state.tick,kind:"robot.blinded",sourceId:"p1",targetId:"bad",amount:180,detail:""},
      {id:2,tick:state.tick,kind:"update.interrupted",sourceId:"bad",targetId:"good",amount:0,detail:"interrupted"},
      {id:3,tick:state.tick,kind:"update.interrupted",sourceId:"abandoned",targetId:"good",amount:0,detail:"interrupted"},
    ];
    const observed=defaultMatchContext({world,previous:state,state,inputs:{},events:[]});
    expect(observed.combatEvents![1]!.sourceId).toBe("p1");
    expect(observed.combatEvents![2]!.sourceId).toBe("abandoned");
  });
});
