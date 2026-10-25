import { Action } from "../contract.ts";
import { playerPose } from "../ride.ts";
import { dcos,dsin } from "../dmath.ts";
import { segmentBlocked } from "../world.ts";
import { gameplayCommandFromEvent } from "../gameplay-contract.ts";
import type { SimSystem,SimSystemContext } from "../system-contract.ts";
import type { ExtensionKey } from "../extensions.ts";
import type { CombatActor,CombatEvent,CombatPlayer,CombatState,StreakGrant,StreakKind } from "../combat-contract.ts";
import { createPlayer,stepPlayer } from "./system.ts";
import { createHeat,stepHeat } from "../heat/system.ts";
import { createMissions,stepMissions } from "../missions/system.ts";
import { createEconomy,stepEconomy } from "../economy/system.ts";
import { createProgression,createProgressionPlayer,stepProgression } from "../progression/system.ts";
import { createActivities,stepActivities } from "../activities/system.ts";
import { DEFAULT_CATALOG } from "./catalog.ts";
import { finiteContext,distanceSquared } from "./common.ts";
import type { GameplayContext,GameplaySnapshot,GameplayFact,GameplayBody,GameplayEvent } from "./types.ts";
export type GameplayProvider=(context:SimSystemContext)=>GameplayContext;

export function gameplaySnapshot(context:Pick<SimSystemContext,"state">):GameplaySnapshot {
 const ext=context.state.ext;
 return {player:(ext.player as unknown as GameplaySnapshot["player"])??createPlayer(),heat:(ext.heat as unknown as GameplaySnapshot["heat"])??createHeat(),missions:(ext.missions as unknown as GameplaySnapshot["missions"])??createMissions(),economy:(ext.economy as unknown as GameplaySnapshot["economy"])??createEconomy(),progression:(ext.progression as unknown as GameplaySnapshot["progression"])??createProgression(),activities:(ext.activities as unknown as GameplaySnapshot["activities"])??createActivities()};
}
/** Combat events have one durable numeric producer cursor, including across despawns. */
export function combatFacts(events:readonly CombatEvent[],combat?:Pick<CombatState,"targets">):GameplayFact[]{
 const cones=new Set<string>();
 return [...events].sort((a,b)=>a.id-b.id).flatMap(e=>{
  let kind=e.kind;
  if(kind==="refill.complete")kind="water.refilled";
  if(kind==="robot.blinded"||kind==="vehicle.pull-over"){
   const key=`${e.tick}:${e.sourceId}:${e.targetId}`;if(cones.has(key))return [];cones.add(key);kind="cone.placed";
  }
  let playerId=e.sourceId,actorId=e.targetId;
  if(kind.startsWith("player.")){playerId=e.targetId;actorId=e.sourceId;}
  if(kind==="update.interrupted"){
   actorId=e.sourceId;
   playerId=events.find(hit=>hit.tick===e.tick&&hit.kind==="robot.blinded"&&hit.targetId===e.sourceId)?.sourceId??combat?.targets[e.sourceId]?.sourceId??"";
  }
  return [{id:`combat:${e.id}`,source:"combat" as const,sequence:e.id,tick:e.tick,kind,playerId,actorId,amount:e.amount,detail:e.detail}];
 });
}
export const defaultGameplayProvider:GameplayProvider=context=>{
 const bodies:GameplayBody[]=Object.keys(context.state.players).sort().map(id=>{const player=context.state.players[id]!;const body=playerPose(player);return {id,x:body.x,y:body.y,z:body.z,mode:player.mode,speed:body.speed};});
 const commands=context.events.filter(e=>e.tick===context.state.tick).map(gameplayCommandFromEvent).filter(c=>c!==null);
 const clock=context.state.ext.clock as {day?:number;month?:number}|undefined;
 return {...DEFAULT_CATALOG,wave:2,bodies,commands,actors:[],facts:combatFacts(context.state.ext.combat?.events??[],context.state.ext.combat),observations:bodies.map(body=>({playerId:body.id,seenByBad:false,seenByAssociate:false,associateWithin200:false,fog:0,protectedArea:false})),day:clock?.day??1,month:clock?.month??1,actions:Object.fromEntries(Object.keys(context.inputs).sort().map(id=>[id,context.inputs[id]!.actions]))};
};
export interface ObservedGameplayOptions {
 wave?:number;
 actors:(context:SimSystemContext)=>readonly CombatActor[];
 facts?:(context:SimSystemContext)=>readonly GameplayFact[];
 /** Fog density at a player's own body (x, z). */
 fog?:(context:SimSystemContext,x:number,z:number)=>number;
 protectedArea?:(x:number,z:number)=>boolean;
 associateIds?:(context:SimSystemContext)=>readonly string[];
 missionParking?:(context:SimSystemContext)=>GameplayContext["missionParking"];
 calendar?:(context:SimSystemContext)=>{day:number;month:number;hour:number;minute:number};
}
/** Adapt observed actor bodies, never planned destinations, into mission and reward facts. */
export function createObservedGameplayProvider(options:ObservedGameplayOptions):GameplayProvider {
 return context=>{
  const base=defaultGameplayProvider(context),actors=options.actors(context),previous=gameplaySnapshot({state:context.previous}),associateIds=new Set(options.associateIds?.(context)??[]);
  const melted=new Set((context.state.ext.combat?.events??[]).filter(e=>e.kind==="robot.heap").map(e=>e.targetId));
  const visible=(a:{x:number;z:number},b:{x:number;z:number},radius:number)=>distanceSquared({...a,y:0},{...b,y:0})<=radius*radius&&!segmentBlocked(context.world,a.x,a.z,b.x,b.z);
  const observations=base.bodies.map(body=>{
   const player=context.state.players[body.id]!,pose=playerPose(player);
   const isWatching=!!((context.inputs[body.id]?.actions??0)&Action.watch);
   const forward=(actor:CombatActor)=>(actor.x-body.x)*dsin(pose.heading)-(actor.z-body.z)*dcos(pose.heading);
   const angularError=(actor:CombatActor)=>{const x=actor.x-body.x,z=actor.z-body.z,d2=x*x+z*z,cross=x*dcos(pose.heading)+z*dsin(pose.heading);return d2>0?cross*cross/d2:0;};
   const candidates=isWatching?actors.filter(actor=>{const x=actor.x-body.x,z=actor.z-body.z,dot=forward(actor);return actor.kind==="robot"&&visible(body,actor,30)&&dot>0&&dot*dot>=(x*x+z*z)*.9330127018922194;}).sort((a,b)=>angularError(a)-angularError(b)||distanceSquared(a,body)-distanceSquared(b,body)||(a.id<b.id?-1:a.id>b.id?1:0)):[];
   const watchingActorId=candidates[0]?.id;const old=previous.player.players[body.id];
   const progress=context.state.ext.missions?.players[body.id],bindings=context.state.ext.robots?.missionBindings??{},actorBindings:Record<string,string>={};
   if(progress?.missionId){const shared=`${progress.missionId}:`,owned=`${body.id}:${progress.missionId}:`;for(const key of Object.keys(bindings).sort())if(key.startsWith(shared))actorBindings[key.slice(shared.length)]=bindings[key]!;for(const key of Object.keys(bindings).sort())if(key.startsWith(owned))actorBindings[key.slice(owned.length)]=bindings[key]!;}
   return {playerId:body.id,actorBindings,seenByBad:actors.some(a=>a.firmware==="bad"&&context.state.ext.combat?.targets[a.id]?.alerted&&visible(body,a,40)),seenByAssociate:actors.some(a=>associateIds.has(a.id)&&visible(body,a,40)),associateWithin200:actors.some(a=>associateIds.has(a.id)&&visible(body,a,200)),fog:options.fog?.(context,body.x,body.z)??0,protectedArea:options.protectedArea?.(body.x,body.z)??false,...(watchingActorId?{watchingActorId,watchedTicks:old?.watchingActorId===watchingActorId?(old.watchedTicks??0)+1:1}:{})};
  });
  return {...base,...options.calendar?.(context)??{},wave:options.wave??2,observations,actorBodies:actors,rustByActor:Object.fromEntries(Object.keys(context.state.ext.combat?.targets??{}).sort().map(id=>[id,context.state.ext.combat!.targets[id]!.rust])),missionParking:options.missionParking?.(context),facts:[...base.facts,...options.facts?.(context)??[]],actors:actors.map(actor=>({id:actor.id,firmware:actor.firmware,armoured:actor.model==="patrol"||actor.model==="walker",subtlety:actor.subtlety??1,caughtInAct:context.state.ext.combat?.attacks.some(a=>a.attackerId===actor.id&&a.active)??false,witnessedByBad:melted.has(actor.id)&&actors.some(other=>other.id!==actor.id&&other.firmware==="bad"&&visible(actor,other,30)),peopleWitnesses:melted.has(actor.id)?actors.filter(other=>other.kind==="person"&&visible(actor,other,25)).length:0}))};
 };
}
export function makeGameplaySystem(key:"player"|"heat"|"missions"|"economy"|"progression"|"activities",provider:GameplayProvider=defaultGameplayProvider):SimSystem {
 return {key,step(context){
  const ctx=provider(context);finiteContext(ctx);const own=gameplaySnapshot(context),tick=context.state.tick;
  const result=key==="player"?stepPlayer(own.player,ctx,tick,own.economy,own.heat):key==="heat"?stepHeat(own.heat,ctx,tick,own.player.events,own.missions.events):key==="missions"?stepMissions(own.missions,ctx,tick,own.heat,own.player,own.activities):key==="economy"?stepEconomy(own.economy,ctx,tick,own.missions.events,own.heat,own.player.events,own.activities.events):key==="progression"?stepProgression(own.progression,ctx,tick,{missions:own.missions.events,economy:own.economy.events,player:own.player.events,activities:own.activities.events}):stepActivities(own.activities,ctx,tick,own.missions,context.state.seed);
  return {...context.state,ext:{...context.state.ext,[key]:result}};
 }};
}
export function createPlayerSystems(provider:GameplayProvider=defaultGameplayProvider):readonly SimSystem[]{return (["player","heat","missions","activities","economy","progression"] as const).map(key=>makeGameplaySystem(key,provider));}

export function combatLoadout(snapshot:GameplaySnapshot,body:GameplayBody,heading:number):CombatPlayer {
 const own=snapshot.progression.players[body.id]??createProgressionPlayer();const perkMap:Record<string,NonNullable<CombatPlayer["perks"]>[number]>={"marine-layer":"marine","do-not-disturb":"quiet","stealth-mode":"stealth",lean:"lean",brackish:"brackish","hydrant-whisperer":"whisperer"};return {...body,heading,mount:body.mode==="vehicle"?"vehicle":"foot",tankTier:own.tankTier,flowTier:own.flowTier,scannerTier:own.scannerTier,nozzle:own.nozzle,gear:own.gear,gadget:own.gadget,perks:own.perks.flatMap(id=>perkMap[id]?[perkMap[id]!]:[]),trunk:snapshot.economy.players[body.id]?.ownedItemIds.includes("trunk-tank")??false,roofCannon:snapshot.economy.players[body.id]?.ownedItemIds.includes("roof-cannon")??false};
}
export function streakGrants(events:readonly GameplayEvent[]):StreakGrant[]{return events.filter(e=>e.kind==="streak.grant").map(e=>({sequence:e.amount,playerId:e.playerId,kind:e.targetId as StreakKind}));}
export function gameplayEvents(snapshot:GameplaySnapshot,key:ExtensionKey):readonly GameplayEvent[]{return key in snapshot?snapshot[key as keyof GameplaySnapshot].events:[];}
export function playerView(snapshot:GameplaySnapshot,playerId:string){
 const wallet=snapshot.economy.players[playerId],heat=snapshot.heat.players[playerId],mission=snapshot.missions.players[playerId];
 return {cashCents:wallet?.cashCents??200000,runwayMonths:wallet?.runwayMonths??18,reputation:wallet?.reputation??50,threat:heat?.threat??0,vcStars:(heat?.vcQuarters??0)/4,ownedItemIds:wallet?.ownedItemIds??[],activeMission:mission&&mission.missionId?{id:mission.missionId,stepId:mission.stepId,status:mission.status,deadlineTick:mission.deadlineTick,objective:mission.stepId}:null};
}
