import { nextU32,seedRng } from "../rng.ts";
import { createWorldEvents,stepWorldEvents } from "./world-events.ts";
import { Action } from "../contract.ts";
import { commands,distanceSquared,event,facts,sortedBodies } from "../player/common.ts";
import type { ActivitiesState,GameplayContext,MissionState,PlayerActivities } from "../player/types.ts";
export function createActivities(tick=0):ActivitiesState{return {version:1,tick,nextId:1,players:{},factCursors:{},events:[],worldEvents:createWorldEvents()};}
function createOwn(seed:number,tick:number):PlayerActivities{return {nextDirectorTick:tick+2700,directorRng:seedRng(seed),activeCardId:"",cardUntilTick:0,cardCooldowns:{},activeActivityId:"",activityStartedTick:0,completedIds:[],commandSequence:0,checkpointIndex:0,objectiveCount:0,cooldowns:{},ruleFailed:false};}
/** Director schedules are independent per player and persisted in snapshots. */
export function stepActivities(previous:ActivitiesState,ctx:GameplayContext,tick:number,missions:MissionState,seed:number):ActivitiesState {
 const state:ActivitiesState={...previous,tick,players:{},factCursors:{...previous.factCursors},events:[]};const incoming=facts(ctx,tick,state.factCursors);
 const world=stepWorldEvents(previous.worldEvents,ctx,tick);state.worldEvents=world.state;
 for(const emitted of world.emissions){const e=event(state,emitted.kind,emitted.playerId,emitted.targetId,emitted.amount,emitted.detail);if(emitted.payload)e.payload=emitted.payload;}
 for(const body of sortedBodies(ctx)){
  let hash=seed;for(const char of body.id)hash=(Math.imul(hash,31)+char.charCodeAt(0))>>>0;
  const old=previous.players[body.id]??createOwn(hash,tick);const own:PlayerActivities={...createOwn(hash,tick),...old,directorRng:[...old.directorRng],cardCooldowns:{...old.cardCooldowns},completedIds:[...old.completedIds],cooldowns:{...old.cooldowns}};state.players[body.id]=own;
  const missionActive=missions.players[body.id]?.status==="active";const observation=ctx.observations.find(o=>o.playerId===body.id);
  if(missionActive||own.activeActivityId)own.nextDirectorTick=tick+2700;
  if(own.activeCardId&&tick>=own.cardUntilTick)own.activeCardId="";
  if(!missionActive&&!own.activeActivityId&&!own.activeCardId&&tick>=own.nextDirectorTick){
   const choices=ctx.directorCards.filter(card=>card.fromWave<=ctx.wave&&(own.cardCooldowns[card.id]??0)<=tick&&(!observation?.protectedArea||card.protectedAreas)).sort((a,b)=>a.id<b.id?-1:1);
   const [roll,rng]=nextU32(own.directorRng);own.directorRng=rng;own.nextDirectorTick=tick+2700+roll%901;
   if(choices.length){const card=choices[roll%choices.length]!;own.activeCardId=card.id;own.cardUntilTick=tick+1200;own.cardCooldowns[card.id]=tick+Math.ceil(card.cooldownS*60);event(state,"director.stage",body.id,card.id,Math.min(150,card.radiusM),JSON.stringify({x:body.x+Math.min(75,card.radiusM),y:body.y,z:body.z}));}
  }
  for(const command of commands(ctx,body.id,["activity-start","activity-complete"],own.commandSequence)){
   own.commandSequence=command.sequence;
   if(command.kind!=="activity-start"||own.activeActivityId||missionActive)continue;
   const activity=ctx.activities.find(a=>a.id===command.targetId&&!["carWash","repairKiosk","vendor","mission"].includes(a.kind)&&a.wave<=ctx.wave&&distanceSquared(body,a)<=a.radius*a.radius&&(own.cooldowns[a.id]??0)<=tick&&(a.repeatable!==false||!own.completedIds.includes(a.id)));
   if(activity){own.activeActivityId=activity.id;own.activityStartedTick=tick;own.checkpointIndex=0;own.objectiveCount=0;own.ruleFailed=false;event(state,"activity.started",body.id,activity.id);}
  }
  if(own.activeActivityId){
   const activity=ctx.activities.find(a=>a.id===own.activeActivityId);const elapsed=tick-own.activityStartedTick;
   if(activity?.maxSpeedMps!==undefined&&Math.abs(body.speed)>activity.maxSpeedMps)own.ruleFailed=true;
   if(incoming.some(f=>f.playerId===body.id&&f.kind==="activity.ruleFailed"&&f.actorId===activity?.id))own.ruleFailed=true;
   const checkpoint=activity?.checkpoints?.[own.checkpointIndex];if(checkpoint&&distanceSquared(body,checkpoint)<=checkpoint.radius*checkpoint.radius)own.checkpointIndex++;
   const measuredFaction=activity?.objective?.event==="faction.pauser-completed"||activity?.objective?.event==="faction.accelerator-completed";
   for(const fact of incoming)if(!measuredFaction&&activity&&fact.playerId===body.id&&fact.kind===(activity.objective?.event??"activity.objective-complete")&&(activity.objective||fact.actorId===activity.id))own.objectiveCount++;
   const routeComplete=own.checkpointIndex>=(activity?.checkpoints?.length??0);
   // Route trials derive their completion from the accepted player trajectory. A
   // photo/relic request only succeeds at the final marked location after the route.
   if(activity?.kind==="timeTrial"&&routeComplete&&elapsed>=60)own.objectiveCount=Math.max(own.objectiveCount,1);
   if(activity?.kind==="delivery"&&activity.objective?.event==="delivery.completed"&&routeComplete&&elapsed>=60&&((ctx.actions?.[body.id]??0)&Action.interact))own.objectiveCount=Math.max(own.objectiveCount,1);
   const faction=activity?.objective?.event;
   const finalPoint=activity?.checkpoints?.at(-1)??activity;
   const atFinish=!!finalPoint&&distanceSquared(body,finalPoint)<=finalPoint.radius*finalPoint.radius;
   if(activity&&routeComplete&&atFinish&&!own.ruleFailed&&elapsed>=60&&(faction==="faction.pauser-completed"||faction==="faction.accelerator-completed")&&((ctx.actions?.[body.id]??0)&Action.interact))own.objectiveCount=1;
   if(activity&&["photo","relic"].includes(activity.kind)&&routeComplete&&elapsed>=60&&((ctx.actions?.[body.id]??0)&Action.interact)){
    const final=activity.checkpoints?.at(-1);if(final&&distanceSquared(body,final)<=final.radius*final.radius)own.objectiveCount=Math.max(own.objectiveCount,1);
   }
   const objectiveComplete=own.objectiveCount>=(activity?.objective?.count??1);
   if(activity&&objectiveComplete&&routeComplete&&!own.ruleFailed&&elapsed>=60&&elapsed<=60*(activity.timeLimitS??600)){
    event(state,"activity.cash",body.id,activity.id,Math.max(0,activity.rewardCents??0));event(state,"activity.xp",body.id,activity.id,Math.max(0,activity.rewardXp??100));event(state,"activity.finished",body.id,activity.id);
    if(faction==="faction.pauser-completed"||faction==="faction.accelerator-completed")event(state,faction,body.id,activity.id);
    if(!own.completedIds.includes(activity.id))own.completedIds.push(activity.id);own.cooldowns[activity.id]=tick+60*(activity.cooldownS??60);own.activeActivityId="";own.nextDirectorTick=tick+2700;
   }else if(!activity||own.ruleFailed||elapsed>60*(activity.timeLimitS??600)){event(state,"activity.failed",body.id,own.activeActivityId);own.activeActivityId="";}
  }
 }
 return state;
}
