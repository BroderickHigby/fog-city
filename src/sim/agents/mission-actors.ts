import { BOT_TELLS } from "../../content/botTells.ts";
import type { MissionActor } from "../../content/missions.ts";
import { sortedIds, type SimState } from "../contract.ts";
import { dcos, dsin, datan2, PI } from "../dmath.ts";
import { circleBlocked, groundHeight, segmentBlocked, type World } from "../world.ts";
import { circleHitsWall } from "../boundary.ts";
import { carBox } from "../car.ts";
import { boxDistance } from "../dodge.ts";
import { pathPoint } from "../roads.ts";
import { AGENT_SPEC, ROBOTAXI_BODY } from "../agents.ts";
import { serviceEntryClear, type ServiceBlocker } from "./service-runtime.ts";
import { agentsRuntimeOf, type RuntimeSpawn } from "./runtime.ts";
import type { SidewalkGraph } from "./navigation.ts";

export interface MissionStage {
  missionId: string;
  stepId: string;
  actorIds: readonly string[];
  definitions: Readonly<Record<string, MissionActor>>;
  place: { x: number; y: number; z: number };
  radius: number;
}
export type ActorBlueprint = Omit<RuntimeSpawn, "numericId">;
export interface MissionActorPlan {
  actors: ActorBlueprint[];
  bindings: Record<string, string>;
  groups: Record<string, string[]>;
  blocked: string[];
}
const magnitude=(x:number,z:number)=>Math.sqrt(x*x+z*z);
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const validId=(id:unknown):id is string=>typeof id==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id)&&!Object.hasOwn(Object.prototype,id);

/** Gameplay emits a JSON stage description; malformed authored data fails closed. */
export function decodeMissionStage(event: {kind:string;targetId:string;detail:string}): MissionStage|null {
  if(event.kind!=="mission.stage"||!validId(event.targetId))return null;
  let raw:unknown;try{raw=JSON.parse(event.detail);}catch{return null;}
  if(!raw||typeof raw!=="object")return null;
  const value=raw as Record<string,unknown>,place=value.place as MissionStage["place"]|undefined;
  if(!validId(value.stepId)||!Array.isArray(value.actors)||value.actors.length>64||!value.actors.every(validId)||!value.definitions||typeof value.definitions!=="object"||Array.isArray(value.definitions)||!place||![place.x,place.y,place.z,value.radius].every(v=>typeof v==="number"&&Number.isFinite(v))||(value.radius as number)<=0)return null;
  const definitions:Record<string,MissionActor>={};
  for(const id of sortedIds(value.definitions as Record<string,unknown>)){
    const candidate=(value.definitions as Record<string,unknown>)[id];
    if(!validId(id)||!candidate||typeof candidate!=="object")return null;
    const actor=candidate as MissionActor;
    if(!["badRobot","goodRobot","rogueTaxi","goodTaxi","crew"].includes(actor.kind)||actor.members!==undefined&&(!Array.isArray(actor.members)||actor.members.length>64||!actor.members.every(validId)))return null;
    definitions[id]={...actor,...(actor.members?{members:[...actor.members]}:{})};
  }
  return {missionId:event.targetId,stepId:value.stepId,actorIds:[...value.actors],definitions,place:{...place},radius:Math.min(100,value.radius as number)};
}

/** Produces clear, stable actor identities; the core allocates numeric IDs and admits bodies. */
export function planMissionActors(world:World,sim:Readonly<SimState>,stage:MissionStage,graph?:SidewalkGraph,placementAllowed:(x:number,z:number)=>boolean=()=>true,reservedBodies:readonly ServiceBlocker[]=[]):MissionActorPlan {
  const result:MissionActorPlan={actors:[],bindings:{},groups:{},blocked:[]};
  const visited=new Set<string>();
  const runtime=agentsRuntimeOf(sim);
  // Only accepted physical poses and this batch's reservations block admission.
  const physical:ServiceBlocker[]=(sim.ext.agents?.list??[]).map(a=>a.kind==="robotaxi"?{...a,halfLength:a.halfLength??ROBOTAXI_BODY.halfLength,halfWidth:a.halfWidth??ROBOTAXI_BODY.halfWidth}:{...a,radius:a.radius??AGENT_SPEC[a.kind].radius});
  for(const id of sortedIds(sim.players)){const p=sim.players[id]!,box=carBox(p.car);physical.push({...box,halfLength:box.hl,halfWidth:box.hw});if(p.mode==="foot"&&p.foot)physical.push({...p.foot,radius:.35});}
  physical.push(...reservedBodies);
  const clear=(x:number,z:number,radius:number)=>placementAllowed(x,z)&&!circleHitsWall(world.walls,x,z,radius)&&!circleBlocked(world,x,z,radius)&&[...physical,...result.actors].every(p=>p.halfLength!==undefined&&p.halfWidth!==undefined?boxDistance(x,z,p.x,p.z,dsin(p.heading??0),-dcos(p.heading??0),p.halfLength,p.halfWidth)>=radius+.5:magnitude(p.x-x,p.z-z)>radius+Math.max(2,p.radius??.4));
  let walkingCandidates:{x:number;z:number;id:string}[]|undefined;
  const walkCandidates=()=>{
    if(walkingCandidates)return walkingCandidates;
    walkingCandidates=graph?.nodes.filter(n=>magnitude(n.x-stage.place.x,n.z-stage.place.z)<=stage.radius).map(n=>({x:n.x,z:n.z,id:n.id})).sort((a,b)=>magnitude(a.x-stage.place.x,a.z-stage.place.z)-magnitude(b.x-stage.place.x,b.z-stage.place.z)||compare(a.id,b.id))??[];
    for(let ring=1;ring<=Math.min(16,Math.floor(stage.radius/3));ring++)for(let index=0;index<8*ring;index++){
      const angle=index*2*PI/(8*ring),d=ring*3;
      walkingCandidates.push({x:stage.place.x+dsin(angle)*d,z:stage.place.z+dcos(angle)*d,id:`fallback:${ring}:${index}`});
    }
    return walkingCandidates;
  };
  function place(alias:string,stack:Set<string>):string[]{
    if(stack.has(alias)){result.blocked.push(alias);return [];}
    const definition=stage.definitions[alias];if(!definition){result.blocked.push(alias);return [];}
    const stable=`mission:${stage.missionId}:${alias}`;
    result.bindings[alias]=stable;
    if(definition.kind==="crew"&&definition.members?.length){
      const next=new Set(stack);next.add(alias);
      const members=[...new Set(definition.members)].sort(compare).flatMap(member=>place(member,next));result.groups[alias]=members;return members;
    }
    if(visited.has(alias))return [stable];visited.add(alias);
    // Stable actors persist between stage observations; placement is only for new identities.
    if(runtime?.actors[stable])return [stable];
    const profile=BOT_TELLS.archetypes.find(profile=>profile.id===definition.archetype);
    const taxi=definition.kind==="rogueTaxi"||definition.kind==="goodTaxi";
    const radius=taxi?1.1:.4;
    const candidates:{x:number;z:number;id:string;heading?:number}[]=taxi?[]:walkCandidates();
    if(taxi){
      candidates.length=0;
      for(const road of world.roads?.edges??[])if(road.drivable)for(let direction=0;direction<2;direction++)for(let lane=0;lane<road.lanePaths[direction]!.length;lane++){
        if(!road.laneSafe[direction]![lane])continue;
        const path=road.lanePaths[direction]![lane]!;
        for(let at=0;at<=path.len;at+=5){const point=pathPoint(path,at);if(magnitude(point.x-stage.place.x,point.z-stage.place.z)<=stage.radius)candidates.push({x:point.x,z:point.z,heading:datan2(point.tx,-point.tz),id:`road:${road.id}:${direction}:${lane}:${at}`});}
      }
      candidates.sort((a,b)=>magnitude(a.x-stage.place.x,a.z-stage.place.z)-magnitude(b.x-stage.place.x,b.z-stage.place.z)||compare(a.id,b.id));
      // A staged taxi is parked, so it need not begin on a routable traffic lane.
      // Keep the authored radius and require a clear hull plus a usable hood approach.
      const player=sim.players[sortedIds(sim.players)[0]??""];
      const facing=player?(player.mode==="foot"&&player.foot?player.foot:player.car):stage.place;
      for(let ring=0;ring<=Math.min(16,Math.floor(stage.radius/3));ring++)for(let index=0;index<Math.max(1,8*ring);index++){
        const angle=index*2*PI/Math.max(1,8*ring),x=stage.place.x+dsin(angle)*ring*3,z=stage.place.z+dcos(angle)*ring*3,heading=datan2(facing.x-x,-(facing.z-z));
        for(let turn=0;turn<4;turn++)candidates.push({x,z,heading:heading+turn*PI/2,id:`park:${ring}:${index}:${turn}`});
      }
    }
    const spot=candidates.find(p=>{
      if(!taxi)return clear(p.x,p.z,radius);
      if(!placementAllowed(p.x,p.z)||!serviceEntryClear(world,{...p,heading:p.heading??0},[...physical,...result.actors],ROBOTAXI_BODY.halfLength,ROBOTAXI_BODY.halfWidth,ROBOTAXI_BODY.height))return false;
      const heading=p.heading??0,front={x:p.x+dsin(heading)*(ROBOTAXI_BODY.halfLength+1.2),z:p.z-dcos(heading)*(ROBOTAXI_BODY.halfLength+1.2)};
      return clear(front.x,front.z,.4)&&!segmentBlocked(world,p.x,p.z,front.x,front.z)&&Math.abs(groundHeight(world,front.x,front.z)-groundHeight(world,p.x,p.z))<=.4;
    });
    if(!spot){result.blocked.push(alias);return [];}
    result.actors.push({id:stable,model:taxi?"robotaxi":profile?.model==="sidewalk-bot"||definition.archetype?.toLowerCase().includes("trundle")?"trundle":"footman",...(definition.archetype?{archetype:definition.archetype}:{}),...(definition.level?{level:definition.level}:{}),firmware:definition.kind==="goodRobot"||definition.kind==="goodTaxi"?"good":"bad",x:spot.x,y:groundHeight(world,spot.x,spot.z),z:spot.z,heading:spot.heading??0,radius,height:taxi?ROBOTAXI_BODY.height:profile?.model==="sidewalk-bot"||definition.archetype?.toLowerCase().includes("trundle")?.7:1.8,...(taxi?{halfLength:ROBOTAXI_BODY.halfLength,halfWidth:ROBOTAXI_BODY.halfWidth}:{}),significant:true,...(definition.posted?{posted:true}:{}),...(definition.archetype==="UpdateRelay"?{rustScale:.2}:{})});
    return [stable];
  }
  for(const id of [...stage.actorIds].sort(compare))place(id,new Set());
  result.blocked=[...new Set(result.blocked)].sort(compare);
  result.actors.sort((a,b)=>compare(a.id,b.id));
  return result;
}
