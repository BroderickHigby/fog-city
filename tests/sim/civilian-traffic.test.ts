import { describe, expect, it } from "vitest";
import { admitPassingCars, agentsOf, populate, stepAgents, MAX_AGENTS_TOTAL, SPAWN_MIN_PLAYER_M, DESPAWN_RANGE_M, type AgentState } from "../../src/sim/agents.ts";
import { Action, createInitialState, canonicalJson, upgradeState, makeFoot, step, NEUTRAL_INPUT, type SimState } from "../../src/sim/index.ts";
import { CIVILIAN_PASS_INTERVAL_TICKS, isCivilianTraffic } from "../../src/sim/civilian-traffic.ts";
import { boardableTaxi, hailableTaxi } from "../../src/sim/ride.ts";
import { createAgentsRuntime } from "../../src/sim/agents/runtime.ts";
import { advanceProjectile, segmentWallFraction, PROJECTILE_GRAVITY } from "../../src/sim/combat/physics.ts";
import type { Projectile } from "../../src/sim/combat-contract.ts";
import { contextFromState } from "../../src/sim/combat/adapter.ts";
import { gridCity } from "./fixtures.ts";
import { nearestDrivableLane } from "../../src/sim/vehicles/follower.ts";
import { lanePath, pathPoint } from "../../src/sim/roads.ts";
import { sfWorld, CITY_MS } from "./world/load.ts";
import { readJson } from "../helpers.ts";

const idle = {p1:{...NEUTRAL_INPUT}};
function empty(world: ReturnType<typeof gridCity>, x=175,z=-15): SimState {
  const state=createInitialState(world,17,["p1"],{x,z,heading:0});
  return {...state,ext:{agents:{nextId:1,list:[]}}};
}

describe("ordinary passing traffic",()=>{
  it("admits on simulation cadence with deterministic routes and existing positive IDs",()=>{
    const world=gridCity(), state=empty(world);
    expect(admitPassingCars(world,state,1799,state.ext.agents!).list).toHaveLength(0);
    const ext=admitPassingCars(world,state,1800,state.ext.agents!);
    expect(ext.list).toHaveLength(1);
    expect(isCivilianTraffic(ext.list[0]!)).toBe(true);
    expect(canonicalJson(ext)).toBe(canonicalJson(admitPassingCars(world,state,1800,state.ext.agents!)));
    expect(state.ext.agents!.list).toHaveLength(0);
    // The previous car has departed; an unblocked later interval admits a fresh stable ID.
    const departed={nextId:ext.nextId,list:[]};
    const again=admitPassingCars(world,{...state,ext:{agents:departed}},3600,departed);
    expect(again.list).toHaveLength(1);
    expect(again.list[0]!.id).toBeGreaterThan(ext.list[0]!.id);
  });

  it("stays bounded, starts outside the normal pop-in distance, and culls traffic after a district move",()=>{
    const world=gridCity(),state=empty(world),ext=admitPassingCars(world,state,1800,state.ext.agents!);
    const car=ext.list[0]!;
    expect(Math.hypot(car.x-state.players.p1!.car.x,car.z-state.players.p1!.car.z)).toBeGreaterThanOrEqual(SPAWN_MIN_PLAYER_M);
    expect(ext.list.length).toBeLessThanOrEqual(MAX_AGENTS_TOTAL);
    const culled=populate(world,ext,state.rng,[{x:6000,z:6000}],state.seed,false);
    expect(culled.ext.list.some(a=>a.id===car.id)).toBe(false);
    const full={...ext,list:Array.from({length:MAX_AGENTS_TOTAL},(_,i)=>({...car,id:i*8+7,x:car.x+(i%4),z:car.z}))};
    expect(admitPassingCars(world,state,3600,full).list.length).toBeLessThanOrEqual(MAX_AGENTS_TOTAL);
  });

  it("cannot be hailed, boarded or classified as a convertible/rustable robot",()=>{
    const world=gridCity(),state=empty(world), ext=admitPassingCars(world,state,1800,state.ext.agents!);
    const car=ext.list[0]!; car.speed=0;
    state.ext.agents=ext;
    expect(boardableTaxi(world,state,car.x,car.z)).toBeNull();
    expect(hailableTaxi(world,state,car.x,car.z,"p1")).toBeNull();
    expect(createAgentsRuntime(state).actors[`agent:${car.id}`]).toBeUndefined();
    expect(contextFromState(world,state).actors.some(actor=>actor.id===`agent:${car.id}`)).toBe(false);
  });

  it.each(["water","cone","balloon"] as const)("the civilian body blocks %s before a robot behind it without becoming a damage target",kind=>{
    const world=gridCity(),state=empty(world),ext=admitPassingCars(world,state,1800,state.ext.agents!);
    const car=ext.list[0]!;
    Object.assign(car,{x:0,y:0,z:0,heading:0,pitch:0});state.ext.agents=ext;
    const context=contextFromState(world,state,{extraActors:[{id:"behind",kind:"robot",firmware:"bad",x:5,y:0,z:0,radius:.4,height:2,heading:0,speed:0}]});
    const projectile:Projectile={id:1,kind,ownerId:"p1",x:-5,y:1,z:0,vx:600,vy:PROJECTILE_GRAVITY/120,vz:0,distance:0,range:30,bornTick:0,volume:.08,salt:false,vehicle:false,rustRate:1};
    const result=advanceProjectile(projectile,context);
    expect(result.blocked).toBe(true);expect(result.hit).toBeNull();
    expect(context.actors.some(actor=>actor.id===`agent:${car.id}`)).toBe(false);
    expect(result.projectile.x).toBeCloseTo(-1,9);
  });

  it("does not block the empty corners of a rotated car's axis-aligned bounds",()=>{
    const world=gridCity(),state=empty(world),ext=admitPassingCars(world,state,1800,state.ext.agents!);
    Object.assign(ext.list[0]!,{x:0,y:0,z:0,heading:Math.PI/4,pitch:0});state.ext.agents=ext;
    const wall=contextFromState(world,state).walls.find(wall=>wall.id===`civilian:${ext.list[0]!.id}`)!;
    expect(wall.footprint).toHaveLength(4);
    // A short ray crosses the broad-phase top-right corner, beyond the actual diagonal body.
    const z=wall.maxZ-.05,x=wall.maxX-.05;
    expect(segmentWallFraction({x:x-.03,y:1,z},{x:x+.03,y:1,z},wall)).toBeNull();
    expect(segmentWallFraction({x:-5,y:1,z:0},{x:5,y:1,z:0},wall)).not.toBeNull();
  });

  it("keeps a passenger already riding a version14 ID7 body and lets them exit",()=>{
    const world=gridCity(),state=empty(world),ext=admitPassingCars(world,state,1800,state.ext.agents!);
    const car=ext.list[0]!;
    expect(car.id).toBe(7);
    state.ext.agents=ext;
    state.players.p1!.ride={agentId:car.id,x:car.x,y:car.y,z:car.z,heading:car.heading,speed:0,goal:null,exitPending:false};
    let restored=upgradeState({...state,version:14});
    expect(restored.players.p1!.ride!.agentId).toBe(7);
    restored=step(world,restored,{p1:{...NEUTRAL_INPUT,actions:Action.enterExit}});
    for(let tick=0;tick<300&&restored.players.p1!.ride;tick++)restored=step(world,restored,idle);
    expect(restored.players.p1!.ride).toBeNull();
    expect(restored.players.p1!.mode).toBe("foot");
    expect(restored.ext.agents!.list.some(a=>a.id===7)).toBe(true);
  });

  it("uses the normal yielding controller when a person stands in its lane",()=>{
    const world=gridCity(),state=empty(world),ext=admitPassingCars(world,state,1800,state.ext.agents!);
    expect(ext.list.length).toBe(1);
    const car=ext.list[0]!;
    const original=state.players.p1!.car;
    state.players.p1!.mode="foot";
    state.players.p1!.foot=makeFoot(car.x+Math.sin(car.heading)*12,0,car.z-Math.cos(car.heading)*12,0);
    state.players.p1!.car={...original,x:-30,z:-30};
    state.ext.agents=ext;
    for(let i=0;i<300;i++) {
      state.tick++;
      const next=stepAgents(world,state,state.tick);
      if(next) state.ext.agents=next.ext;
      const a=agentsOf(state).find(a=>a.id===car.id)!;
      const foot=state.players.p1!.foot!;
      expect(Math.hypot(a.x-foot.x,a.z-foot.z)).toBeGreaterThan(3);
    }
    expect(agentsOf(state).find(a=>a.id===car.id)!.speed).toBeLessThan(.2);
  });

  it("approaches and passes real SF frontage at the playable spawn and after a district move",()=>{
    const {world}=sfWorld();
    const manifest=readJson<{spawn:{x:number;z:number;heading:number}}>("public/tiles/sf/manifest.json");
    const movedLane=nearestDrivableLane(world.roads!,{x:-500,z:650})!;
    const moved=pathPoint(lanePath(world.roads!.edges[movedLane.edge]!,movedLane.dir,0),movedLane.s);
    const positions=[manifest.spawn,{x:moved.x+moved.tz*9,z:moved.z-moved.tx*9,heading:0}];
    const evidence=[];
    for(const position of positions){
      let state=empty(world,position.x,position.z);
      const ext=admitPassingCars(world,state,1800,state.ext.agents!);
      expect(ext.list.length,JSON.stringify(position)).toBe(1);
      const agent=ext.list[0]!,id=agent.id;
      const start=Math.hypot(agent.x-position.x,agent.z-position.z);
      state.ext.agents=ext;
      let closest=start,after=start;
      for(let tick=1801;tick<1801+CIVILIAN_PASS_INTERVAL_TICKS;tick++){
        // Normal traffic reducer includes road junctions, static/actor bodies, clearances and retirement.
        const result=stepAgents(world,state,tick)!;
        state={...state,tick,ext:{...state.ext,agents:result.ext},rng:result.rng};
        const car=agentsOf(state).find(a=>a.id===id);
        if(!car) break;
        after=Math.hypot(car.x-position.x,car.z-position.z); closest=Math.min(closest,after);
      }
      expect(closest,JSON.stringify(position)).toBeLessThan(25);
      expect(after-closest,JSON.stringify(position)).toBeGreaterThan(20);
      evidence.push({position,start,closest,after});
    }
    console.log(JSON.stringify(evidence));
  },CITY_MS);
});
