import {createMissions} from "../../../src/sim/missions/system.ts";
import { describe, expect, it } from "vitest";
import { Action, type SimState } from "../../../src/sim/contract.ts";
import { makeFoot } from "../../../src/sim/foot.ts";
import { createInitialState } from "../../../src/sim/step.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { canonicalJson } from "../../../src/sim/serialize.ts";
import { contextFromState } from "../../../src/sim/combat/adapter.ts";
import { createCombatState } from "../../../src/sim/combat/system.ts";
import { agentsCombatOptions, createAgentsSystem } from "../../../src/sim/agents/systems.ts";
import { createAgentsRuntime, planAgentRuntime, runtimeCombatActors, type RuntimeSpawn } from "../../../src/sim/agents/runtime.ts";

const world=buildWorld([]);
const neutral={throttle:0,steer:0,brake:0,actions:0};
function initial():SimState {
  const state=createInitialState(world,17,["p"],{x:0,z:-1,heading:0});
  state.players.p!.mode="foot";
  state.players.p!.foot=makeFoot(0,0,-1,0);
  return state;
}
function spawn(id="r",extra:Partial<RuntimeSpawn>={}):RuntimeSpawn {
  return {id,numericId:10,model:"footman",firmware:"bad",x:0,y:0,z:0,heading:0,radius:.4,height:1.8,...extra};
}
function freeze<T>(value:T):T {if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function withRobots(state:SimState,runtime:ReturnType<typeof createAgentsRuntime>):SimState {
  return {...state,ext:{...state.ext,robots:runtime as unknown as NonNullable<SimState["ext"]["robots"]>}};
}

describe("authoritative agent runtime",()=>{
  it("keeps firmware and protected classifications stable and state serializable",()=>{
    const sim=initial(),spawns=[spawn(),spawn("child",{numericId:11,model:"person",firmware:"none",child:true}),spawn("pigeon",{numericId:12,model:"pigeon",firmware:"none"})];
    const old=JSON.stringify(sim),runtime=planAgentRuntime(world,freeze(sim),{},{spawns});
    expect(JSON.stringify(sim)).toBe(old);
    const actors=runtimeCombatActors(withRobots(sim,runtime));
    expect(actors.find(a=>a.id==="r")).toMatchObject({kind:"robot",firmware:"bad"});
    expect(actors.find(a=>a.id==="child")).toMatchObject({kind:"person",child:true});
    expect(actors.find(a=>a.id==="pigeon")).toMatchObject({kind:"animal",protected:true});
    expect(()=>canonicalJson(withRobots(sim,runtime))).not.toThrow();
    expect(JSON.parse(JSON.stringify(runtime))).toEqual(runtime);
  });

  it("rejects duplicate stable or centrally allocated IDs before entering the simulation",()=>{
    expect(()=>createAgentsRuntime(initial(),{spawns:[spawn(),spawn()]})).toThrow("Duplicate");
    expect(()=>planAgentRuntime(world,initial(),{},{spawns:[spawn(),spawn("s")]})).toThrow("Duplicate numeric");
  });

  it("changes observed positions only after core accepts a bounded proposal",()=>{
    let sim=initial();
    const system=createAgentsSystem(()=>({spawns:[spawn("good",{firmware:"good",z:10})]}));
    const ctx={world,previous:sim,state:sim,inputs:{},events:[]};
    const prepared=system.prepare(ctx),runtime=prepared.state.ext.robots as unknown as ReturnType<typeof createAgentsRuntime>;
    const before=runtime.actors.good!,move=prepared.motions[0]!;
    expect(before.z).toBe(10);
    expect(Math.hypot(move.x-before.x,move.z-before.z)).toBeLessThanOrEqual(1.6/60+.00001);
    sim=prepared.state;
    const rejected=system.step({...ctx,state:sim});
    expect((rejected.ext.robots as unknown as typeof runtime).actors.good!.z).toBe(10);
    const accepting=createAgentsSystem(()=>({observedBodies:[{id:"good",x:move.x,y:move.y,z:move.z,heading:move.heading,speed:move.speed}]}));
    const accepted=accepting.step({...ctx,state:sim});
    expect((accepted.ext.robots as unknown as typeof runtime).actors.good!.z).toBe(move.z);
  });

  it("does not treat an empty-tank fire button as an observed attack",()=>{
    const sim=initial(),runtime=planAgentRuntime(world,sim,{p:{...neutral,actions:Action.fire}},{spawns:[spawn()]});
    expect(runtime.actors.r!.brain!.mode).toBe("disguised");
    expect(runtime.attacks).toEqual([]);
  });

  it("alerts only the robot that actually received a scan event",()=>{
    let sim=initial();
    const context=contextFromState(world,sim);
    sim.ext.combat=createCombatState(17,context);
    sim.ext.combat.events=[{id:1,tick:0,kind:"robot.alert",sourceId:"p",targetId:"r",amount:0,detail:""}];
    const runtime=planAgentRuntime(world,sim,{},{spawns:[spawn(),spawn("s",{numericId:11,x:5})]});
    expect(runtime.actors.r!.brain!.mode).toBe("alerted");
    expect(runtime.actors.s!.brain!.mode).toBe("disguised");
  });

  it("queues one monotonic combat request at windup start, leaving its effect to combat",()=>{
    let sim=initial();
    sim.ext.combat=createCombatState(17,contextFromState(world,sim));
    sim.ext.combat.events=[{id:1,tick:0,kind:"robot.alert",sourceId:"p",targetId:"r",amount:0,detail:""}];
    const requests=[];
    for(let tick=0;tick<35;tick++){
      sim={...sim,tick};
      const runtime=planAgentRuntime(world,sim,{},{spawns:[spawn()]});
      requests.push(...runtime.attacks);
      sim=withRobots(sim,runtime);
      sim.ext.combat={...sim.ext.combat!,events:[]};
    }
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({id:"r:1",sequence:1,attackerId:"r",targetId:"p",kind:"shove"});
    expect(sim.ext.combat!.players.p!.water).toBe(8);
  });

  it("freezes seized actors and never passes abstract actors to combat",()=>{
    let sim=initial();
    sim=withRobots(sim,createAgentsRuntime(sim,{spawns:[spawn(),spawn("remote",{numericId:11,x:500,significant:true})]}));
    sim.ext.combat=createCombatState(17,contextFromState(world,sim,agentsCombatOptions(sim)));
    sim.ext.combat.targets.r!.phase="seized";
    const runtime=planAgentRuntime(world,sim,{},{spawns:[spawn()]});
    expect(runtime.proposals.find(p=>p.id==="r")).toMatchObject({speed:0,x:0,z:0});
    expect(runtimeCombatActors(withRobots(sim,runtime)).map(a=>a.id)).toEqual(["r"]);
  });

  it("holds detached dogs safely and raises drones at bounded vertical speed",()=>{
    const runtime=planAgentRuntime(world,initial(),{},{spawns:[spawn("dog",{firmware:"none",model:"dog",ownerId:"missing"}),spawn("drone",{numericId:11,model:"drone",firmware:"good"})]});
    expect(runtime.proposals.find(p=>p.id==="dog")?.speed).toBe(0);
    expect(runtime.proposals.find(p=>p.id==="drone")?.y).toBeLessThanOrEqual(2/60);
  });

  it("is independent of input actor ordering across a multi-tick replay",()=>{
    function run(reverse:boolean){
      let sim=initial();
      const rows=[spawn(),spawn("good",{numericId:11,firmware:"good",x:10}),spawn("bird",{numericId:12,model:"pigeon",firmware:"none",x:20})];
      for(let tick=0;tick<160;tick++){
        sim={...sim,tick};
        sim=withRobots(sim,planAgentRuntime(world,sim,{p:{...neutral,actions:tick%60===0?Action.horn:0}},{spawns:reverse?[...rows].reverse():rows}));
      }
      return canonicalJson(sim);
    }
    expect(run(true)).toBe(run(false));
  });
});

describe("mission runtime admission",()=>{
  it("allocates staged actor IDs once and retains accepted bodies through the post-movement hook",()=>{
    let sim=initial(),allocations=0;
    sim.ext.missions={...createMissions(),events:[{id:1,tick:sim.tick,playerId:"p",amount:0,kind:"mission.stage",targetId:"first",detail:JSON.stringify({stepId:"meet",actors:["bad"],definitions:{bad:{kind:"badRobot"}},place:{x:10,y:0,z:0},radius:20})}]};
    const allocate=(state:Readonly<SimState>,ids:readonly string[])=>{allocations++;return {state:state as SimState,ids:Object.fromEntries(ids.map(id=>[id,30]))};};
    const system=createAgentsSystem(()=>({}),allocate);
    const context={world,previous:sim,state:sim,inputs:{},events:[]};
    const prepared=system.prepare(context);
    expect(prepared.motions).toHaveLength(1);
    expect(allocations).toBe(1);
    sim=system.step({...context,state:prepared.state});
    const actors=runtimeCombatActors(sim);
    expect(actors).toHaveLength(1);
    expect(actors[0]!.id).toBe("mission:first:bad");
    expect((sim.ext.robots as unknown as ReturnType<typeof createAgentsRuntime>).missionBindings["first:bad"]).toBe(actors[0]!.id);
  });
});


describe("authored mission behavior tells",()=>{
  it("shows the thief's empty bag and uses its snatch goal instead of a generic forced update",()=>{
    const sim=initial();
    const runtime=planAgentRuntime(world,sim,{},{spawns:[spawn("thief",{archetype:"snatcher",level:1}),spawn("shopper",{numericId:11,archetype:"errandFootman",firmware:"good",z:-.5})]});
    expect(runtime.actors.thief).toMatchObject({bag:"empty",tellIntensity:1});
    expect(runtime.actors.thief!.tellIds).toContain("emptyBag");
    expect(runtime.actors.shopper!.bag).toBe("full");
    expect(runtime.attacks[0]?.kind).toBe("snatch");
  });
});
