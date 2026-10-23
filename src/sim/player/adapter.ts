import { gameplayCommandFromEvent } from "../gameplay-contract.ts";
import type { SimSystem,SimSystemContext } from "../system-contract.ts";
import type { ExtensionKey } from "../extensions.ts";
import type { CombatEvent,CombatPlayer,StreakGrant,StreakKind } from "../combat-contract.ts";
import { createPlayer,stepPlayer } from "./system.ts";
import { createHeat,stepHeat } from "../heat/system.ts";
import { createMissions,stepMissions } from "../missions/system.ts";
import { createEconomy,stepEconomy } from "../economy/system.ts";
import { createProgression,createProgressionPlayer,stepProgression } from "../progression/system.ts";
import { createActivities,stepActivities } from "../activities/system.ts";
import { DEFAULT_CATALOG } from "./catalog.ts";
import { finiteContext } from "./common.ts";
import type { GameplayContext,GameplaySnapshot,GameplayFact,GameplayBody,GameplayEvent } from "./types.ts";
export type GameplayProvider=(context:SimSystemContext)=>GameplayContext;

export function gameplaySnapshot(context:Pick<SimSystemContext,"state">):GameplaySnapshot {
 const ext=context.state.ext;
 return {player:(ext.player as unknown as GameplaySnapshot["player"])??createPlayer(),heat:(ext.heat as unknown as GameplaySnapshot["heat"])??createHeat(),missions:(ext.missions as unknown as GameplaySnapshot["missions"])??createMissions(),economy:(ext.economy as unknown as GameplaySnapshot["economy"])??createEconomy(),progression:(ext.progression as unknown as GameplaySnapshot["progression"])??createProgression(),activities:(ext.activities as unknown as GameplaySnapshot["activities"])??createActivities()};
}
/** Combat events have one durable numeric producer cursor, including across despawns. */
export function combatFacts(events:readonly CombatEvent[]):GameplayFact[]{return events.map(e=>({id:`combat:${e.id}`,source:"combat",sequence:e.id,tick:e.tick,kind:e.kind,playerId:e.sourceId,actorId:e.targetId,amount:e.amount,detail:e.detail}));}
export const defaultGameplayProvider:GameplayProvider=context=>{
 const bodies:GameplayBody[]=Object.keys(context.state.players).sort().map(id=>{const player=context.state.players[id]!;const body=player.mode==="foot"&&player.foot?player.foot:player.car;return {id,x:body.x,y:body.y,z:body.z,mode:player.mode,speed:body.speed};});
 const commands=context.events.filter(e=>e.tick===context.state.tick).map(gameplayCommandFromEvent).filter(c=>c!==null);
 const clock=context.state.ext.clock as {day?:number;month?:number}|undefined;
 return {...DEFAULT_CATALOG,wave:2,bodies,commands,actors:[],facts:combatFacts(context.state.ext.combat?.events??[]),observations:bodies.map(body=>({playerId:body.id,seenByBad:false,seenByAssociate:false,associateWithin200:false,fog:0,protectedArea:false})),day:clock?.day??1,month:clock?.month??1};
};
export function makeGameplaySystem(key:"player"|"heat"|"missions"|"economy"|"progression"|"activities",provider:GameplayProvider=defaultGameplayProvider):SimSystem {
 return {key,step(context){
  const ctx=provider(context);finiteContext(ctx);const own=gameplaySnapshot(context),tick=context.state.tick;
  const result=key==="player"?stepPlayer(own.player,ctx,tick,own.economy,own.heat):key==="heat"?stepHeat(own.heat,ctx,tick,own.player.events):key==="missions"?stepMissions(own.missions,ctx,tick,own.heat,own.player):key==="economy"?stepEconomy(own.economy,ctx,tick,own.missions.events,own.heat,own.player.events,own.activities.events):key==="progression"?stepProgression(own.progression,ctx,tick,{missions:own.missions.events,economy:own.economy.events,player:own.player.events,activities:own.activities.events}):stepActivities(own.activities,ctx,tick,own.missions,context.state.seed);
  return {...context.state,ext:{...context.state.ext,[key]:result}};
 }};
}
export function createPlayerSystems(provider:GameplayProvider=defaultGameplayProvider):readonly SimSystem[]{return (["player","heat","missions","economy","progression","activities"] as const).map(key=>makeGameplaySystem(key,provider));}

export function combatLoadout(snapshot:GameplaySnapshot,body:GameplayBody,heading:number):CombatPlayer {
 const own=snapshot.progression.players[body.id]??createProgressionPlayer();return {...body,heading,mount:body.mode==="vehicle"?"vehicle":"foot",tankTier:own.tankTier,flowTier:own.flowTier,scannerTier:own.scannerTier,nozzle:own.nozzle,gear:own.gear,gadget:own.gadget,perks:own.perks as NonNullable<CombatPlayer["perks"]>};
}
export function streakGrants(events:readonly GameplayEvent[]):StreakGrant[]{return events.filter(e=>e.kind==="streak.grant").map(e=>({sequence:e.amount,playerId:e.playerId,kind:e.targetId as StreakKind}));}
export function gameplayEvents(snapshot:GameplaySnapshot,key:ExtensionKey):readonly GameplayEvent[]{return key in snapshot?snapshot[key as keyof GameplaySnapshot].events:[];}
export function playerView(snapshot:GameplaySnapshot,playerId:string){
 const wallet=snapshot.economy.players[playerId],heat=snapshot.heat.players[playerId],mission=snapshot.missions.players[playerId];
 return {cashCents:wallet?.cashCents??200000,runwayMonths:wallet?.runwayMonths??18,reputation:wallet?.reputation??50,threat:heat?.threat??0,vcStars:(heat?.vcQuarters??0)/4,ownedItemIds:wallet?.ownedItemIds??[],activeMission:mission&&mission.missionId?{id:mission.missionId,stepId:mission.stepId,status:mission.status,deadlineTick:mission.deadlineTick,objective:mission.stepId}:null};
}
