import type { MissionActor } from "../../content/missions.ts";
import type { SimState } from "../contract.ts";
import { dcos, dsin, PI } from "../dmath.ts";
import { circleBlocked, groundHeight, type World } from "../world.ts";
import { pathPoint } from "../roads.ts";
import { agentsOf } from "../agents.ts";
import type { RuntimeSpawn } from "./runtime.ts";
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
  for(const [id,candidate] of Object.entries(value.definitions)){
    if(!validId(id)||!candidate||typeof candidate!=="object")return null;
    const actor=candidate as MissionActor;
    if(!["badRobot","goodRobot","rogueTaxi","goodTaxi","crew"].includes(actor.kind)||actor.members!==undefined&&(!Array.isArray(actor.members)||actor.members.length>64||!actor.members.every(validId)))return null;
    definitions[id]={...actor,...(actor.members?{members:[...actor.members]}:{})};
  }
  return {missionId:event.targetId,stepId:value.stepId,actorIds:[...value.actors],definitions,place:{...place},radius:Math.min(100,value.radius as number)};
}

/** Produces clear, stable actor identities; the core allocates numeric IDs and admits bodies. */
export function planMissionActors(world:World,sim:Readonly<SimState>,stage:MissionStage,graph?:SidewalkGraph):MissionActorPlan {
  const result:MissionActorPlan={actors:[],bindings:{},groups:{},blocked:[]};
  const visited=new Set<string>();
  const physical=[...agentsOf(sim),...Object.values(sim.players).map(p=>p.mode==="foot"&&p.foot?p.foot:p.car)];
  const clear=(x:number,z:number,radius:number)=>!circleBlocked(world,x,z,radius)&&physical.every(p=>Math.hypot(p.x-x,p.z-z)>radius+2)&&result.actors.every(p=>Math.hypot(p.x-x,p.z-z)>radius+p.radius+.5);
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
    const taxi=definition.kind==="rogueTaxi"||definition.kind==="goodTaxi";
    const radius=taxi?1.1:.4;
    const candidates=graph?.nodes.filter(n=>Math.hypot(n.x-stage.place.x,n.z-stage.place.z)<=stage.radius).map(n=>({x:n.x,z:n.z,id:n.id})).sort((a,b)=>Math.hypot(a.x-stage.place.x,a.z-stage.place.z)-Math.hypot(b.x-stage.place.x,b.z-stage.place.z)||compare(a.id,b.id))??[];
    if(taxi){
      candidates.length=0;
      for(const road of world.roads?.edges??[])if(road.drivable)for(let direction=0;direction<2;direction++)for(let lane=0;lane<road.lanePaths[direction]!.length;lane++){
        if(!road.laneSafe[direction]![lane])continue;
        const path=road.lanePaths[direction]![lane]!;
        for(let at=0;at<=path.len;at+=5){const point=pathPoint(path,at);if(Math.hypot(point.x-stage.place.x,point.z-stage.place.z)<=stage.radius)candidates.push({x:point.x,z:point.z,id:`road:${road.id}:${direction}:${lane}:${at}`});}
      }
      candidates.sort((a,b)=>Math.hypot(a.x-stage.place.x,a.z-stage.place.z)-Math.hypot(b.x-stage.place.x,b.z-stage.place.z)||compare(a.id,b.id));
    }
    if(!taxi)for(let ring=1;ring<=4;ring++)for(let index=0;index<16;index++){
      const angle=index*2*PI/16,d=Math.min(stage.radius*.85,2+ring*2);
      candidates.push({x:stage.place.x+dsin(angle)*d,z:stage.place.z+dcos(angle)*d,id:`fallback:${ring}:${index}`});
    }
    const spot=candidates.find(p=>clear(p.x,p.z,radius));
    if(!spot){result.blocked.push(alias);return [];}
    result.actors.push({id:stable,model:taxi?"robotaxi":definition.archetype?.toLowerCase().includes("trundle")?"trundle":"footman",firmware:definition.kind==="goodRobot"||definition.kind==="goodTaxi"?"good":"bad",x:spot.x,y:groundHeight(world,spot.x,spot.z),z:spot.z,heading:0,radius,height:definition.archetype?.toLowerCase().includes("trundle")?.7:1.8,significant:true});
    return [stable];
  }
  for(const id of [...stage.actorIds].sort(compare))place(id,new Set());
  result.blocked=[...new Set(result.blocked)].sort(compare);
  result.actors.sort((a,b)=>compare(a.id,b.id));
  return result;
}
