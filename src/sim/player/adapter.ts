import { gameplayCommandFromEvent } from "../gameplay-contract.ts";
import type { SimSystem,SimSystemContext } from "../system-contract.ts";
import type { ExtensionKey } from "../extensions.ts";
import type { CombatActor,CombatEvent,CombatPlayer,CombatState,StreakGrant,StreakKind } from "../combat-contract.ts";
import { Action } from "../contract.ts";
import { dcos,dsin } from "../dmath.ts";
import { segmentBlocked } from "../world.ts";
import { createPlayer,stepPlayer } from "./system.ts";
import { createHeat,stepHeat } from "../heat/system.ts";
import { createMissions,stepMissions } from "../missions/system.ts";
import { createEconomy,stepEconomy } from "../economy/system.ts";
import { createProgression,createProgressionPlayer,stepProgression } from "../progression/system.ts";
import { doomEffects,factionFor } from "../progression/doom-clock.ts";
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
   const target=combat?.targets[e.sourceId];
   playerId=events.find(hit=>hit.tick===e.tick&&hit.kind==="robot.blinded"&&hit.targetId===e.sourceId)?.sourceId??(target&&target.lastWaterTick>=e.tick-1?target.sourceId:"");
  }
  return [{id:`combat:${e.id}`,source:"combat" as const,sequence:e.id,tick:e.tick,kind,playerId,actorId,amount:e.amount,detail:e.detail}];
 });
}
export const defaultGameplayProvider:GameplayProvider=context=>{
 const bodies:GameplayBody[]=Object.keys(context.state.players).sort().map(id=>{const player=context.state.players[id]!;const body=player.mode==="foot"&&player.foot?player.foot:player.car;return {id,x:body.x,y:body.y,z:body.z,mode:player.mode,speed:body.speed};});
 const commands=context.events.filter(e=>e.tick===context.state.tick).map(gameplayCommandFromEvent).filter(c=>c!==null);
 const clock=context.state.ext.clock as {day?:number;month?:number}|undefined;
 const doom=gameplaySnapshot(context).progression.doom;
 return {...DEFAULT_CATALOG,wave:2,bodies,commands,actors:[],facts:combatFacts(context.state.ext.combat?.events??[],context.state.ext.combat),observations:bodies.map(body=>({playerId:body.id,seenByBad:false,seenByAssociate:false,associateWithin200:false,fog:0,protectedArea:false})),day:clock?.day??1,month:clock?.month??1,actions:Object.fromEntries(Object.keys(context.inputs).sort().map(id=>[id,context.inputs[id]!.actions])),doomPayFactor:doom?doomEffects(doom,clock?.day??1,context.state.tick).bountyMultiplier:1};
};
export interface ObservedGameplayOptions {
 wave?:number;
 actors:(context:SimSystemContext)=>readonly CombatActor[];
 facts?:(context:SimSystemContext)=>readonly GameplayFact[];
 fog?:(context:SimSystemContext)=>number;
 protectedArea?:(x:number,z:number)=>boolean;
 associateIds?:(context:SimSystemContext)=>readonly string[];
 calendar?:(context:SimSystemContext)=>{day:number;month:number;hour:number;minute:number};
}
/** Adapt observed actor bodies, never planned destinations, into mission and reward facts. */
export function createObservedGameplayProvider(options:ObservedGameplayOptions):GameplayProvider {
 return context=>{
  const base=defaultGameplayProvider(context),actors=options.actors(context),previous=gameplaySnapshot({state:context.previous}),associateIds=new Set(options.associateIds?.(context)??[]);
  const melted=new Set((context.state.ext.combat?.events??[]).filter(e=>e.kind==="robot.heap").map(e=>e.targetId));
  const visible=(a:{x:number;z:number},b:{x:number;z:number},radius:number)=>distanceSquared({...a,y:0},{...b,y:0})<=radius*radius&&!segmentBlocked(context.world,a.x,a.z,b.x,b.z);
  const observations=base.bodies.map(body=>{
   const player=context.state.players[body.id]!,pose=player.mode==="foot"&&player.foot?player.foot:player.car;
   const isWatching=!!((context.inputs[body.id]?.actions??0)&Action.watch);
   const candidates=isWatching?actors.filter(actor=>{const x=actor.x-body.x,z=actor.z-body.z,forward=x*dsin(pose.heading)-z*dcos(pose.heading);return actor.kind==="robot"&&visible(body,actor,30)&&forward>0&&forward*forward>=(x*x+z*z)*.5;}).sort((a,b)=>distanceSquared(a,body)-distanceSquared(b,body)||(a.id<b.id?-1:1)):[];
   const watchingActorId=candidates[0]?.id;const old=previous.player.players[body.id];
   return {playerId:body.id,seenByBad:actors.some(a=>a.firmware==="bad"&&(context.state.ext.combat?.targets[a.id]?.alerted||(previous.heat.players[body.id]?.threat??0)>0)&&visible(body,a,40)),seenByAssociate:actors.some(a=>associateIds.has(a.id)&&visible(body,a,40)),associateWithin200:actors.some(a=>associateIds.has(a.id)&&distanceSquared(body,a)<=40000),fog:options.fog?.(context)??0,protectedArea:options.protectedArea?.(body.x,body.z)??false,...(watchingActorId?{watchingActorId,watchedTicks:old?.watchingActorId===watchingActorId?(old.watchedTicks??0)+1:1}:{})};
  });
  return {...base,...options.calendar?.(context)??{},wave:options.wave??2,observations,facts:[...base.facts,...options.facts?.(context)??[]],actors:actors.map(actor=>({id:actor.id,firmware:actor.firmware,armoured:actor.model==="patrol"||actor.model==="walker",subtlety:actor.subtlety??1,caughtInAct:context.state.ext.combat?.attacks.some(a=>a.attackerId===actor.id&&a.active)??false,witnessedByBad:melted.has(actor.id)&&actors.some(other=>other.id!==actor.id&&other.firmware==="bad"&&visible(actor,other,30)),peopleWitnesses:melted.has(actor.id)?actors.filter(other=>other.kind==="person"&&visible(actor,other,25)).length:0}))};
 };
}
export function isMatchInstance(state:Pick<SimSystemContext["state"],"ext">):boolean {
 const modes=state.ext.modes as unknown as Record<string,unknown>|undefined;
 return !!modes&&(!!modes.match||!!modes.crowd||!!modes.royale||!!modes.vibes||["crowd","royale","vibes"].includes(String(modes.kind)));
}
export function makeGameplaySystem(key:"player"|"heat"|"missions"|"economy"|"progression"|"activities",provider:GameplayProvider=defaultGameplayProvider):SimSystem {
 return {key,step(context){
  if(isMatchInstance(context.state))return context.state;
  const ctx=provider(context);finiteContext(ctx);const own=gameplaySnapshot(context),tick=context.state.tick;
  const result=key==="player"?stepPlayer(own.player,ctx,tick,own.economy,own.heat):key==="heat"?stepHeat(own.heat,ctx,tick,own.player.events,own.missions.events):key==="missions"?stepMissions(own.missions,ctx,tick,own.heat,own.player):key==="economy"?stepEconomy(own.economy,ctx,tick,own.missions.events,own.heat,own.player.events,own.activities.events,Object.fromEntries(Object.keys(own.progression.players).sort().map(id=>[id,own.progression.players[id]!.rank]))):key==="progression"?stepProgression(own.progression,ctx,tick,{missions:own.missions.events,economy:own.economy.events,player:own.player.events,activities:own.activities.events}):stepActivities(own.activities,ctx,tick,own.missions,context.state.seed);
  return {...context.state,ext:{...context.state.ext,[key]:result}};
 }};
}
export function createPlayerSystems(provider:GameplayProvider=defaultGameplayProvider):readonly SimSystem[]{return (["player","heat","missions","economy","progression","activities"] as const).map(key=>makeGameplaySystem(key,provider));}

export function combatLoadout(snapshot:GameplaySnapshot,body:GameplayBody,heading:number):CombatPlayer {
 const own=snapshot.progression.players[body.id]??createProgressionPlayer();const perkMap:Record<string,NonNullable<CombatPlayer["perks"]>[number]>={"marine-layer":"marine","do-not-disturb":"quiet","stealth-mode":"stealth",lean:"lean",brackish:"brackish","hydrant-whisperer":"whisperer"};return {...body,heading,mount:body.mode==="vehicle"?"vehicle":"foot",tankTier:own.tankTier,flowTier:own.flowTier,scannerTier:own.scannerTier,nozzle:own.nozzle,gear:own.gear,gadget:own.gadget,perks:own.perks.flatMap(id=>perkMap[id]?[perkMap[id]!]:[]),trunk:snapshot.economy.players[body.id]?.ownedItemIds.includes("trunk-tank")??false,roofCannon:snapshot.economy.players[body.id]?.ownedItemIds.includes("roof-cannon")??false};
}
export function streakGrants(events:readonly GameplayEvent[]):StreakGrant[]{return events.filter(e=>e.kind==="streak.grant").map(e=>({sequence:e.amount,playerId:e.playerId,kind:e.targetId as StreakKind}));}
export function gameplayEvents(snapshot:GameplaySnapshot,key:ExtensionKey):readonly GameplayEvent[]{return key in snapshot?snapshot[key as keyof GameplaySnapshot].events:[];}
export function playerView(snapshot:GameplaySnapshot,playerId:string){
 const wallet=snapshot.economy.players[playerId],heat=snapshot.heat.players[playerId],mission=snapshot.missions.players[playerId];
 const profile=snapshot.progression.players[playerId]??createProgressionPlayer(),player=snapshot.player.players[playerId];
 const doom=snapshot.progression.doom;
 return {cashCents:wallet?.cashCents??200000,runwayMonths:wallet?.runwayMonths??18,reputation:wallet?.reputation??50,threat:heat?.threat??0,vcStars:(heat?.vcQuarters??0)/4,ownedItemIds:wallet?.ownedItemIds??[],rank:profile.rank,xp:profile.xp,streakPoints:profile.streakPoints,streaks:[...profile.streaks],status:player?.status??"active",bridgeUntil:player?.bridgeUntil??0,doomMonths:doom?.months??24,faction:doom?factionFor(doom,playerId):"unaffiliated",activeMission:mission&&mission.missionId?{id:mission.missionId,stepId:mission.stepId,status:mission.status,deadlineTick:mission.deadlineTick,objective:mission.stepId}:null};
}
export function canUseCombat(snapshot:GameplaySnapshot,playerId:string):boolean{return (snapshot.player.players[playerId]?.status??"active")==="active";}
