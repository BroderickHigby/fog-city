import { MISSIONS } from "../content/catalog.ts";
import { STARTUP_KITS } from "../content/kits.ts";
import { DEFAULT_CATALOG } from "../sim/player/catalog.ts";
import { gameplaySnapshot } from "../sim/player/adapter.ts";
import { createPlayerStatus } from "../sim/player/system.ts";
import { createWallet } from "../sim/economy/system.ts";
import { createProgressionPlayer, rankForXp } from "../sim/progression/system.ts";
import { createMissionProgress } from "../sim/missions/system.ts";
import { createDoomClock } from "../sim/progression/doom-clock.ts";
import { STREAK_REWARDS } from "../sim/progression/rules.ts";
import { DAY_TICKS,gameTime } from "../sim/clock/calendar.ts";
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
  shape(wallet,["cashCents","runwayMonths","reputation","ownedItemIds","ownedSiteIds","settledModeIds","microclimatePaid"]);
  shape(progression,["xp","rank","tankTier","flowTier","scannerTier","nozzle","gadget","gear","perks","streaks","streakPoints","banked","earnedStreaks","achievements","doom"]);
  shape(missions,["completedIds","rewardedIds"]);shape(activities,["completedIds","officeHoursBookings","officeHoursSequence","officeHoursCooldownTicks"]);shape(player,["startupKitId","safehouseId","downRounds"]);
  if(wallet.microclimatePaid!==undefined&&typeof wallet.microclimatePaid!=="boolean")throw new SaveError("invalid","Invalid subscription payment");
  const banked=object(progression.banked),cleanBank:RecordData={};for(const [key,value]of Object.entries(banked))cleanBank[id(key)]=number(value);
  const xp=number(progression.xp),clean:RecordData={
    wallet:{cashCents:number(wallet.cashCents),runwayMonths:number(wallet.runwayMonths,0,18,false),reputation:number(wallet.reputation,0,100,false),ownedItemIds:list(wallet.ownedItemIds),ownedSiteIds:list(wallet.ownedSiteIds,siteIds),settledModeIds:list(wallet.settledModeIds??[]),...(wallet.microclimatePaid!==undefined?{microclimatePaid:wallet.microclimatePaid===true}: {})},
    progression:{xp,rank:rankForXp(xp),tankTier:number(progression.tankTier,0,2),flowTier:number(progression.flowTier,0,1),scannerTier:number(progression.scannerTier,1,4),nozzle:enumId(progression.nozzle,["standard","pressure","wide"]),gadget:enumId(progression.gadget,["balloon","sprinkler","speaker"]),gear:enumId(progression.gear,["none","boots","airplane","microclimate"]),perks:list(progression.perks),streaks:list(progression.streaks),streakPoints:number(progression.streakPoints),banked:cleanBank,...(progression.earnedStreaks!==undefined?{earnedStreaks:list(progression.earnedStreaks,new Set(STREAK_REWARDS.map(reward=>reward.runtimeId)))}:{}),achievements:list(progression.achievements??[])},
    missions:{completedIds:list(missions.completedIds,missionIds),rewardedIds:list(missions.rewardedIds)},activities:{completedIds:list(activities.completedIds,activityIds)},
    player:{startupKitId:id(player.startupKitId,kitIds,true),safehouseId:id(player.safehouseId,siteIds,true),downRounds:number(player.downRounds)},
  };
  if(activities.officeHoursBookings!==undefined){
    const allowance=object(activities.officeHoursBookings);shape(allowance,["day","count"]);
    (clean.activities as RecordData).officeHoursBookings={day:number(allowance.day),count:number(allowance.count,0,2)};
  }
  if(activities.officeHoursSequence!==undefined)(clean.activities as RecordData).officeHoursSequence=number(activities.officeHoursSequence);
  if(activities.officeHoursCooldownTicks!==undefined)(clean.activities as RecordData).officeHoursCooldownTicks=number(activities.officeHoursCooldownTicks,0,60*720);
  if(progression.doom!==undefined){
    const doom=object(progression.doom),factions=object(doom.factions),cleanFactions:RecordData={};
    shape(doom,["months","resets","winters","stopped","factions","winterRemainingTicks"]);
    for(const [playerId,value]of Object.entries(factions)){const faction=object(value);shape(faction,["pauser","accelerator"]);cleanFactions[id(playerId)]={pauser:number(faction.pauser),accelerator:number(faction.accelerator)};}
    if(doom.stopped!==undefined&&typeof doom.stopped!=="boolean")throw new SaveError("invalid","Invalid world clock flag");
    (clean.progression as RecordData).doom={months:number(doom.months,-Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER,false),resets:number(doom.resets),winters:number(doom.winters),stopped:doom.stopped??false,factions:cleanFactions,...(doom.winterRemainingTicks!==undefined?{winterRemainingTicks:number(doom.winterRemainingTicks,0,DAY_TICKS)}:{})};
  }
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
  const {commandSequence:_command,streakSequence:_streak,pendingStreak:_pending,streakHeld:_held,...durable}=progression;
  const economy=snapshot.economy as typeof snapshot.economy&{settledModeIds?:string[]},worldProgression=snapshot.progression as typeof snapshot.progression&{doom?:{months:number;resets:number;winters:number;stopped?:boolean;winterUntilTick?:number;winterUntilDay?:number;factions:Record<string,{pauser:number;accelerator:number}>}};
  const doom=worldProgression.doom;
  const activity=snapshot.activities.players[playerId],day=gameTime(state).dayIndex;
  const winterRemaining=doom?Math.min(DAY_TICKS,Math.max(0,(doom.winterUntilTick??0)-state.tick),doom.winterUntilDay===undefined||doom.winterUntilDay<0?DAY_TICKS:Math.max(0,(doom.winterUntilDay-day)*DAY_TICKS)):0;
  return validateSavedProgression({
    wallet:{cashCents:wallet.cashCents,runwayMonths:wallet.runwayMonths,reputation:wallet.reputation,ownedItemIds:wallet.ownedItemIds,ownedSiteIds:wallet.ownedSiteIds,settledModeIds:economy.settledModeIds??[],...(wallet.microclimatePaidWeek!==undefined?{microclimatePaid:wallet.microclimatePaidWeek===gameTime(state).gameWeek}: {})},
    progression:{...durable,...(doom?{doom:{months:doom.months,resets:doom.resets,winters:doom.winters,stopped:doom.stopped??false,factions:doom.factions,...(winterRemaining>0?{winterRemainingTicks:winterRemaining}:{})}}:{})} as unknown as Json,missions:{completedIds:mission.completedIds,rewardedIds:mission.rewardedIds},activities:{completedIds:activity?.completedIds??[],...(activity?.officeHoursBookings?{officeHoursBookings:{day,count:activity.officeHoursBookings.day===day?activity.officeHoursBookings.count:0},officeHoursSequence:activity.officeHoursSequence??0,officeHoursCooldownTicks:Math.max(0,Math.min(60*720,(activity.cooldowns?.["office-hours"]??0)-state.tick))}:{})},
    player:{startupKitId:player.startupKitId,safehouseId:player.safehouseId,downRounds:player.downRounds},...(profile?{profile}:{}),
  });
}

/** Apply only to a freshly created, initialized world: traffic/combat state is never loaded. */
export function restoreProgression(fresh:SimState,data:ProgressionDocument,playerId:string):SimState {
  const clean=validateSavedProgression(data),snapshot=gameplaySnapshot({state:fresh}),wallet=object(clean.wallet),progression=object(clean.progression),player=object(clean.player),mission=object(clean.missions),activities=object(clean.activities);
  const activity=snapshot.activities.players[playerId];if(!activity)throw new SaveError("invalid","Initialize player systems before restoring");
  const {settledModeIds,microclimatePaid,...savedWallet}=wallet,{doom,...savedProgression}=progression;
  const savedDoom=doom?object(doom):undefined,remainingWinter=(savedDoom?.winterRemainingTicks as number|undefined)??0;
  const restoredDoom=savedDoom?{...createDoomClock(),months:savedDoom.months as number,resets:savedDoom.resets as number,winters:savedDoom.winters as number,factions:savedDoom.factions,...(savedDoom.stopped!==undefined?{stopped:savedDoom.stopped}:{}),lastDay:gameTime(fresh).dayIndex,lastTick:fresh.tick,pausedUntil:0,winterUntilDay:remainingWinter>0?gameTime(fresh).dayIndex+Math.ceil(remainingWinter/DAY_TICKS):-1,winterUntilTick:remainingWinter>0?fresh.tick+remainingWinter:0,factCursors:{},streakCursor:0}:undefined;
  const allowance=activities.officeHoursBookings?object(activities.officeHoursBookings):undefined;
  const restoredActivities={completedIds:activities.completedIds,...(allowance?{officeHoursBookings:{day:gameTime(fresh).dayIndex,count:allowance.count},officeHoursSequence:activities.officeHoursSequence??0,cooldowns:{...activity.cooldowns,"office-hours":fresh.tick+(activities.officeHoursCooldownTicks as number??0)}}:{})};
  const copy=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T;
  return {...fresh,ext:{...fresh.ext,
    economy:{...snapshot.economy,settledModeIds:copy(settledModeIds??[]),players:{...snapshot.economy.players,[playerId]:{...createWallet(),...copy(savedWallet),...(microclimatePaid===true?{microclimatePaidWeek:gameTime(fresh).gameWeek,microclimateActive:object(clean.progression).gear==="microclimate"}: {})}}} as unknown as typeof snapshot.economy,
    progression:{...snapshot.progression,...(restoredDoom?{doom:copy(restoredDoom)}:{}),players:{...snapshot.progression.players,[playerId]:{...createProgressionPlayer(),...copy(savedProgression)}}} as unknown as typeof snapshot.progression,
    player:{...snapshot.player,players:{...snapshot.player.players,[playerId]:{...createPlayerStatus(),...copy(player),status:"active",bridgeUntil:0,resumeTick:0}}} as unknown as typeof snapshot.player,
    missions:{...snapshot.missions,players:{...snapshot.missions.players,[playerId]:{...createMissionProgress(),...copy(mission)}}} as unknown as typeof snapshot.missions,
    activities:{...snapshot.activities,players:{...snapshot.activities.players,[playerId]:{...activity,...copy(restoredActivities),activeCardId:"",activeActivityId:"",cardUntilTick:0}}} as unknown as typeof snapshot.activities,
  }};
}
