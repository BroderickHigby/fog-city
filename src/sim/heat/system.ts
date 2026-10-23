import { clamp } from "../dmath.ts";
import { commands,distanceSquared,event,facts,sortedBodies } from "../player/common.ts";
import type { GameplayContext,GameplayEvent,HeatState,HeatStatus } from "../player/types.ts";
export function createHeatStatus(tick:number):HeatStatus {return {threat:0,vcQuarters:0,lastSeenTick:tick,lastAssociateSeenTick:tick,recentMelts:[],levelMelts:0,spawnSequence:0,commandSequence:0,lastWashId:""};}
export function createHeat(tick=0):HeatState{return {version:1,tick,nextId:1,players:{},factCursors:{},grantCursors:{},events:[]};}
function raise(state:HeatState,id:string,level:number,ctx:GameplayContext):void {
 const own=state.players[id]!;const next=Math.min(ctx.wave>=3?5:2,level);if(next<=own.threat)return;own.threat=next;own.levelMelts=0;own.lastSeenTick=state.tick;
 event(state,"threat.changed",id,"",next);
 if(next>=2){const body=ctx.bodies.find(b=>b.id===id)!;const kind=next===2?"van":next===3?"drone":next===4?"swarm":"patrol";const out=event(state,"threat.spawn",id,"",next===4?8:next===5?4:2,kind),base={id:`heat:${id}:${++own.spawnSequence}`,requestTick:state.tick,playerId:id,player:{x:body.x,z:body.z}};out.payload=next===2?{...base,kind:"van",unitCount:2,threat:2}:{...base,kind:next===3?"drone":next===4?"swarm":"patrol",unitCount:out.amount,threat:next as 3|4|5};}
}
export function stepHeat(previous:HeatState,ctx:GameplayContext,tick:number,grants:readonly GameplayEvent[]=[],missionGrants:readonly GameplayEvent[]=[],worldGrants:readonly GameplayEvent[]=[]):HeatState {
 const state:HeatState={...previous,tick,players:{},factCursors:{...previous.factCursors},grantCursors:{...previous.grantCursors},events:[]};
 for(const body of sortedBodies(ctx)){const old=previous.players[body.id]??createHeatStatus(tick);state.players[body.id]={...old,recentMelts:old.recentMelts.filter(t=>t>=tick-7200)};}
 for(const fact of facts(ctx,tick,state.factCursors)){
  const own=state.players[fact.playerId];if(!own)continue;
  if(fact.kind==="robot.sprayed"||fact.kind==="robot.alert")raise(state,fact.playerId,1,ctx);
  if(fact.kind==="robot.heap") {
   const actor=ctx.actors.find(actor=>actor.id===fact.actorId);if(actor?.firmware!=="bad")continue;
   own.recentMelts.push(tick);own.levelMelts++;
   if(own.threat<2&&(actor.witnessedByBad||own.recentMelts.filter(t=>t>=tick-3600).length>=2))raise(state,fact.playerId,2,ctx);
   else if(own.threat===2&&own.levelMelts>=4&&own.recentMelts.length>=4)raise(state,fact.playerId,3,ctx);
   else if(own.threat===3&&own.levelMelts>=3)raise(state,fact.playerId,4,ctx);
   else if(own.threat===4&&actor.armoured)raise(state,fact.playerId,5,ctx);
   if(ctx.wave>=3&&(actor.peopleWitnesses??0)>=5)own.vcQuarters=Math.min(20,own.vcQuarters+1);
  }
  if(fact.kind==="player.down"){own.threat=0;own.vcQuarters=Math.min(20,own.vcQuarters+4);}
  if(fact.kind==="car-wash"){own.threat=Math.max(0,own.threat-1);own.lastSeenTick=tick;}
  if(ctx.wave>=3&&fact.kind==="player.viral-jump")own.vcQuarters=Math.min(20,own.vcQuarters+1);
  if(ctx.wave>=3&&fact.kind==="player.commandeer")own.vcQuarters=Math.min(20,own.vcQuarters+4);
 }
 const accepted:GameplayEvent[]=[];
 for(const [source,group] of [["player",grants],["missions",missionGrants],["world",worldGrants]] as const)for(const grant of [...group].sort((a,b)=>a.id-b.id))if(grant.id>(state.grantCursors[source]??0)&&grant.tick<=tick){state.grantCursors[source]=grant.id;accepted.push(grant);}
 for(const body of sortedBodies(ctx)){
  const own=state.players[body.id]!, observation=ctx.observations.find(o=>o.playerId===body.id), fog=(observation?.fog??0)>.4;
  for(const grant of accepted.filter(e=>e.playerId===body.id||e.kind==="world.agi-achieved")){
   if(grant.kind==="player.down"){own.threat=0;own.vcQuarters=Math.min(20,own.vcQuarters+4);}
   if(grant.kind==="player.bridge")own.vcQuarters=Math.min(20,own.vcQuarters+4);
   if(grant.kind==="player.acqui-hired"){own.threat=0;own.vcQuarters=0;}
   if(grant.kind==="world.agi-achieved")own.vcQuarters=Math.min(20,own.vcQuarters+4);
   if(grant.kind==="mission.vc")own.vcQuarters=clamp(own.vcQuarters+4*grant.amount,0,20);
  }
  const wash=ctx.sites.find(site=>site.kind==="carWash"&&site.wave<=ctx.wave&&Math.abs(body.speed)<=3&&distanceSquared(body,site)<=site.radius*site.radius);
  if(!wash)own.lastWashId="";
  for(const command of commands(ctx,body.id,["activity-start"],own.commandSequence)){
   own.commandSequence=command.sequence;
   if(wash&&command.targetId===wash.id&&own.lastWashId!==wash.id){own.lastWashId=wash.id;own.threat=Math.max(0,own.threat-1);own.lastSeenTick=tick;event(state,"threat.changed",body.id,wash.id,own.threat,"car-wash");}
  }
  if(observation?.seenByBad)own.lastSeenTick=tick;
  else if(own.threat>0&&tick-own.lastSeenTick>=(fog?900:1800)){own.threat--;own.lastSeenTick=tick;event(state,"threat.changed",body.id,"",own.threat,"decay");}
  if(observation?.seenByAssociate)own.lastAssociateSeenTick=tick;
  else if(own.vcQuarters>0&&tick-own.lastAssociateSeenTick>=(fog?600:1200)){own.vcQuarters=Math.max(0,own.vcQuarters-4);own.lastAssociateSeenTick=tick;}
  own.threat=clamp(own.threat,0,ctx.wave>=3?5:2);own.vcQuarters=clamp(own.vcQuarters,0,20);
 }
 return state;
}
