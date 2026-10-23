import { MISSIONS } from "../content/catalog.ts";
import { STARTUP_KITS } from "../content/kits.ts";
import { DEFAULT_CATALOG } from "../sim/player/catalog.ts";
import { gameplaySnapshot } from "../sim/player/adapter.ts";
import { createPlayerStatus } from "../sim/player/system.ts";
import { createWallet } from "../sim/economy/system.ts";
import { createProgressionPlayer, rankForXp } from "../sim/progression/system.ts";
import { createMissionProgress } from "../sim/missions/system.ts";
import { isGameplayId } from "../sim/gameplay-contract.ts";
import type { SimState } from "../sim/contract.ts";
import type { JsonObject } from "../sim/extensions.ts";
import { SaveError, type Json, type ProgressionDocument } from "./store.ts";

type RecordData=Record<string,Json>;
function object(value:unknown):RecordData {if(!value||typeof value!=="object"||Array.isArray(value))throw new SaveError("invalid","Invalid progression record");return value as RecordData;}
function number(value:Json|undefined,min=0,max=Number.MAX_SAFE_INTEGER,integer=true):number {if(typeof value!=="number"||!Number.isFinite(value)||value<min||value>max||integer&&!Number.isSafeInteger(value))throw new SaveError("invalid","Invalid progression amount");return value;}
function id(value:Json|undefined,allowed?:ReadonlySet<string>,empty=false):string {if(empty&&value==="")return "";if(!isGameplayId(value)||allowed&&!allowed.has(value))throw new SaveError("invalid","Unknown progression identifier");return value;}
function list(value:Json|undefined,allowed?:ReadonlySet<string>):string[] {if(!Array.isArray(value)||value.length>10000)throw new SaveError("invalid","Invalid progression list");const result=value.map(entry=>id(entry,allowed));if(new Set(result).size!==result.length)throw new SaveError("invalid","Duplicate progression identifier");return result;}
function shape(value:RecordData,keys:readonly string[]):void {if(Object.keys(value).some(key=>!keys.includes(key)))throw new SaveError("invalid","Unknown progression field");}
function enumId<T extends string>(value:Json|undefined,allowed:readonly T[]):T {if(typeof value!=="string"||!allowed.includes(value as T))throw new SaveError("invalid","Invalid equipment selection");return value as T;}
const missionIds=new Set(MISSIONS.map(m=>m.id));
const kitIds=new Set(STARTUP_KITS.map(k=>k.id));
const siteIds=new Set(DEFAULT_CATALOG.sites.map(s=>s.id));
const activityIds=new Set(DEFAULT_CATALOG.activities.map(a=>a.id));

/** Canonical host validator: only durable domain fields can cross the save boundary. */
export function validateSavedProgression(data:ProgressionDocument):ProgressionDocument {
  shape(data as RecordData,["wallet","progression","missions","activities","player","profile"]);
  const wallet=object(data.wallet),progression=object(data.progression),missions=object(data.missions),activities=object(data.activities),player=object(data.player);
  shape(wallet,["cashCents","runwayMonths","reputation","ownedItemIds","ownedSiteIds","settledModeIds"]);
  shape(progression,["xp","rank","tankTier","flowTier","scannerTier","nozzle","gadget","gear","perks","streaks","streakPoints","banked","achievements"]);
  shape(missions,["completedIds","rewardedIds"]);shape(activities,["completedIds"]);shape(player,["startupKitId","safehouseId","downRounds"]);
  const banked=object(progression.banked),cleanBank:RecordData={};for(const [key,value]of Object.entries(banked))cleanBank[id(key)]=number(value);
  const xp=number(progression.xp),clean:RecordData={
    wallet:{cashCents:number(wallet.cashCents),runwayMonths:number(wallet.runwayMonths,0,18,false),reputation:number(wallet.reputation,0,100,false),ownedItemIds:list(wallet.ownedItemIds),ownedSiteIds:list(wallet.ownedSiteIds,siteIds),settledModeIds:list(wallet.settledModeIds??[])},
    progression:{xp,rank:rankForXp(xp),tankTier:number(progression.tankTier,0,2),flowTier:number(progression.flowTier,0,1),scannerTier:number(progression.scannerTier,1,4),nozzle:enumId(progression.nozzle,["standard","pressure"]),gadget:enumId(progression.gadget,["balloon","sprinkler","speaker"]),gear:enumId(progression.gear,["none","boots","airplane"]),perks:list(progression.perks),streaks:list(progression.streaks),streakPoints:number(progression.streakPoints),banked:cleanBank,achievements:list(progression.achievements??[])},
    missions:{completedIds:list(missions.completedIds,missionIds),rewardedIds:list(missions.rewardedIds)},activities:{completedIds:list(activities.completedIds,activityIds)},
    player:{startupKitId:id(player.startupKitId,kitIds,true),safehouseId:id(player.safehouseId,siteIds,true),downRounds:number(player.downRounds)},
  };
  if(data.profile!==undefined){
    const profile=object(data.profile);shape(profile,["version","nameParts","look","preferences","lifetime","achievements"]);
    if(profile.version!==2)throw new SaveError("incompatible","Unsupported profile version");
    const nameParts=list(profile.nameParts);if(nameParts.length!==0&&nameParts.length!==2)throw new SaveError("invalid","Invalid generated name");
    const look=object(profile.look),preferences=object(profile.preferences),lifetime=object(profile.lifetime),cleanLook:RecordData={},cleanLifetime:RecordData={};
    shape(look,["body","hair","top","bottom"]);for(const [key,value]of Object.entries(look))cleanLook[key]=id(value);
    shape(preferences,["masterVolume","musicVolume","effectsVolume","reducedMotion","highContrast","textScale"]);
    for(const flag of ["reducedMotion","highContrast"])if(typeof preferences[flag]!=="boolean")throw new SaveError("invalid","Invalid profile preference");
    for(const [key,value]of Object.entries(lifetime))cleanLifetime[id(key)]=number(value);
    clean.profile={version:2,nameParts,look:cleanLook,preferences:{masterVolume:number(preferences.masterVolume,0,1,false),musicVolume:number(preferences.musicVolume,0,1,false),effectsVolume:number(preferences.effectsVolume,0,1,false),reducedMotion:preferences.reducedMotion!,highContrast:preferences.highContrast!,textScale:number(preferences.textScale,.8,2,false)},lifetime:cleanLifetime,achievements:list(profile.achievements)};
  }
  return clean;
}

export function captureProgression(state:SimState,playerId:string,profile?:JsonObject):ProgressionDocument {
  const snapshot=gameplaySnapshot({state}),wallet=snapshot.economy.players[playerId]??createWallet(),progression=snapshot.progression.players[playerId]??createProgressionPlayer(),player=snapshot.player.players[playerId]??createPlayerStatus(),mission=snapshot.missions.players[playerId]??createMissionProgress();
  const {commandSequence:_command,streakSequence:_streak,...durable}=progression;
  return validateSavedProgression({
    wallet:{cashCents:wallet.cashCents,runwayMonths:wallet.runwayMonths,reputation:wallet.reputation,ownedItemIds:wallet.ownedItemIds,ownedSiteIds:wallet.ownedSiteIds,settledModeIds:(wallet as typeof wallet&{settledModeIds?:string[]}).settledModeIds??[]},
    progression:durable as unknown as Json,missions:{completedIds:mission.completedIds,rewardedIds:mission.rewardedIds},activities:{completedIds:snapshot.activities.players[playerId]?.completedIds??[]},
    player:{startupKitId:player.startupKitId,safehouseId:player.safehouseId,downRounds:player.downRounds},...(profile?{profile}:{}),
  });
}

/** Apply only to a freshly created, initialized world: traffic/combat state is never loaded. */
export function restoreProgression(fresh:SimState,data:ProgressionDocument,playerId:string):SimState {
  const clean=validateSavedProgression(data),snapshot=gameplaySnapshot({state:fresh}),wallet=object(clean.wallet),progression=object(clean.progression),player=object(clean.player),mission=object(clean.missions),activities=object(clean.activities);
  const activity=snapshot.activities.players[playerId];if(!activity)throw new SaveError("invalid","Initialize player systems before restoring");
  const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
  return {...fresh,ext:{...fresh.ext,
    economy:{...snapshot.economy,players:{...snapshot.economy.players,[playerId]:{...createWallet(),...copy(wallet)}}} as unknown as typeof snapshot.economy,
    progression:{...snapshot.progression,players:{...snapshot.progression.players,[playerId]:{...createProgressionPlayer(),...copy(progression)}}} as unknown as typeof snapshot.progression,
    player:{...snapshot.player,players:{...snapshot.player.players,[playerId]:{...createPlayerStatus(),...copy(player),status:"active",bridgeUntil:0,resumeTick:0}}} as unknown as typeof snapshot.player,
    missions:{...snapshot.missions,players:{...snapshot.missions.players,[playerId]:{...createMissionProgress(),...copy(mission)}}} as unknown as typeof snapshot.missions,
    activities:{...snapshot.activities,players:{...snapshot.activities.players,[playerId]:{...activity,...copy(activities),activeCardId:"",activeActivityId:"",cardUntilTick:0}}} as unknown as typeof snapshot.activities,
  }};
}
