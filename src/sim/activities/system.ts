import { nextU32,seedRng } from "../rng.ts";
import { protectedAreaAt } from "../../content/places.ts";
import { toLatLon } from "../../geo/project.ts";
import { Action } from "../contract.ts";
import { commands,planarDistanceSquared,event,facts,sortedBodies } from "../player/common.ts";
import type { ActivitiesState,ActivityDefinition,GameplayContext,MissionState,PlayerActivities } from "../player/types.ts";
import { activityAvailable } from "./availability.ts";
import { activityMission } from "../missions/system.ts";
import { advanceParking } from "../missions/mechanics/runtime.ts";
import { MISSIONS } from "../../content/catalog.ts";
import { RECON_ID,startRecon,stepRecon } from "./recon.ts";
import { PLAIN_WORDS_ID,plainWordsSpinnersDone,startPlainWords,stepPlainWords } from "./plain-words.ts";
/** A campaign mission that only waits for the player to reach its start area leaves the city open. */
export function missionEngaged(progress:MissionState["players"][string]|undefined,ctx:Pick<GameplayContext,"missions">):boolean {
 if(progress?.status!=="active")return false;
 const mission=ctx.missions.find(m=>m.id===progress.missionId),first=mission?.steps.find(s=>s.id===(mission.start??mission.steps[0]?.id));
 return !(first&&progress.stepId===first.id&&first.type==="trigger"&&first.event.kind==="enterArea");
}
/** The one start rule, shared by the reducer and the start prompt so the UI never offers a dead button. */
export function canStartActivity(a:ActivityDefinition,own:Pick<PlayerActivities,"cooldowns"|"completedIds">,body:{x:number;z:number},tick:number,wave:number,completedMissionIds:readonly string[]=[]):boolean {
 return activityAvailable(a)&&activityUnlocked(a.id,completedMissionIds)&&!["carWash","repairKiosk","vendor","mission"].includes(a.kind)&&a.wave<=wave&&planarDistanceSquared(body,a)<=a.radius*a.radius&&(own.cooldowns?.[a.id]??0)<=tick&&(a.repeatable!==false||!own.completedIds.includes(a.id));
}
/** An activity a mission reward unlocks (`activity:<id>`) opens once that mission is complete. */
export function activityUnlocked(activityId:string,completedMissionIds:readonly string[]):boolean {
 const unlockers=MISSIONS.filter(m=>m.steps.some(s=>s.type==="reward"&&s.grants.some(g=>g.kind==="unlock"&&g.unlock===`activity:${activityId}`)));
 return !unlockers.length||unlockers.some(m=>completedMissionIds.includes(m.id));
}
export function createActivities(tick=0):ActivitiesState{return {version:1,tick,nextId:1,players:{},factCursors:{},events:[]};}
function createOwn(seed:number,tick:number):PlayerActivities{const [roll,rng]=nextU32(seedRng(seed));return {nextDirectorTick:tick+2700+roll%1801,directorRng:rng,activeCardId:"",cardUntilTick:0,cardCooldowns:{},activeActivityId:"",activityStartedTick:0,completedIds:[],commandSequence:0,checkpointIndex:0,objectiveCount:0,cooldowns:{}};}
/** Director schedules are independent per player and persisted in snapshots. */
export function stepActivities(previous:ActivitiesState,ctx:GameplayContext,tick:number,missions:MissionState,seed:number):ActivitiesState {
 const state:ActivitiesState={...previous,tick,players:{},factCursors:{...previous.factCursors},events:[]};const incoming=facts(ctx,tick,state.factCursors);
 for(const body of sortedBodies(ctx)){
  let hash=seed;for(const char of body.id)hash=(Math.imul(hash,31)+char.charCodeAt(0))>>>0;
  const old=previous.players[body.id]??createOwn(hash,tick);const own:PlayerActivities={...old,directorRng:[...old.directorRng],cardCooldowns:{...old.cardCooldowns},completedIds:[...old.completedIds],cooldowns:{...old.cooldowns},...(old.parking?{parking:{...old.parking}}:{}),...(old.recon?{recon:{...old.recon,found:[...old.recon.found]}}:{}),...(old.plainWords?{plainWords:{...old.plainWords,boards:old.plainWords.boards.map(b=>({...b})),spinnerIds:[...old.plainWords.spinnerIds],rusted:[...old.plainWords.rusted]}}:{})};state.players[body.id]=own;
  const missionActive=missionEngaged(missions.players[body.id],ctx);const observation=ctx.observations.find(o=>o.playerId===body.id);
  if(missionActive||own.activeActivityId)own.nextDirectorTick=tick+2700;
  if(own.activeCardId&&tick>=own.cardUntilTick)own.activeCardId="";
  if(!missionActive&&!own.activeActivityId&&!own.activeCardId&&tick>=own.nextDirectorTick){
   const choices=ctx.directorCards.filter(card=>card.fromWave<=ctx.wave&&(own.cardCooldowns[card.id]??0)<=tick&&(!observation?.protectedArea||card.protectedAreas)).sort((a,b)=>a.id<b.id?-1:1);
   const [roll,rng]=nextU32(own.directorRng);own.directorRng=rng;own.nextDirectorTick=tick+2700+roll%1801;
   if(choices.length){const card=choices[roll%choices.length]!,x=body.x+Math.min(75,card.radiusM),z=body.z,location=toLatLon(x,z);if(card.protectedAreas||!protectedAreaAt([location.lat,location.lon])){own.activeCardId=card.id;own.cardUntilTick=tick+1200;own.cardCooldowns[card.id]=tick+Math.ceil(card.cooldownS*60);event(state,"director.stage",body.id,card.id,Math.min(150,card.radiusM),JSON.stringify({x,y:body.y,z}));}}
  }
  for(const command of commands(ctx,body.id,["activity-start","activity-complete"],own.commandSequence)){
   own.commandSequence=command.sequence;
   if(command.kind!=="activity-start"||own.activeActivityId||missionActive)continue;
   const activity=ctx.activities.find(a=>a.id===command.targetId&&canStartActivity(a,own,body,tick,ctx.wave,missions.players[body.id]?.completedIds??[]));
   if(activity){own.activeActivityId=activity.id;own.activityStartedTick=tick;own.checkpointIndex=0;own.objectiveCount=0;event(state,"activity.started",body.id,activity.id);if(activity.id===PLAIN_WORDS_ID)own.plainWords=startPlainWords(state,body.id,tick);if(activity.id===RECON_ID)own.recon=startRecon();}
  }
  if(own.activeActivityId){
   const activity=ctx.activities.find(a=>a.id===own.activeActivityId&&activityAvailable(a));const elapsed=tick-own.activityStartedTick;
   const backing=activity?ctx.missions.find(m=>m.id===activity.id&&activityMission(m,ctx)):undefined;
   const checkpoint=activity?.checkpoints?.[(own.checkpointIndex??0)];if(checkpoint&&planarDistanceSquared(body,checkpoint)<=checkpoint.radius*checkpoint.radius)own.checkpointIndex=(own.checkpointIndex??0)+1;
   for(const fact of incoming)if(activity&&activity.id!==PLAIN_WORDS_ID&&activity.id!==RECON_ID&&!backing&&activity.kind!=="parking"&&fact.playerId===body.id&&fact.kind===(activity.objective?.event??"activity.objective-complete")&&(activity.objective||fact.actorId===activity.id))own.objectiveCount=(own.objectiveCount??0)+1;
   // An activity mission (Office Hours) reports its real outcome; the activity never decides it.
   if(backing){
    for(const done of missions.events)if(done.playerId===body.id&&done.kind===activity!.objective?.event&&done.targetId===backing.id)own.objectiveCount=(own.objectiveCount??0)+1;
   }
   const backingFinished=!!backing&&missions.events.some(done=>done.playerId===body.id&&done.kind==="mission.finished"&&done.targetId===backing.id);
   // Search & Park: on the signed street, a legal stop of the accepted car is the objective.
   if(activity?.kind==="parking"&&(own.checkpointIndex??0)>=Math.max(0,(activity.checkpoints?.length??1)-1)){
    const world=ctx.missionParking,target=world?.targets.find(t=>t.missionId===activity.id&&t.stepId==="park"),vehicle=world?.vehicles.find(v=>v.playerId===body.id);
    const interacting=Boolean((ctx.actions?.[body.id]??0)&Action.interact),before=own.parking;
    if(world&&target&&vehicle&&body.mode==="vehicle"){
     const {progress,stopped}=advanceParking(before?.progress,`${activity.id}:${own.activityStartedTick}`,world,target.bayIds,body,vehicle,tick,before?.tick===tick-1,interacting&&!(before?.interacting??false),target.expectedStayMinutes);
     own.parking={progress,interacting,tick};
     if(stopped){own.objectiveCount=(own.objectiveCount??0)+1;event(state,"parking.legalStop",body.id,stopped);}
    }else own.parking={progress:before?.progress??{requestId:"",bayId:"",stoppedSince:-1,completed:false,settledPose:null},interacting,tick};
   }
   // Coit Tower Recon reads relay signals from the player's own held scan.
   if(activity?.id===RECON_ID&&own.recon)own.objectiveCount=(own.objectiveCount??0)+stepRecon(own.recon,ctx,body,state);
   // Plain Words measures its own boards from the player's water; each wash is one objective.
   if(activity?.id===PLAIN_WORDS_ID&&own.plainWords)own.objectiveCount=(own.objectiveCount??0)+stepPlainWords(own.plainWords,ctx,body.id,tick,incoming,state);
   // Plain Words' checkpoints mark its corridor; the design asks for washes and rust, not a route.
   const routeComplete=activity?.id===PLAIN_WORDS_ID||(own.checkpointIndex??0)>=(activity?.checkpoints?.length??0);
   // Route trials derive their completion from the accepted player trajectory. A
   // photo/relic request only succeeds at the final marked location after the route.
   if(activity?.kind==="timeTrial"&&routeComplete&&elapsed>=60)own.objectiveCount=Math.max(own.objectiveCount??0,1);
   if(activity?.kind==="delivery"&&activity.objective?.event==="delivery.completed"&&routeComplete&&elapsed>=60&&((ctx.actions?.[body.id]??0)&Action.interact))own.objectiveCount=Math.max(own.objectiveCount??0,1);
   if(activity&&["photo","relic"].includes(activity.kind)&&routeComplete&&elapsed>=60&&((ctx.actions?.[body.id]??0)&Action.interact)){
    const final=activity.checkpoints?.at(-1);if(final&&planarDistanceSquared(body,final)<=final.radius*final.radius)own.objectiveCount=Math.max(own.objectiveCount??0,1);
   }
   const objectiveComplete=(own.objectiveCount??0)>=(activity?.objective?.count??1);
   if(activity&&objectiveComplete&&routeComplete&&elapsed>=60&&(activity.id!==PLAIN_WORDS_ID||plainWordsSpinnersDone(own.plainWords))){delete own.plainWords;delete own.parking;delete own.recon;
    event(state,"activity.cash",body.id,activity.id,Math.max(0,activity.rewardCents??0));event(state,"activity.xp",body.id,activity.id,Math.max(0,activity.rewardXp??100));event(state,"activity.finished",body.id,activity.id);
    if(!own.completedIds.includes(activity.id))own.completedIds.push(activity.id);own.cooldowns![activity.id]=tick+60*(activity.cooldownS??60);own.activeActivityId="";own.nextDirectorTick=tick+2700;
   }else if(!activity||elapsed>60*(activity.timeLimitS??600)||backingFinished){event(state,"activity.failed",body.id,own.activeActivityId);own.activeActivityId="";delete own.plainWords;delete own.parking;delete own.recon;}
  }
 }
 return state;
}
