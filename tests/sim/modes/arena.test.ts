import { expect,it } from "vitest";
import { circleHitsWall } from "../../../src/sim/boundary.ts";
import { buildWorld } from "../../../src/sim/world.ts";
import { buildSidewalkGraph } from "../../../src/sim/agents/navigation.ts";
import { arenaCombatEvents,arenaContains,arenaWorld,constrainArenaMotion,hasArenaRefill } from "../../../src/sim/modes/arena.ts";
import { createBotSweep,stepBotSweep } from "../../../src/sim/modes/botsweep.ts";
import { createInitialState,step } from "../../../src/sim/step.ts";
import { hashState } from "../../../src/sim/serialize.ts";
import { createMatchState,stepMatch } from "../../../src/sim/modes/match.ts";
import { modeSessionOf } from "../../../src/sim/modes/session.ts";
import { PI } from "../../../src/sim/dmath.ts";

const arena={center:{x:0,y:0,z:0},radius:120};
const gameplay={version:1 as const,world:"fixture",sourceSnapshot:"test",refills:[{id:"water",kind:"hydrant" as const,x:0,y:0,z:10,radius:3,salt:false},{id:"other-water",kind:"hydrant" as const,x:1000,y:0,z:1010,radius:3,salt:false}],anchors:[],tiles:[],territories:[]};
const config={id:"a",seed:7,players:["p"],spawn:{x:0,z:0,heading:0}};
const createLocalMatch=createBotSweep,stepLocalMatch=stepBotSweep;
it("keeps city data intact and clips complete sidewalk paths, not just their endpoints",()=>{
 const source=buildWorld([]);source.sidewalks=buildSidewalkGraph({nodes:[{id:"a",x:0,z:0},{id:"b",x:10,z:0},{id:"c",x:110,z:0},{id:"d",x:200,z:0}],edges:[
  {id:"ab",a:"a",b:"b",kind:"sidewalk",points:[[0,0],[10,0]]},
  {id:"bc",a:"b",b:"c",kind:"sidewalk",points:[[10,0],[130,0],[110,0]]},
  {id:"cd",a:"c",b:"d",kind:"sidewalk",points:[[110,0],[200,0]]},
 ]});
 const graph=source.sidewalks,originalEdges=[...graph.edges],derived=arenaWorld(source,arena);
 expect(derived).not.toBe(source);expect(derived.roads).toBeNull();expect(derived.transit).toBeUndefined();
 expect(derived.sidewalks!.edges.map(e=>e.id)).toEqual(["ab"]);expect(derived.sidewalks!.nodeById.has("d")).toBe(false);
 expect(source.sidewalks).toBe(graph);expect(source.sidewalks.edges).toEqual(originalEdges);expect(source.walls).toBeNull();
});
it("suppresses ambient traffic throughout the match and retains exactly its roster",()=>{
 const source=buildWorld([],{version:1,nodes:[{id:"a",x:-300,z:0},{id:"b",x:300,z:0}],edges:[{id:"ab",a:"a",b:"b",kind:"residential",lanes:2,oneway:false,points:[[-300,0],[300,0]]}]});
 source.gameplay=gameplay;
 const roads=source.roads;let state=createLocalMatch(source,config);
 expect(state.ext.agents?.list??[]).toEqual([]);
 for(let i=0;i<30;i++)state=stepLocalMatch(source,state,{});
 expect(state.ext.agents!.list).toHaveLength(121);expect(state.ext.agents!.list.every(a=>a.runtimeId?.startsWith("mission:mode-a:"))).toBe(true);
 expect(source.roads).toBe(roads);expect(state.ext.economy).toBeUndefined();
});
it("stops the actual player car at the local arena wall",()=>{
 const world=arenaWorld(buildWorld([]),arena);let state=createInitialState(world,1,["p"],{x:108,z:0,heading:PI/2});
 state.players.p!.car.speed=20;
 for(let i=0;i<120;i++)state=step(world,state,{p:{throttle:1,steer:0,brake:0,actions:0}},[],[]);
 const car=state.players.p!.car;expect(car.x).toBeGreaterThan(108);expect(car.x).toBeLessThan(120);expect(Math.abs(car.z)).toBeLessThan(2);
});
it("rejects escaping robot proposals while leaving allowed physical steps intact",()=>{
 const world=arenaWorld(buildWorld([]),arena),motion={id:"robot",numericId:1,legacyId:null,kind:"walker" as const,x:120,y:0,z:0,sourceX:118,sourceY:0,sourceZ:0,heading:PI/2,speed:2,radius:.4,height:1.8};
 const stopped=constrainArenaMotion(world,arena,motion);expect(stopped.x).toBe(118);expect(stopped.speed).toBe(0);expect(motion.x).toBe(120);
 const inside={...motion,x:50,sourceX:49};expect(constrainArenaMotion(world,arena,inside)).toBe(inside);
});
it("replays interleaved arenas identically, including after bounded cache eviction",()=>{
 const world=buildWorld([],null,null,gameplay);let alone=createLocalMatch(world,config),mixed=createLocalMatch(world,config),other=createLocalMatch(world,{...config,id:"b",spawn:{x:1000,z:1000,heading:0}});
 const before=hashState(mixed),old=arenaWorld(world,arena);
 for(let i=0;i<6;i++)arenaWorld(world,{center:{x:2000+i*300,y:0,z:0},radius:120});
 expect(arenaWorld(world,arena)).not.toBe(old);expect(hashState(mixed)).toBe(before);
 for(let i=0;i<20;i++){alone=stepLocalMatch(world,alone,{});other=stepLocalMatch(world,other,{});mixed=stepLocalMatch(world,mixed,{});}
 expect(hashState(mixed)).toBe(hashState(alone));expect(modeSessionOf(other)!.match.id).toBe("b");
 expect(mixed.ext.agents!.list.every(a=>arenaContains(arena,a.x,a.z,a.radius))).toBe(true);
});

it("adds converted roster actors as objectives while rejecting off-arena conversions",()=>{
 const match=createMatchState({id:"arena",mode:"botSweep",seed:1,players:["p"],badRobotIds:["bad"],relayId:"relay"});
 const events=[{id:1,tick:1,kind:"robot.converted",sourceId:"p",targetId:"outsider",amount:0,detail:""},{id:2,tick:1,kind:"robot.converted",sourceId:"p",targetId:"member",amount:0,detail:""}];
 const result=stepMatch(match,{tick:1,positions:{},combatEvents:arenaCombatEvents(events,new Set(["bad","relay","member"]))});
 expect(result.remainingBad).toEqual(["bad","member"]);expect(result.phase).toBe("active");
});

it("preserves city walls and their immutable cell indices when adding the arena ring",()=>{
 const source=buildWorld([],null,{version:1,edges:[{kind:"land",closed:false,points:[[20,-50],[20,50]]}],shore:[]});
 const old=source.walls!,before=[...old.cells].map(([key,value])=>[key,[...value]]),derived=arenaWorld(source,arena);
 expect(derived.walls!.segments.length).toBeGreaterThan(old.segments.length);expect(circleHitsWall(derived.walls,20,0,.5)).toBe(true);
 expect([...old.cells].map(([key,value])=>[key,[...value]])).toEqual(before);expect(source.walls).toBe(old);
});

it("rejects arenas without a usable authored refill rather than inventing water",()=>{
 const dry=buildWorld([]);expect(()=>createLocalMatch(dry,config)).toThrow("accessible water refill");
 const outside=buildWorld([],null,null,{...gameplay,refills:[{...gameplay.refills[0]!,x:500}]});
 expect(hasArenaRefill(arenaWorld(outside,arena),arena)).toBe(false);expect(()=>createLocalMatch(outside,config)).toThrow("accessible water refill");
 const high=buildWorld([],null,null,{...gameplay,refills:[{...gameplay.refills[0]!,y:100}]});
 expect(hasArenaRefill(arenaWorld(high,arena),arena)).toBe(false);
 expect(hasArenaRefill(arenaWorld(buildWorld([],null,null,gameplay),arena),arena)).toBe(true);
});
