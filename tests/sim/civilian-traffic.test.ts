import { describe, expect, it } from "vitest";
import { admitPassingCars, agentsOf, populate, stepAgents, MAX_AGENTS, MAX_AGENTS_TOTAL, SPAWN_MIN_PLAYER_M, DESPAWN_RANGE_M, type AgentState } from "../../src/sim/agents.ts";
import { Action, buildWorld, createInitialState, canonicalJson, upgradeState, makeFoot, step, NEUTRAL_INPUT, type SimState } from "../../src/sim/index.ts";
import { CIVILIAN_PASS_INTERVAL_TICKS, isCivilianTraffic } from "../../src/sim/civilian-traffic.ts";
import { boardableTaxi, hailableTaxi } from "../../src/sim/ride.ts";
import { createAgentsRuntime } from "../../src/sim/agents/runtime.ts";
import { advanceProjectile, segmentWallFraction, PROJECTILE_GRAVITY } from "../../src/sim/combat/physics.ts";
import type { Projectile } from "../../src/sim/combat-contract.ts";
import { contextFromState } from "../../src/sim/combat/adapter.ts";
import { gridCity } from "./fixtures.ts";
import { nearestDrivableLane } from "../../src/sim/vehicles/follower.ts";
import { lanePath, pathPoint, endNode } from "../../src/sim/roads.ts";
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

  it.each([50,150])("crosses a connected upstream junction and passes a clear 100m-block midpoint x=%s at both cadence ticks",x=>{
    const world=gridCity();
    for(const cadence of [1800,3600]) {
      let state=empty(world,x,-15);
      const ext=admitPassingCars(world,state,cadence,state.ext.agents!);
      expect(ext.list).toHaveLength(1);
      const car=ext.list[0]!,originalQueue=canonicalJson(car.trafficRoute),id=car.id;
      expect(car.trafficRoute?.length).toBeGreaterThan(0);
      expect(Math.hypot(car.x-x,car.z+15)).toBeGreaterThanOrEqual(SPAWN_MIN_PLAYER_M);
      state={...state,tick:cadence,ext:{agents:ext}};
      let closest=Infinity,after=0,finished=false,restored=false;
      for(let tick=cadence+1;tick<cadence+1800;tick++) {
        const previous=state,previousRoute=agentsOf(previous).find(a=>a.id===id)?.trafficRoute,prevJson=JSON.stringify(previousRoute);
        const result=stepAgents(world,previous,tick)!;
        expect(JSON.stringify(previousRoute)).toBe(prevJson);
        state={...previous,tick,ext:{agents:result.ext},rng:result.rng};
        const current=agentsOf(state).find(a=>a.id===id);
        if(!current) break;
        const distance=Math.hypot(current.x-x,current.z+15);closest=Math.min(closest,distance);after=distance;
        finished ||= !current.trafficRoute;
        if(!restored&&current.conn&&current.trafficRoute?.length) {
          const copy=JSON.parse(JSON.stringify(state)) as SimState;
          expect(stepAgents(world,copy,tick+1)).toEqual(stepAgents(world,state,tick+1));restored=true;
        }
      }
      expect(closest).toBeLessThan(25);expect(after-closest).toBeGreaterThan(20);expect(finished).toBe(true);
      expect(canonicalJson(car.trafficRoute)).toBe(originalQueue);
      // Even a single-junction queue is serialized before its first turn.
      const serialized=JSON.parse(JSON.stringify({...ext,list:[car]}));expect(serialized.list[0].trafficRoute).toEqual(car.trafficRoute);
    }
  });

  it.each([[false,1800],[true,1800],[true,3600]] as const)("continues a bounded approach over connected short links, oneway=%s tick=%s",(oneway,cadence)=>{
    const nodes=Array.from({length:15},(_,i)=>({id:`s${i}`,x:(i-5)*20,z:0}));
    const edges=nodes.slice(1).map((node,i)=>({id:`e${i}`,a:nodes[i]!.id,b:node.id,kind:"residential",lanes:2,oneway,widthM:11,speedLimitMps:11.18,points:[[nodes[i]!.x,0],[node.x,0]] as [number,number][]}));
    const world=buildWorld([],{version:1,nodes,edges});
    let state=empty(world,50,-15),ext=admitPassingCars(world,state,cadence,state.ext.agents!);
    expect(ext.list).toHaveLength(1);expect(ext.list[0]!.trafficRoute!.length).toBeGreaterThanOrEqual(2);expect(ext.list[0]!.trafficRoute!.length).toBeLessThanOrEqual(8);
    if(oneway) {
      expect(ext.list[0]!.dir).toBe(1);
      expect(ext.list[0]!.trafficRoute!.every(leg=>leg.dir===1)).toBe(true);
    }
    const id=ext.list[0]!.id;state={...state,tick:cadence,ext:{agents:ext}};
    let closest=Infinity,after=0,roundtrip=false;
    for(let tick=cadence+1;tick<cadence+1800;tick++) {
      const result=stepAgents(world,state,tick)!;state={...state,tick,ext:{agents:result.ext},rng:result.rng};
      const car=agentsOf(state).find(a=>a.id===id);if(!car)break;
      const distance=Math.hypot(car.x-50,car.z+15);closest=Math.min(closest,distance);after=distance;
      if(!roundtrip&&car.conn&&car.trafficRoute?.length){
        expect(stepAgents(world,JSON.parse(JSON.stringify(state)),tick+1)).toEqual(stepAgents(world,state,tick+1));roundtrip=true;
      }
    }
    expect(roundtrip).toBe(true);expect(closest).toBeLessThan(25);expect(after-closest).toBeGreaterThan(20);
  });

  it.each([1800,3600])("approaches and passes the clear real-SF 1st St one-way frontage at tick %s",cadence=>{
    const {world}=sfWorld(),position={x:-444.61485886968313,z:515.3248125807775};
    let state=empty(world,position.x,position.z);
    const ext=admitPassingCars(world,state,cadence,state.ext.agents!);
    expect(ext.list).toHaveLength(1);
    const first=ext.list[0]!,id=first.id;
    for(const leg of [{edge:first.edge,dir:first.dir},...(first.trafficRoute??[])]) {
      const edge=world.roads!.edges[world.roads!.edgeIndex.get(leg.edge)!]!;
      if(edge.oneway) expect(leg.dir).toBe(1);
    }
    expect(Math.hypot(first.x-position.x,first.z-position.z)).toBeGreaterThanOrEqual(SPAWN_MIN_PLAYER_M);
    state={...state,tick:cadence,ext:{agents:ext}};
    let closest=Infinity,after=0,continued=false,finished=false;
    for(let tick=cadence+1;tick<cadence+1800;tick++) {
      const next=stepAgents(world,state,tick)!;state={...state,tick,ext:{agents:next.ext},rng:next.rng};
      const car=agentsOf(state).find(a=>a.id===id);if(!car)break;
      const distance=Math.hypot(car.x-position.x,car.z-position.z);closest=Math.min(closest,distance);after=distance;
      finished ||= !car.trafficRoute;
      if(!continued&&car.trafficRoute?.length) {
        expect(stepAgents(world,JSON.parse(JSON.stringify(state)),tick+1)).toEqual(stepAgents(world,state,tick+1));continued=true;
      }
    }
    expect(continued).toBe(true);expect(finished).toBe(true);
    expect(closest).toBeLessThan(25);expect(after-closest).toBeGreaterThan(20);
  },CITY_MS);

  it("waits for an occupied upstream junction, then follows its original approach after it clears",()=>{
    const world=gridCity();let state=empty(world,150,-15);
    const ext=admitPassingCars(world,state,1800,state.ext.agents!),car=ext.list[0]!;
    expect(car.trafficRoute?.length).toBeGreaterThan(0);
    const edge=world.roads!.edges[world.roads!.edgeIndex.get(car.edge)!]!,junction=world.roads!.nodes[endNode(edge,car.dir)]!;
    const target=world.roads!.edges[world.roads!.edgeIndex.get(car.next)!]!,point=pathPoint(lanePath(target,car.ndir,car.nlane),1);
    const holder:AgentState={...car,id:8,edge:car.next,dir:car.ndir,lane:car.nlane,s:1,x:point.x,z:point.z,heading:Math.atan2(point.tx,-point.tz),speed:0,node:junction.id,trafficRoute:undefined};
    state={...state,tick:1800,ext:{agents:{nextId:16,list:[car,holder]}}};
    let waited=false;
    for(let tick=1801;tick<2700;tick++) {
      const result=stepAgents(world,state,tick,new Set([holder.id]))!;state={...state,tick,ext:{agents:result.ext},rng:result.rng};
      const current=agentsOf(state).find(a=>a.id===car.id)!;
      expect(current.edge).toBe(car.edge);expect(current.ghost).toBe(0);
      if(current.speed<.05&&current.wait>0)waited=true;
    }
    expect(waited).toBe(true);
    state.ext.agents={...state.ext.agents!,list:agentsOf(state).filter(a=>a.id!==holder.id)};
    let passed=false;
    for(let tick=2700;tick<4500;tick++){
      const result=stepAgents(world,state,tick)!;state={...state,tick,ext:{agents:result.ext},rng:result.rng};
      const current=agentsOf(state).find(a=>a.id===car.id);if(current&&current.x>170)passed=true;
    }
    expect(passed).toBe(true);
  });

  it("replaces an eligible car of the same full owner while retaining a farther other-owner car",()=>{
    const world=gridCity(),state=empty(world);
    state.players.p2={...state.players.p1!,id:"p2",car:{...state.players.p1!.car,x:2000,z:2000}};
    const template=admitPassingCars(world,state,1800,state.ext.agents!).list[0]!;
    const ext={nextId:10000,list:[...Array.from({length:MAX_AGENTS-1},(_,i)=>({...template,id:100+i,kind:"person" as const,x:185+i%32,z:-20+Math.floor(i/32)})),{...template,id:8,x:175,z:250},{...template,id:16,x:2000,z:2300}]};
    state.ext.agents=ext;const result=admitPassingCars(world,state,1800,ext);
    expect(result.list.some(a=>a.id===16)).toBe(true);expect(result.list.some(a=>a.id===8)).toBe(false);
    expect(result.list.some(a=>a.id>=10000&&isCivilianTraffic(a))).toBe(true);
    expect(result.list.filter(a=>(a.x-175)**2+(a.z+15)**2<=(a.x-2000)**2+(a.z-2000)**2).length).toBe(MAX_AGENTS);
  });

  it("never evicts another player's car to exceed the local owner cap",()=>{
    const world=gridCity(),state=empty(world);
    state.players.p2={...state.players.p1!,id:"p2",car:{...state.players.p1!.car,x:2000,z:2000}};
    const template=admitPassingCars(world,state,1800,state.ext.agents!).list[0]!;
    const list=[...Array.from({length:MAX_AGENTS},(_,i)=>({...template,id:100+i,kind:"person" as const,x:185+i%32,z:-20+Math.floor(i/32)})),{...template,id:8,x:2000,z:2200}];
    const ext={nextId:10000,list};state.ext.agents=ext;
    const result=admitPassingCars(world,state,1800,ext);
    expect(result.list.some(a=>a.id===8)).toBe(true);
    expect(result.list.filter(a=>(a.x-175)**2+(a.z+15)**2<=(a.x-2000)**2+(a.z-2000)**2).length).toBeLessThanOrEqual(MAX_AGENTS);
  });

  it.each(["bound","significant","owned","hailed","ridden","watched","service","runtime","legacyclaimed"])("retains a %s vehicle when replacing owner-local population",protection=>{
    const world=gridCity(),state=empty(world),template=admitPassingCars(world,state,1800,state.ext.agents!).list[0]!;
    const protectedTaxi:AgentState={...template,id:8,x:175,z:250};
    if(protection==="service")protectedTaxi.vehicle={...state.players.p1!.car,x:175,z:250};
    if(protection==="runtime")protectedTaxi.runtimeId="special-taxi";
    if(protection==="legacyclaimed")protectedTaxi.runtimeLegacy=true;
    const ext={nextId:10000,list:[...Array.from({length:MAX_AGENTS-1},(_,i)=>({...template,id:100+i,kind:"person" as const,x:185+i%32,z:-20+Math.floor(i/32)})),protectedTaxi]};
    state.ext.agents=ext;
    const robots=createAgentsRuntime({...state,ext:{agents:{nextId:9,list:[{...protectedTaxi,runtimeId:undefined,vehicle:undefined}]}}});
    if(protection==="bound")robots.missionBindings={important:"agent:8"};
    if(protection==="significant")robots.actors["agent:8"]!.significant=true;
    if(protection==="owned")robots.actors["agent:8"]!.ownerId="p1";
    state.ext.robots=robots;
    if(protection==="hailed")state.players.p1!.hail={agentId:8,untilTick:4000};
    if(protection==="ridden")state.players.p1!.ride={agentId:8,x:175,y:0,z:250,heading:0,speed:0,goal:null,exitPending:false};
    if(protection==="watched")state.ext.player={version:1,tick:0,nextId:1,players:{p1:{status:"active",bridgeUntil:0,resumeTick:0,safehouseId:"",startupKitId:"",downRounds:0,commandSequence:0,watchingActorId:"agent:8",watchedTicks:1}},events:[]};
    expect(admitPassingCars(world,state,1800,ext).list.some(a=>a.id===8)).toBe(true);
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
