import { commands,distanceSquared,event,sortedBodies } from "./common.ts";
import type { EconomyState,GameplayContext,GameplayEvent,HeatState,PlayerGameplayState,PlayerStatus } from "./types.ts";

export function createPlayerStatus():PlayerStatus{return {status:"active",bridgeUntil:0,resumeTick:0,safehouseId:"",startupKitId:"",downRounds:0,commandSequence:0,watchingActorId:"",watchedTicks:0};}
export function createPlayer(tick=0):PlayerGameplayState{return {version:1,tick,nextId:1,players:{},events:[]};}
/** Recovery emits explicit commands to the owner of wallet/heat/body state. */
export function stepPlayer(previous:PlayerGameplayState,ctx:GameplayContext,tick:number,economy:EconomyState,heat:HeatState,missionEvents:readonly GameplayEvent[]=[]):PlayerGameplayState {
 const state:PlayerGameplayState={...previous,tick,players:{},events:[]};
 for(const body of sortedBodies(ctx)){
  const own={...(previous.players[body.id]??createPlayerStatus())};state.players[body.id]=own;
  const observation=ctx.observations.find(o=>o.playerId===body.id);own.watchingActorId=observation?.watchingActorId??"";own.watchedTicks=observation?.watchedTicks??0;
  const wallet=economy.players[body.id], danger=heat.players[body.id];
  for(const command of commands(ctx,body.id,["startup-define","bridge-accept"],own.commandSequence)){
   own.commandSequence=command.sequence;
   if(command.kind==="startup-define"&&command.kitId&&ctx.validKitIds.includes(command.kitId)){own.startupKitId=command.kitId;event(state,"StartupDefined",body.id,command.kitId);}
   if(command.kind==="bridge-accept"&&((ctx.simVersion??20)<21||ctx.associatesAnswer!==false)&&own.status==="bridge"&&tick<own.bridgeUntil&&ctx.observations.find(o=>o.playerId===body.id)?.associateWithin200){own.status="active";event(state,"player.bridge",body.id,"",6);}
  }
  if(own.status==="down"&&tick>=own.resumeTick)own.status="active";
  if(own.status==="active"&&(wallet?.runwayMonths??18)<=0&&!((ctx.simVersion??20)>=21&&state.events.some(e=>e.kind==="player.bridge"&&e.playerId===body.id))){
   if(ctx.wave>=3){own.status="bridge";own.bridgeUntil=tick+3600;event(state,"player.bridge-offer",body.id,"",60);}
   else down();
  }
  if(own.status==="bridge"&&tick>=own.bridgeUntil)down();
  // A lost bell duel means ACQUI-HIRED. A mission duel (the producer's event from the tick
  // before) follows the mission's own five-star grant, which decays out of associates' sight.
  const lostDuel=(danger?.vcQuarters??0)>=20&&ctx.facts.some(f=>f.playerId===body.id&&f.tick===tick&&f.kind==="bell-duel.lost")||missionEvents.some(e=>e.playerId===body.id&&e.tick===tick-1&&e.kind==="bell-duel.lost");
  if(own.status==="active"&&lostDuel){
   own.status="down";own.resumeTick=tick+1;event(state,"player.acqui-hired",body.id,"",.1);recover();
  }
  function recover():void {
   const sites=ctx.sites.filter(site=>site.kind==="safehouse"&&site.wave<=ctx.wave&&(wallet?.ownedSiteIds.includes(site.id)??false)).sort((a,b)=>distanceSquared(body,a)-distanceSquared(body,b)||(a.id<b.id?-1:1));
   own.safehouseId=sites[0]?.id??"";event(state,"player.respawn",body.id,own.safehouseId);
  }
  function down():void {own.status="down";own.resumeTick=tick+1;own.downRounds++;event(state,"player.down",body.id,"",.2);recover();}
 }
 return state;
}
