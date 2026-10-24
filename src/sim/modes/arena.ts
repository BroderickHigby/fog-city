import { buildWalls, circleHitsWall, inCorridor, onWater, segmentCrossesWall, type Walls } from "../boundary.ts";
import { buildSidewalkGraph, type SidewalkGraph } from "../agents/navigation.ts";
import { dcos,dsin,TAU } from "../dmath.ts";
import { circleBlocked,groundHeight,type World } from "../world.ts";
import { PROTECTED_AREAS,protectedAreaAt } from "../../content/places.ts";
import { toLatLon,toLocal } from "../../geo/project.ts";
import type { CombatEvent } from "../combat-contract.ts";
import type { AgentMotionProposal } from "../motion.ts";

export interface Arena {center:{x:number;y:number;z:number};radius:number}
const SIDES=64;
const CACHE_LIMIT=4;
const cache:{source:World;key:string;world:World}[]=[];
/** The extra metre leaves a full body inside the inscribed wall polygon. */
export function arenaContains(arena:Arena,x:number,z:number,bodyRadius=0):boolean {
 const r=arena.radius-1-bodyRadius,dx=x-arena.center.x,dz=z-arena.center.z;
 return r>=0&&dx*dx+dz*dz<=r*r;
}
function clipGraph(graph:SidewalkGraph,arena:Arena,allowed:(x:number,z:number)=>boolean,walls:Walls):SidewalkGraph {
 const nodes=graph.nodes.filter(node=>arenaContains(arena,node.x,node.z,1)&&allowed(node.x,node.z));
 const ids=new Set(nodes.map(node=>node.id));
 const edges=graph.edges.filter(edge=>ids.has(edge.a)&&ids.has(edge.b)&&edge.path.xs.every((x,i)=>arenaContains(arena,x,edge.path.zs[i]!,1)&&allowed(x,edge.path.zs[i]!)&&(i===0||!segmentCrossesWall(walls,edge.path.xs[i-1]!,edge.path.zs[i-1]!,x,edge.path.zs[i]!))));
 return buildSidewalkGraph({nodes,edges:edges.map(edge=>({id:edge.id,a:edge.a,b:edge.b,kind:edge.kind,roadId:edge.roadId??undefined,
  points:edge.path.xs.map((x,i)=>[x,edge.path.zs[i]!] as [number,number]),
  bidirectional:graph.outgoing.get(edge.b)?.some(step=>step.edgeId===edge.id&&step.to===edge.a)??false}))});
}
function arenaWalls(source:Walls|null,arena:Arena):Walls {
 const points=Array.from({length:SIDES},(_,i)=>[arena.center.x+dcos(i*TAU/SIDES)*arena.radius,arena.center.z+dsin(i*TAU/SIDES)*arena.radius]);
 const excluded=PROTECTED_AREAS.map(area=>area.polygon.map(point=>{const p=toLocal(point[0],point[1]);return [p.x,p.z];})).filter(polygon=>{
  const xs=polygon.map(p=>p[0]!),zs=polygon.map(p=>p[1]!);return Math.min(...xs)<=arena.center.x+arena.radius&&Math.max(...xs)>=arena.center.x-arena.radius&&Math.min(...zs)<=arena.center.z+arena.radius&&Math.max(...zs)>=arena.center.z-arena.radius;
 });
 const ring=buildWalls({version:1,edges:[{kind:"land",closed:true,points},...excluded.map(points=>({kind:"land",closed:true,points}))],shore:[]},null);
 if(!source)return ring;
 const cells=new Map<number,number[]>();for(const [key,indices] of source.cells)cells.set(key,[...indices]);
 const offset=source.segments.length;
 for(const [key,indices] of ring.cells){const values=cells.get(key)??[];values.push(...indices.map(index=>index+offset));cells.set(key,values);}
 return {...source,segments:[...source.segments,...ring.segments],cells};
}
/** Bounded cache of immutable per-arena world views. Never edits the source city. */
export function arenaWorld(source:World,arena:Arena):World {
 if(![arena.center.x,arena.center.y,arena.center.z,arena.radius].every(Number.isFinite)||arena.radius<6||arena.radius>300)throw new Error("Invalid arena geometry");
 const allowed=(x:number,z:number)=>{const point=toLatLon(x,z);return !protectedAreaAt([point.lat,point.lon])&&(!source.walls||!circleHitsWall(source.walls,x,z,.5)&&(!onWater(source.walls.shore,x,z)||inCorridor(source.walls,x,z)));};
 const key=`${arena.center.x}:${arena.center.y}:${arena.center.z}:${arena.radius}`;
 const old=cache.find(entry=>entry.source===source&&entry.key===key);if(old)return old.world;
 const walls=arenaWalls(source.walls,arena);
 const world:World={...source,roads:null,transit:undefined,walls,
  ...(source.sidewalks?{sidewalks:clipGraph(source.sidewalks,arena,allowed,walls)}:{}),
  ...(source.gameplay?{gameplay:{...source.gameplay,refills:source.gameplay.refills.filter(point=>arenaContains(arena,point.x,point.z)&&allowed(point.x,point.z)),anchors:source.gameplay.anchors.filter(point=>arenaContains(arena,point.x,point.z)&&allowed(point.x,point.z))}}:{})};
 cache.push({source,key,world});if(cache.length>CACHE_LIMIT)cache.shift();return world;
}
/** Reject a proposed step, rather than teleporting a robot after physics accepted it. */
export function constrainArenaMotion(world:World,arena:Arena,motion:AgentMotionProposal):AgentMotionProposal {
 const radius=motion.kind==="vehicle"?(motion.halfLength??2.2)+(motion.halfWidth??.95):motion.radius;
 if(arenaContains(arena,motion.x,motion.z,radius)&&!circleHitsWall(world.walls,motion.x,motion.z,radius)&&!segmentCrossesWall(world.walls,motion.sourceX,motion.sourceZ,motion.x,motion.z))return motion;
 return {...motion,x:motion.sourceX,y:motion.sourceY,z:motion.sourceZ,speed:0,...(motion.controls?{controls:{throttle:0,steer:0,brake:1,actions:0}}:{})};
}

/** Only conversions of admitted instance actors can create new match objectives. */
export function arenaCombatEvents(events:readonly CombatEvent[],roster:ReadonlySet<string>):CombatEvent[] {
 return events.filter(event=>event.kind!=="robot.converted"||roster.has(event.targetId));
}

/** Require an authored source with a clear, grounded standing point in its real refill radius. */
export function hasArenaRefill(world:World,arena:Arena):boolean {
 for(const source of world.gameplay?.refills??[]){
  if(![source.x,source.y,source.z,source.radius].every(Number.isFinite)||source.radius<.75)continue;
  for(let i=0;i<9;i++){
   const offset=i===0?0:Math.min(1,source.radius*.5),angle=(i-1)*TAU/8;
   const x=source.x+offset*dcos(angle),z=source.z+offset*dsin(angle),y=groundHeight(world,x,z);
   const dx=x-source.x,dy=y-source.y,dz=z-source.z;
   if(arenaContains(arena,x,z,.35)&&dx*dx+dy*dy+dz*dz<=source.radius*source.radius&&!circleBlocked(world,x,z,.35)&&!circleHitsWall(world.walls,x,z,.35))return true;
  }
 }
 return false;
}
