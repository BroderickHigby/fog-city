import { stepLegacyEconomy } from "./legacy-system.ts";
import { normalizeLoadoutChoice } from "../progression/rules.ts";
import { clamp } from "../dmath.ts";
import { canInteractAtSite } from "../player/sites.ts";
import { bodyOf,commands,event,facts,MAX_HISTORY,sortedBodies } from "../player/common.ts";
import type { EconomyState,GameplayContext,GameplayEvent,HeatState,Wallet } from "../player/types.ts";

export function createWallet():Wallet {return {cashCents:200000,runwayMonths:18,reputation:50,paidActorIds:[],ownedItemIds:[],ownedSiteIds:["fidi-desk","marina-garage","mission-bay-garage"],commandSequence:0};}
export function createEconomy(tick=0):EconomyState{return {version:1,tick,nextId:1,players:{},factCursors:{},grantCursors:{},events:[]};}
function pay(wallet:Wallet,cents:number):void {if(Number.isFinite(cents))wallet.cashCents=Math.max(0,Math.min(Number.MAX_SAFE_INTEGER, wallet.cashCents+Math.round(cents)));}
function within(ctx:GameplayContext,id:string,siteId:string):boolean {const body=bodyOf(ctx,id),site=ctx.sites.find(site=>site.id===siteId);return !!body&&!!site&&canInteractAtSite(body,site);}
export function stepEconomy(previous:EconomyState,ctx:GameplayContext,tick:number,grants:readonly GameplayEvent[]=[],heat?:HeatState,recovery:readonly GameplayEvent[]=[],activities:readonly GameplayEvent[]=[],ranks:Readonly<Record<string,number>>={},perks:Readonly<Record<string,readonly string[]>>={},simVersion=20,gearByPlayer:Readonly<Record<string,string>>={}):EconomyState {
 if(simVersion<27)return stepLegacyEconomy(previous,ctx,tick,grants,heat,recovery,activities);
 const state:EconomyState={...previous,tick,players:{},factCursors:{...previous.factCursors},grantCursors:{...previous.grantCursors},events:[]};
 const liveActors=new Set(ctx.actors.map(actor=>actor.id));
 for(const body of sortedBodies(ctx)) {const old=previous.players[body.id]??createWallet();state.players[body.id]={...old,paidActorIds:old.paidActorIds.filter(id=>liveActors.has(id)),ownedItemIds:[...old.ownedItemIds],ownedSiteIds:[...old.ownedSiteIds]};}
 for(const fact of facts(ctx,tick,state.factCursors)) {
  const wallet=state.players[fact.playerId];if(!wallet)continue;
  if(fact.kind==="player.commandeer"){wallet.reputation=Math.max(0,wallet.reputation-1);event(state,"economy.changed",fact.playerId,fact.actorId??"",wallet.cashCents,"Ride shared to your feed");}
  if(fact.kind==="player.runway")wallet.runwayMonths=clamp(wallet.runwayMonths+(fact.amount??0),0,18);
  if(fact.kind==="economy.penalty") {pay(wallet,-Math.abs(fact.amount??0)*100);wallet.reputation=clamp(wallet.reputation-(fact.detail?.includes("-5")?5:3),0,100);event(state,"economy.changed",fact.playerId,"",wallet.cashCents,"wrong-target");}
  if(fact.kind==="robot.heap"&&fact.actorId&&!wallet.paidActorIds.includes(fact.actorId)) {
   const actor=ctx.actors.find(actor=>actor.id===fact.actorId);if(!actor||actor.firmware!=="bad")continue;
   const stars=(heat?.players[fact.playerId]?.vcQuarters??0)/4;
   const hype=ctx.observations.find(o=>o.playerId===fact.playerId)?.associateWithin200?1+.1*stars:1;
   const multiplier=(1+.25*(clamp(actor.subtlety??1,1,5)-1))*(actor.caughtInAct?1.5:1)*clamp(ctx.doomPayFactor??1,0,5)*hype;
   const amount=Math.round((actor.armoured?40000:15000)*multiplier);pay(wallet,amount);wallet.reputation=clamp(wallet.reputation+1+(actor.caughtInAct?1:0),0,100);wallet.runwayMonths=Math.min(18,wallet.runwayMonths+.5);if(perks[fact.playerId]?.includes("default-alive")){if(ctx.modeRoles?.[fact.playerId]==="spotter")event(state,"perk.scan-charge",fact.playerId,"default-alive",1);else wallet.runwayMonths=Math.min(18,wallet.runwayMonths+.5);}wallet.paidActorIds.push(fact.actorId);event(state,"bounty.paid",fact.playerId,fact.actorId,amount);
  }
  if(fact.kind==="update.interrupted"){wallet.reputation=Math.min(100,wallet.reputation+2);event(state,"update.rewarded",fact.playerId,fact.actorId??"");}
 }
 for(const grant of [...grants].sort((a,b)=>a.id-b.id)) {
  if(grant.id<=(state.grantCursors.missions??0))continue;state.grantCursors.missions=grant.id;
  const wallet=state.players[grant.playerId];if(!wallet)continue;
  if(grant.kind==="mission.cash")pay(wallet,grant.amount);
  if(grant.kind==="mission.runway")wallet.runwayMonths=clamp(wallet.runwayMonths+grant.amount,0,18);
  if(grant.kind==="mission.reputation")wallet.reputation=clamp(wallet.reputation+grant.amount,0,100);
  if(grant.kind==="mission.unlock"&&!wallet.ownedItemIds.includes(grant.targetId))wallet.ownedItemIds.push(grant.targetId);
  if(grant.kind==="mission.unlock"&&grant.targetId.startsWith("safehouse:")&&!wallet.ownedSiteIds.includes(grant.targetId.slice(10)))wallet.ownedSiteIds.push(grant.targetId.slice(10));
 }
 for(const grant of recovery.filter(e=>e.tick===tick)){
  if(grant.id<=(state.grantCursors.player??0))continue;state.grantCursors.player=grant.id;
  const wallet=state.players[grant.playerId];if(!wallet)continue;
  if(grant.kind==="player.down"){wallet.cashCents=Math.floor(wallet.cashCents*.8);wallet.runwayMonths=9;}
  if(grant.kind==="player.bridge")wallet.runwayMonths=6;
  if(grant.kind==="player.acqui-hired"){wallet.cashCents=Math.floor(wallet.cashCents*.9);wallet.runwayMonths=18;}
 }
 for(const grant of activities){
  if(grant.id<=(state.grantCursors.activities??0))continue;state.grantCursors.activities=grant.id;
  const wallet=state.players[grant.playerId];if(wallet&&grant.kind==="activity.cash")pay(wallet,grant.amount);
 }
 for(const body of sortedBodies(ctx)) {
  const wallet=state.players[body.id]!;
  // Microclimate renews only in an observed active game week, never from wall-clock time.
  // The paid-week cursor survives cancel/re-equip; insufficient funds cannot debit or spam.
  if((ctx.mode??"freeRoam")==="freeRoam"&&ctx.wave>=4){
    const week=ctx.gameWeek,selected=gearByPlayer[body.id]==="microclimate";
    if(!selected){if(wallet.microclimateActive!==undefined)wallet.microclimateActive=false;}
    else if(Number.isSafeInteger(week)&&week!>=0){
      if(wallet.microclimatePaidWeek===week)wallet.microclimateActive=true;
      else if(wallet.cashCents>=900){pay(wallet,-900);wallet.microclimatePaidWeek=week;wallet.microclimateActive=true;event(state,"subscription.renewed",body.id,"microclimate",900,String(week));}
      else{wallet.microclimateActive=false;if(wallet.microclimateNoticeWeek!==week){wallet.microclimateNoticeWeek=week;event(state,"subscription.unpaid",body.id,"microclimate",900,"Insufficient funds; gear disabled");}}
    }else wallet.microclimateActive=false;
  }
  for(const site of ctx.sites)if(site.kind==="garage"&&site.wave<=ctx.wave&&!site.priceCents&&!wallet.ownedSiteIds.includes(site.id))wallet.ownedSiteIds.push(site.id);
  for(const command of commands(ctx,body.id,["buy","sleep","repair"],wallet.commandSequence)) {
   wallet.commandSequence=command.sequence;
   if(command.kind==="buy") {
    const property=ctx.sites.find(site=>site.id===command.itemId&&site.kind==="safehouse"&&site.wave<=ctx.wave);
    if(property){if(Number.isSafeInteger(property.priceCents)&&property.priceCents!>=0&&wallet.cashCents>=property.priceCents!&&!wallet.ownedSiteIds.includes(property.id)&&within(ctx,body.id,property.id)){pay(wallet,-property.priceCents!);wallet.ownedSiteIds.push(property.id);event(state,"property.purchased",body.id,property.id,property.priceCents);}continue;}
    const item=ctx.items.find(item=>item.id===command.itemId&&item.wave<=ctx.wave);const site=ctx.sites.find(site=>site.id===command.targetId&&site.vendorItems?.includes(command.itemId??""));
    if(!item||!site||site.wave>ctx.wave||Math.max(item.rank??1,ctx.wave>=4?normalizeLoadoutChoice(item.id)?.rank??1:1)>(ranks[body.id]??1)||!within(ctx,body.id,site.id)||!Number.isSafeInteger(item.priceCents)||item.priceCents<0||wallet.cashCents<item.priceCents||item.requires&&!wallet.ownedItemIds.includes(item.requires))continue;
    const consumable=item.kind==="food"||item.kind==="drink";if(!consumable&&wallet.ownedItemIds.includes(item.id))continue;
    pay(wallet,-item.priceCents);if(consumable)wallet.runwayMonths=clamp(wallet.runwayMonths+(item.effect.runwayMonths??0),0,18);else wallet.ownedItemIds.push(item.id);
    event(state,"vendor.purchased",body.id,item.id,item.priceCents);
   } else {
    const site=ctx.sites.find(site=>site.id===command.targetId&&wallet.ownedSiteIds.includes(site.id));const danger=heat?.players[body.id];
    if(!site||!within(ctx,body.id,site.id)||(danger?.threat??0)>1||(danger?.vcQuarters??0)>8)continue;
    if(command.kind==="sleep"&&site.kind==="safehouse") {wallet.runwayMonths=18;event(state,"player.slept",body.id,site.id,8,"game-hours");}
    if(command.kind==="repair")event(state,"player.car-repair",body.id,site.id);
   }
  }
  wallet.runwayMonths=clamp(wallet.runwayMonths,0,18);wallet.reputation=clamp(wallet.reputation,0,100);wallet.paidActorIds=wallet.paidActorIds.slice(-MAX_HISTORY);
 }
 return state;
}
