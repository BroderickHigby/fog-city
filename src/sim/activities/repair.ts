import { Action } from "../contract.ts";
import { distanceSquared,planarDistanceSquared,validId } from "../player/common.ts";
import { canInteractAtSite } from "../player/sites.ts";
import type { GameplayContext,GameplayFact,GameplaySite } from "../player/types.ts";

export interface RepairRequest {id:string;requestTick:number;playerId:string;actorId:string;kioskId:string;kiosk:{x:number;z:number}}
export interface RepairTourState {claims:string[];interacting:boolean;active?:RepairRequest&{followedTicks:number;lastObservedTick:number;lastRequestTick:number}}
export interface RepairTourResult {state:RepairTourState;request?:RepairRequest;completed?:{actorId:string;requestId:string;kioskId:string}}
export interface AcceptedRestoration {id:string;tick:number;kind:string;actorId:string;detail:string;sourcePlayerId?:string;requestId?:string;kioskId?:string}
/** Agent event IDs are tick:index; only accepted body readmission carries completion. */
export function restorationFacts(events:readonly AcceptedRestoration[]):GameplayFact[] {
 return events.flatMap(event=>{
  const parts=event.id.split(":"),[tick,index]=parts.map(Number),sequence=(tick??-1)*8192+(index??-1)+1;
  if(!/^\d+:\d+$/.test(event.id)||parts.length!==2||event.kind!=="actor.restored"||event.detail!=="accepted-body"||tick!==event.tick||!Number.isSafeInteger(tick)||tick!<0||!Number.isSafeInteger(index)||index!<0||index!>=8192||!Number.isSafeInteger(sequence)||sequence<=0||!validId(event.sourcePlayerId)||!validId(event.actorId)||!validId(event.requestId)||!validId(event.kioskId))return [];
  return [{id:`restoration:${event.id}`,source:"agents" as const,sequence,tick:event.tick,kind:"repair.accepted",playerId:event.sourcePlayerId,actorId:event.actorId,detail:JSON.stringify({requestId:event.requestId,kioskId:event.kioskId})}];
 });
}
/** An apology belongs to the player who actually damaged and escorted this good robot. */
export function stepRepairTour(previous:RepairTourState|undefined,ctx:GameplayContext,playerId:string,tick:number,facts:readonly GameplayFact[],requestId:string):RepairTourResult {
 const state:RepairTourState={claims:[...(previous?.claims??[])],interacting:previous?.interacting??false,...(previous?.active?{active:{...previous.active,kiosk:{...previous.active.kiosk}}}:{})};
 const result:RepairTourResult={state},body=ctx.bodies.find(p=>p.id===playerId),actors=ctx.actorBodies??[];
 if(!body)return result;
 for(const fact of facts)if(fact.playerId===playerId&&fact.kind==="robot.repair"&&fact.actorId&&actors.some(a=>a.id===fact.actorId&&a.firmware==="good")&&!state.claims.includes(fact.actorId))state.claims.push(fact.actorId);
 state.claims=state.claims.slice(-64);
 const interacting=!!((ctx.actions?.[playerId]??0)&Action.interact),pressed=interacting&&!state.interacting;state.interacting=interacting;
 if(!state.active&&pressed){
  const actor=actors.filter(a=>a.firmware==="good"&&state.claims.includes(a.id)&&distanceSquared(body,a)<=36).sort((a,b)=>distanceSquared(body,a)-distanceSquared(body,b)||(a.id<b.id?-1:1))[0];
  const kiosk=actor?[...ctx.sites].filter(s=>s.kind==="repairKiosk"&&s.wave<=ctx.wave).sort((a,b)=>planarDistanceSquared(actor,a)-planarDistanceSquared(actor,b)||(a.id<b.id?-1:1))[0]:undefined;
  if(actor&&kiosk&&validId(requestId))state.active={id:requestId,requestTick:tick,playerId,actorId:actor.id,kioskId:kiosk.id,kiosk:{x:kiosk.x,z:kiosk.z},followedTicks:0,lastObservedTick:tick-1,lastRequestTick:tick-60};
 }
 const active=state.active;if(!active)return result;
 const actor=actors.find(a=>a.id===active.actorId&&a.firmware==="good"),kiosk=ctx.sites.find(s=>s.id===active.kioskId&&s.kind==="repairKiosk") as GameplaySite|undefined;
 active.followedTicks=actor&&distanceSquared(body,actor)<=100?(active.lastObservedTick===tick-1?active.followedTicks+1:1):0;active.lastObservedTick=tick;
 if(tick-active.lastRequestTick>=60){const {followedTicks:_,lastObservedTick:__,lastRequestTick:___,...request}=active;result.request=request;active.lastRequestTick=tick;}
 for(const fact of facts){
  if(fact.playerId!==playerId||fact.kind!=="repair.accepted"||fact.actorId!==active.actorId)continue;
  let detail:{requestId?:string;kioskId?:string};try{detail=JSON.parse(fact.detail??"") as typeof detail;}catch{continue;}
  if(detail?.requestId!==active.id||detail.kioskId!==active.kioskId)continue;
  if(actor&&kiosk&&active.followedTicks>=60&&canInteractAtSite(body,kiosk)&&canInteractAtSite(actor,kiosk)&&(ctx.rustByActor?.[actor.id]??0)<=.01)result.completed={actorId:actor.id,requestId:active.id,kioskId:kiosk.id};
  state.claims=state.claims.filter(id=>id!==active.actorId);delete state.active;break;
 }
 return result;
}
