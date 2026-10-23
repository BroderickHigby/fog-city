import { nextU32,seedRng } from "../rng.ts";
import { commands,distanceSquared,event,facts,sortedBodies } from "../player/common.ts";
import type { ActivitiesState,GameplayContext,MissionState,PlayerActivities } from "../player/types.ts";
export function createActivities(tick=0):ActivitiesState{return {version:1,tick,nextId:1,players:{},factCursors:{},events:[]};}
function createOwn(seed:number,tick:number):PlayerActivities{return {nextDirectorTick:tick+2700,directorRng:seedRng(seed),activeCardId:"",cardUntilTick:0,cardCooldowns:{},activeActivityId:"",activityStartedTick:0,completedIds:[],commandSequence:0};}
/** Director schedules are independent per player and persisted in snapshots. */
export function stepActivities(previous:ActivitiesState,ctx:GameplayContext,tick:number,missions:MissionState,seed:number):ActivitiesState {
 const state:ActivitiesState={...previous,tick,players:{},factCursors:{...previous.factCursors},events:[]};const incoming=facts(ctx,tick,state.factCursors);
 for(const body of sortedBodies(ctx)){
  let hash=seed;for(const char of body.id)hash=(Math.imul(hash,31)+char.charCodeAt(0))>>>0;
  const old=previous.players[body.id]??createOwn(hash,tick);const own:PlayerActivities={...old,directorRng:[...old.directorRng],cardCooldowns:{...old.cardCooldowns},completedIds:[...old.completedIds]};state.players[body.id]=own;
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
   const activity=ctx.activities.find(a=>a.id===command.targetId&&a.wave<=ctx.wave&&distanceSquared(body,a)<=a.radius**2);
   if(activity){own.activeActivityId=activity.id;own.activityStartedTick=tick;event(state,"activity.started",body.id,activity.id);}
  }
  if(own.activeActivityId){
   const activity=ctx.activities.find(a=>a.id===own.activeActivityId);const elapsed=tick-own.activityStartedTick;
   const completion=activity&&incoming.find(f=>f.playerId===body.id&&f.actorId===activity.id&&f.kind==="activity.objective-complete");
   if(activity&&completion&&elapsed>=60){
    event(state,"activity.cash",body.id,activity.id,Math.max(0,activity.rewardCents??0));event(state,"activity.xp",body.id,activity.id,Math.max(0,activity.rewardXp??100));event(state,"activity.finished",body.id,activity.id);
    if(!own.completedIds.includes(activity.id))own.completedIds.push(activity.id);own.activeActivityId="";own.nextDirectorTick=tick+2700;
   }else if(!activity||elapsed>36000){event(state,"activity.failed",body.id,own.activeActivityId);own.activeActivityId="";}
  }
 }
 return state;
}
