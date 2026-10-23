import { clamp } from "../dmath.ts";
import { commands,event,sortedBodies } from "../player/common.ts";
import { rankForXp as contentRankForXp,LOADOUTS,PROGRESSION } from "../../content/gameplay.ts";
import { createDoomClock,stepDoomClock } from "./doom-clock.ts";
import type { GameplayContext,GameplayEvent,Progression,ProgressionState } from "../player/types.ts";

export function createProgressionPlayer():Progression{return {xp:0,rank:1,tankTier:0,flowTier:0,scannerTier:1,nozzle:"standard",gadget:"balloon",gear:"none",perks:[],streaks:["confidence"],streakPoints:0,streakSequence:0,banked:{},commandSequence:0,achievements:[]};}
export function createProgression(tick=0):ProgressionState{return {version:1,tick,nextId:1,players:{},grantCursors:{},events:[],doom:createDoomClock()};}
export const STREAK_COST:Readonly<Record<string,number>>={confidence:300,parrots:500,tensor:700,blimp:900,hydrants:1200,agi:2500};
const STREAK_IDS:Readonly<Record<string,string>>={"confidence-score":"confidence","buzzword-parrots":"parrots","tensor-brick-drop":"tensor","blimp-impressions":"blimp","open-hydrants":"hydrants","agi-allegedly":"agi"};
export function rankForXp(xp:number):number{return contentRankForXp(xp);}
export function conversionCap(localBaseCount:number,inFidelity:boolean,protectedArea=false):number{return Math.floor(Math.max(0,localBaseCount)*(inFidelity&&!protectedArea?2:1));}
/** Permanent upgrades and tactical grants have one authoritative owner. */
export function stepProgression(previous:ProgressionState,ctx:GameplayContext,tick:number,groups:Readonly<Record<string,readonly GameplayEvent[]>>):ProgressionState {
 const state:ProgressionState={...previous,tick,players:{},grantCursors:{...previous.grantCursors},events:[]};
 const activityFacts=(groups.activities??[]).filter(e=>e.kind==="faction.pauser-completed"||e.kind==="faction.accelerator-completed").map(e=>({id:`activities:${e.id}`,sequence:e.id,source:"world" as const,tick,playerId:e.playerId,kind:e.kind}));
 const doom=stepDoomClock(previous.doom??createDoomClock(),{...ctx,facts:[...ctx.facts,...activityFacts]},tick);state.doom=doom.state;
 if(ctx.wave>=4)for(const change of doom.events)event(state,change.kind,change.playerId,"",change.amount);
 for(const body of sortedBodies(ctx)){const old=previous.players[body.id]??createProgressionPlayer();state.players[body.id]={...createProgressionPlayer(),...old,achievements:[...(old.achievements??[])],perks:[...old.perks],streaks:[...old.streaks],banked:{...old.banked}};}
 for(const source of Object.keys(groups).sort())for(const grant of [...groups[source]!].sort((a,b)=>a.id-b.id)){
  if(grant.id<=(state.grantCursors[source]??0))continue;state.grantCursors[source]=grant.id;const own=state.players[grant.playerId];if(!own)continue;
  if(grant.kind==="bounty.paid"){const actor=ctx.actors.find(a=>a.id===grant.targetId);own.xp+=50*clamp(actor?.subtlety??1,1,5);own.streakPoints+=(actor?.armoured?200:100)+(actor?.caughtInAct?50:0);}
  if(grant.kind==="update.rewarded")own.streakPoints+=150;
  if(grant.kind==="mission.unlock"&&grant.targetId==="app:scanner-tier-2")own.scannerTier=Math.max(own.scannerTier,2) as 2|3|4;
  if(grant.kind==="economy.changed"&&grant.detail==="wrong-target"){own.streakPoints=0;own.banked={};}
  if(grant.kind==="mission.xp"||grant.kind==="activity.xp")own.xp+=Math.max(0,grant.amount);
  if(grant.kind==="player.down"||grant.kind==="player.acqui-hired"){own.streakPoints=0;own.banked={};}
  if(grant.kind==="vendor.purchased"){
   const item=ctx.items.find(item=>item.id===grant.targetId);if(!item)continue;
   if(item.kind==="tank")own.tankTier=clamp(item.tier??0,0,2) as 0|1|2;
   if(item.kind==="flow")own.flowTier=clamp(item.tier??0,0,1) as 0|1;
   if(item.kind==="scanner")own.scannerTier=clamp(item.tier??1,1,4) as 1|2|3|4;
   if(item.id==="pressure-nozzle")own.nozzle="pressure";
   if(item.kind==="perk"&&!own.perks.includes(item.id))own.perks.push(item.id);
  }
 }
 for(const body of sortedBodies(ctx)){
  const own=state.players[body.id]!;own.rank=ctx.wave>=4?rankForXp(own.xp):1;
  const streakSlots=ctx.wave>=4?PROGRESSION.gates.filter(g=>g.kind==="streakSlots"&&g.rank<=own.rank).reduce((n,g)=>Math.max(n,g.value),0):1;
  own.streaks=own.streaks.slice(0,streakSlots);
  for(const command of commands(ctx,body.id,["loadout","streak-call"],own.commandSequence)){
   own.commandSequence=command.sequence;
   const streakId=command.itemId&&(STREAK_IDS[command.itemId]??command.itemId);
   if(command.kind==="streak-call"&&streakId&&own.streaks.includes(streakId)&&own.streakPoints>=(STREAK_COST[streakId]??Infinity)){
    own.streakPoints-=STREAK_COST[streakId]!;event(state,"streak.grant",body.id,streakId,++own.streakSequence);
   }
   if(command.kind==="loadout"&&command.itemId&&ctx.wave>=4){
    if(["balloon","sprinkler","speaker"].includes(command.itemId)&&own.rank>=(command.itemId==="balloon"?1:command.itemId==="sprinkler"?12:24))own.gadget=command.itemId as Progression["gadget"];
    if(["none","boots","airplane"].includes(command.itemId)&&own.rank>=(command.itemId==="none"?1:command.itemId==="boots"?8:20))own.gear=command.itemId as Progression["gear"];
    const gadget=LOADOUTS.gadgets.find(g=>g.id===command.itemId&&own.rank>=g.rank);if(gadget)own.gadget=({"water-balloon":"balloon","lawn-sprinkler":"sprinkler","decoy-speaker":"speaker"} as const)[gadget.id as "water-balloon"|"lawn-sprinkler"|"decoy-speaker"];
    if(command.itemId==="rubber-boots")own.gear="boots";if(command.itemId==="airplane-mode")own.gear="airplane";
    const perk=LOADOUTS.perks.find(p=>p.id===command.itemId),slots=PROGRESSION.gates.filter(g=>g.kind==="perkSlots"&&g.rank<=own.rank).reduce((n,g)=>Math.max(n,g.value),0);
    if(perk){if(own.perks.includes(perk.id))own.perks=own.perks.filter(id=>id!==perk.id);else if(own.perks.length<slots)own.perks.push(perk.id);}
    if(streakId&&Object.hasOwn(STREAK_COST,streakId)){if(own.streaks.includes(streakId))own.streaks=own.streaks.filter(id=>id!==streakId);else if(own.streaks.length<streakSlots)own.streaks.push(streakId);}
   }
  }
 }
 return state;
}
