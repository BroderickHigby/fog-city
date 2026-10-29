import { sortedIds, type SimState } from "../contract.ts";
import { isGameplayId } from "../gameplay-contract.ts";
import { createEconomy,createWallet } from "../economy/system.ts";
import { createProgression,createProgressionPlayer,rankForXp } from "../progression/system.ts";
import { loadoutSlots,normalizeLoadoutChoice,normalizeStreakId } from "../progression/rules.ts";
import type { Progression } from "../player/types.ts";

/** A host passes its actual paused city, never rank/unlock values received in a room request. */
export interface MatchCarrySource {city:Readonly<SimState>;bindings:Readonly<Record<string,string>>}
const amount=(value:number)=>Number.isSafeInteger(value)&&value>=0?value:0;
/** Copy gameplay authority only; no body, wallet balance, campaign, clock, Doom or RNG crosses. */
export function applyValidatedMatchCarry(instance:SimState,source:MatchCarrySource):SimState {
  if(instance.version<27||source.city.version<27)return instance;
  const city=source.city,session=city.ext.modes as {match?:{version?:number}}|undefined;
  if(session?.match?.version===1)throw new Error("Match loadout authority must come from the paused city");
  const keys=sortedIds(source.bindings),used=new Set<string>();
  if(keys.length>64)throw new Error("Match carry exceeds player budget");
  const progression={...createProgression(instance.tick),players:{...instance.ext.progression?.players}},economy={...createEconomy(instance.tick),players:{...instance.ext.economy?.players}};
  for(const id of keys){
    const sourceId=source.bindings[id]!;
    if(!isGameplayId(id)||!isGameplayId(sourceId)||!instance.players[id]||!city.players[sourceId]||used.has(sourceId))throw new Error("Match carry requires unique current city seats");
    used.add(sourceId);
    const old=city.ext.progression?.players[sourceId]??createProgressionPlayer(),wallet=city.ext.economy?.players[sourceId];
    const xp=amount(old.xp),rank=rankForXp(xp,27),owned=(wallet?.ownedItemIds??[]).filter(value=>isGameplayId(value)&&(value==="trunk-tank"||value==="roof-cannon"||normalizeLoadoutChoice(value)?.kind==="nozzle")).slice(0,64);
    const nozzle=normalizeLoadoutChoice(old.nozzle),gadget=normalizeLoadoutChoice(old.gadget),gear=normalizeLoadoutChoice(old.gear);
    const canOwnNozzle=nozzle?.kind==="nozzle"&&(!nozzle.requiresOwnership||owned.some(id=>{const choice=normalizeLoadoutChoice(id);return choice?.kind==="nozzle"&&choice.value===nozzle.value;}));
    const perks=[...new Set(old.perks.flatMap(id=>{const choice=normalizeLoadoutChoice(id);return choice?.kind==="perk"?[choice.value]:[];}))].slice(0,loadoutSlots("perkSlots",rank,4));
    const streaks=[...new Set(old.streaks.flatMap(id=>normalizeStreakId(id)??[]))].slice(0,loadoutSlots("streakSlots",rank,4));
    const profile:Progression={...createProgressionPlayer(),xp,rank,tankTier:[0,1,2].includes(old.tankTier)?old.tankTier:0,flowTier:old.flowTier===1?1:0,scannerTier:[1,2,3,4].includes(old.scannerTier)?old.scannerTier:1,
      nozzle:nozzle?.kind==="nozzle"&&rank>=nozzle.rank&&canOwnNozzle?nozzle.value:"standard",gadget:gadget?.kind==="gadget"&&rank>=gadget.rank?gadget.value:"balloon",gear:gear?.kind==="gear"&&rank>=gear.rank?gear.value:"none",perks,streaks,banked:{},earnedStreaks:[],achievements:[],streakPoints:0,streakHeld:false};
    progression.players[id]=profile;
    economy.players[id]={...createWallet(),cashCents:0,runwayMonths:12,reputation:0,ownedItemIds:[...owned],ownedSiteIds:[],...(wallet?.microclimateActive===true?{microclimateActive:true}:{})};
  }
  return {...instance,ext:{...instance.ext,progression,economy}};
}
