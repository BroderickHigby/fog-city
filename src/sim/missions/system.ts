import { observeMission } from "./observed.ts";
import { prepareMissionParking } from "./mechanics/runtime.ts";
import { DUEL_WIN_CENTS, DUEL_WIN_QUARTERS, prepareMissionBell } from "./mechanics/bell.ts";
import { clamp } from "../dmath.ts";
import { toLocal } from "../../geo/project.ts";
import type { Mission,Place,Step } from "../../content/missions.ts";
import { commands,distanceSquared,event,facts,sortedBodies,validId } from "../player/common.ts";
import type { ActivitiesState,GameplayContext,GameplayFact,HeatState,MissionProgress,MissionState,PlayerGameplayState } from "../player/types.ts";

/** Completion facts with a single measured producer; copies from any other source are dropped. */
const MEASURED_FACTS=new Set(["demo.parkedLegally","demo.robotPresented","botCheck.falsePositiveSeen","bell.duelStarted","bell.cue","bell.ring","bell.roundWon","bell.roundLost","bell.duelWon","bell-duel.lost"]);
export function createMissionProgress():MissionProgress{return {missionId:"",stepId:"",status:"idle",startedTick:0,stepStartedTick:0,deadlineTick:0,questionIndex:0,objectiveCount:0,objectiveIds:[],meters:{},completedIds:[],rewardedIds:[],retryFrom:"",outcome:"",commandSequence:0,visits:0};}
export function createMissions(tick=0):MissionState{return {version:1,tick,nextId:1,players:{},factCursors:{},events:[]};}
export function missionPlace(place:Place):{x:number;y:number;z:number}{return {...toLocal(place.lat,place.lon),y:0};}
function near(ctx:GameplayContext,id:string,place:Place):boolean {const body=ctx.bodies.find(b=>b.id===id);return !!body&&distanceSquared({...body,y:0},missionPlace(place))<=(place.radiusM??25)*(place.radiusM??25);}
function initial(mission:Mission):string{return mission.start??mission.steps[0]?.id??"";}
function enter(progress:MissionProgress,stepId:string,tick:number):void {progress.stepId=stepId;progress.stepStartedTick=tick;if(progress.stepPausedTicks!==undefined)progress.stepPausedTicks=0;progress.deadlineTick=0;progress.objectiveCount=0;progress.objectiveIds=[];progress.questionIndex=0;progress.visits++;}
function attemptId(playerId:string,tick:number):string {let hash=2166136261;for(const char of playerId)hash=Math.imul(hash^char.charCodeAt(0),16777619);return `a${tick}-${hash>>>0}`;}
function start(progress:MissionProgress,mission:Mission,tick:number,playerId:string):void {progress.missionId=mission.id;progress.status="active";progress.startedTick=tick;if(progress.pausedTicks!==undefined)progress.pausedTicks=0;progress.meters={};progress.outcome="";progress.visits=0;if((mission.wave??2)>=3)progress.actorAttempt=attemptId(playerId,tick);else delete progress.actorAttempt;delete progress.observed;for(const key of Object.keys(mission.meters).sort())if(validId(key))progress.meters[key]=mission.meters[key]!.start;enter(progress,initial(mission),tick);}

/** A real graph interpreter. All completions come from authoritative facts or measured state. */
/** A side activity backed by a mission of the same id (Ramen Office Hours): repeatable, never part of the campaign. */
export function activityMission(mission:Pick<Mission,"id"|"campaign">,ctx:Pick<GameplayContext,"activities">):boolean {return mission.campaign===undefined&&ctx.activities.some(a=>a.id===mission.id);}
export function stepMissions(previous:MissionState,ctx:GameplayContext,tick:number,heat:HeatState,player:PlayerGameplayState,seed=0,activities?:Pick<ActivitiesState,"players"|"events">):MissionState {
 const state:MissionState={...previous,tick,players:{},factCursors:{...previous.factCursors},events:[]};
 const parking=ctx.wave>=3?prepareMissionParking(previous.parking,previous,ctx,tick):undefined;
 if(parking)state.parking=parking.state;
 // Authored completion facts have a single producer. External copies cannot bypass measurement.
 const bell=ctx.wave>=4?prepareMissionBell(previous.bell,previous,ctx,heat,tick,seed):undefined;
 if(bell)state.bell=bell.state;
 const incoming=facts({...ctx,facts:[...ctx.facts.filter(f=>!MEASURED_FACTS.has(f.kind)),...parking?.facts??[],...bell?.facts??[]]},tick,state.factCursors);
 // The duel's beats are public (UI cues, audio) and its result moves heat, cash and the player.
 for(const fact of bell?.facts??[]){
  event(state,fact.kind,fact.playerId,fact.actorId??"",fact.amount??0,fact.detail??"");
  if(fact.kind==="bell.duelWon"){
   const quarters=heat.players[fact.playerId]?.vcQuarters??0;
   if(quarters>DUEL_WIN_QUARTERS)event(state,"mission.vc",fact.playerId,"bell-duel",(DUEL_WIN_QUARTERS-quarters)/4);
   event(state,"mission.cash",fact.playerId,"bell-duel",DUEL_WIN_CENTS);
  }
 }
 for(const body of sortedBodies(ctx)){
  const old=previous.players[body.id]??createMissionProgress();const own:MissionProgress={...old,meters:{...old.meters},completedIds:[...old.completedIds],rewardedIds:[...old.rewardedIds],objectiveIds:[...old.objectiveIds]};state.players[body.id]=own;
  const eligible=ctx.missions.filter(m=>(m.wave??2)<=ctx.wave).sort((a,b)=>(a.campaign??0)-(b.campaign??0)||(a.id<b.id?-1:1));
  const requests=commands(ctx,body.id,["mission-start","mission-retry","mission-ack","mission-answer","startup-define"],own.commandSequence);
  for(const command of requests){
   if(command.kind==="mission-start"&&(own.status==="idle"||own.status==="complete"||own.status==="failed")){
    // Activity missions start only through their activity (door, cooldown and unlock).
    const wanted=eligible.find(m=>m.id===command.targetId&&!own.completedIds.includes(m.id)&&!activityMission(m,ctx));
    const earlier=wanted&&eligible.some(m=>(m.campaign??0)>0&&(m.campaign??0)<(wanted.campaign??0)&&!own.completedIds.includes(m.id));
    if(wanted&&!earlier)start(own,wanted,tick,body.id);
   }
   if(command.kind==="mission-retry"&&own.status==="retry"&&tick>=own.deadlineTick){own.status="active";own.startedTick=tick;if(own.pausedTicks!==undefined)own.pausedTicks=0;own.actorAttempt=attemptId(body.id,tick);delete own.observed;enter(own,own.retryFrom,tick);}
  }
  // A side activity in progress keeps the campaign's start area from firing until it ends.
  const busy=Boolean(activities?.players[body.id]?.activeActivityId);
  // The activity system already checked the door, the cooldown and the unlock: start its mission.
  for(const started of activities?.events??[]){
   const backing=started.kind==="activity.started"&&started.playerId===body.id?ctx.missions.find(m=>m.id===started.targetId&&activityMission(m,ctx)&&(m.wave??2)<=ctx.wave):undefined;
   const waiting=eligible.find(m=>m.id===own.missionId),first=waiting?.steps.find(s=>s.id===initial(waiting));
   const unengaged=own.status==="active"&&first?.type==="trigger"&&first.event.kind==="enterArea"&&own.stepId===first.id;
   if(backing&&(unengaged||own.status!=="active"&&own.status!=="retry")){const pending=unengaged?own.missionId:undefined;start(own,backing,tick,body.id);if(pending)own.pendingCampaignId=pending;}
  }
  if(own.status==="idle"&&!busy){
   const mission=eligible.find(m=>m.campaign!==undefined&&!own.completedIds.includes(m.id));const first=mission?.steps.find(s=>s.id===initial(mission));
   if(mission&&first?.type==="trigger"&&first.event.kind==="enterArea"&&near(ctx,body.id,first.event.place))start(own,mission,tick,body.id);
  }
  const mission=eligible.find(m=>m.id===own.missionId);
  if(mission&&own.status==="active")for(let transitions=0;transitions<24;transitions++){
   const step=mission.steps.find(s=>s.id===own.stepId);if(!step||own.visits>4096){own.status="failed";event(state,"mission.invalid",body.id,own.missionId);break;}
   const next=advance(step,mission,own,incoming.filter(f=>f.playerId===body.id));if(!next)break;enter(own,next,tick);
  }
  own.commandSequence=Math.max(own.commandSequence,...requests.map(c=>c.sequence),0);
  if(player.events.some(e=>e.playerId===body.id&&e.kind==="player.acqui-hired")){own.status="retry";own.retryFrom=mission?initial(mission):"";own.deadlineTick=tick+1;}
  function advance(step:Step,mission:Mission,own:MissionProgress,incoming:GameplayFact[]):string|undefined {
   if(step.type==="trigger")return step.event.kind==="phoneCall"?requests.some(c=>c.kind==="mission-ack")?step.next:undefined:!busy&&near(ctx,body.id,step.event.place)?step.next:undefined;
   if(step.type==="goto"){
    own.deadlineTick=own.stepStartedTick+Math.ceil(step.timer.limitS*60)+(own.stepPausedTicks??0);
    if(near(ctx,body.id,step.target)&&(!step.travel||step.travel==="any"||step.travel===body.mode))return step.next;
    return tick>=own.deadlineTick?step.onTimeout:undefined;
   }
   if(step.type==="timer"){own.deadlineTick=own.stepStartedTick+Math.ceil(step.durationS*60)+(own.stepPausedTicks??0);return tick>=own.deadlineTick?step.next:undefined;}
   if(step.type==="stage"){
    event(state,"mission.stage",body.id,mission.id,step.nearHydrantM??0,JSON.stringify({...(own.actorAttempt?{attemptId:own.actorAttempt}:{}),stepId:step.id,actors:step.actors,definitions:mission.actors??{},place:missionPlace(step.place),radius:step.place.radiusM}));return step.next;
   }
   if(step.type==="dialogue"){
    for(const command of requests.filter(c=>c.kind==="mission-answer"&&c.sequence>own.commandSequence)){
     const question=step.questions[own.questionIndex];const answer=question&&question.id===command.questionId?question.answers.find(a=>a.id===command.choiceId):undefined;
     if(!answer)continue;const meter=mission.meters[step.meter];if(meter)own.meters[step.meter]=clamp((own.meters[step.meter]??meter.start)+answer.delta,meter.min,meter.max);own.questionIndex++;own.commandSequence=command.sequence;
    }
    return own.questionIndex>=step.questions.length?step.next:undefined;
   }
   if(step.type==="branch"){const value=own.meters[step.meter]??0;return step.cases.find(c=>(c.min===undefined||value>=c.min)&&(c.max===undefined||value<=c.max))?.next??step.default;}
   if(step.type==="form")return requests.some(c=>c.kind==="startup-define"&&c.kitId&&ctx.validKitIds.includes(c.kitId))?step.next:undefined;
   if(step.type==="objective"){
    const measured=observeMission(own.observed,mission,step,ctx,body.id,tick,own.startedTick,incoming);
    if(ctx.wave>=3)own.observed=measured.state;
    if(measured.handled){
     if(measured.complete){event(state,step.objective.kind==="event"?step.objective.event!:"mission.observed",body.id,mission.id);return step.next;}
     if(step.timeLimitS!==undefined){own.deadlineTick=own.stepStartedTick+Math.ceil(step.timeLimitS*60)+(own.stepPausedTicks??0);if(tick>=own.deadlineTick){if(step.onFail)return step.onFail;own.status="failed";}}
     return;
    }
    const objective=step.objective;const observation=ctx.observations.find(o=>o.playerId===body.id);const target=objective.actor?(observation?.actorBindings?.[objective.actor]??`mission:${mission.id}:${objective.actor}`):undefined;
    const kind=objective.kind as string;const required=Math.max(1,objective.count??1);let complete=false;
    if(kind==="watch")complete=observation?.watchingActorId===target&&(observation?.watchedTicks??0)>=(objective.seconds??3)*60;
    else if(kind==="threatAtLeast")complete=(heat.players[body.id]?.threat??0)>=(objective.level??1);
    else if(kind==="threatAtMost")complete=(heat.players[body.id]?.threat??0)<=(objective.level??0);
    else if(kind==="enterVehicle")complete=body.mode==="vehicle";
    else {
     const mapping:Record<string,string>={melt:"robot.heap",scan:"scan.result",cone:"cone.placed",interruptUpdate:"update.interrupted",refill:"water.refilled"};
     const expected=kind==="event"?(objective as typeof objective&{event?:string}).event:mapping[kind];
     const members=objective.actor?mission.actors?.[objective.actor]?.members:undefined;
     const targets=members?.map(alias=>observation?.actorBindings?.[alias]??`mission:${mission.id}:${alias}`)??(target?[target]:[]);
     for(const fact of incoming)if(expected&&fact.kind===expected&&(!targets.length||targets.includes(fact.actorId??""))&&!own.objectiveIds.includes(fact.id)){own.objectiveIds.push(fact.id);own.objectiveCount++;}
     if(kind==="melt"&&targets.length&&own.observed){const melted=targets.filter(id=>own.observed!.melted.includes(id));own.objectiveCount=Math.max(own.objectiveCount,melted.length);}
     complete=own.objectiveCount>=required;
    }
    if(complete)return step.next;
    if(step.timeLimitS!==undefined){own.deadlineTick=own.stepStartedTick+Math.ceil(step.timeLimitS*60)+(own.stepPausedTicks??0);if(tick>=own.deadlineTick){if(step.onFail)return step.onFail;own.status="failed";}}
    return;
   }
   if(step.type==="retry"){own.status="retry";own.retryFrom=step.retryFrom;own.deadlineTick=tick+Math.ceil((step.cooldownS??0)*60);own.outcome=step.outcome;event(state,"mission.retry",body.id,mission.id,own.deadlineTick,step.outcome);return;}
   if(step.type==="reward"){
    // A repeatable activity mission pays once per booking; campaign rewards pay once ever.
    const rewardId=activityMission(mission,ctx)?`${mission.id}:${step.id}:${own.startedTick}:${activities?.players[body.id]?.officeHoursSequence??0}`:`${mission.id}:${step.id}`;
    if(!own.rewardedIds.includes(rewardId)){
     own.rewardedIds.push(rewardId);
     for(const grant of step.grants){
      if(grant.kind==="stat")event(state,grant.stat==="cash"?"mission.cash":grant.stat==="runway"?"mission.runway":grant.stat==="reputation"?"mission.reputation":grant.stat==="vcAttention"?"mission.vc":grant.stat==="xp"?"mission.xp":"mission.stat",body.id,grant.stat,grant.stat==="cash"?Math.round(grant.delta*100):grant.delta);
      else if(grant.kind==="unlock")event(state,"mission.unlock",body.id,grant.unlock);
      else event(state,"mission.billboard",body.id,grant.corridor,0,JSON.stringify(grant));
     }
     if(!step.next&&!step.grants.some(g=>g.kind==="stat"&&g.stat==="xp"))event(state,"mission.xp",body.id,mission.id,500+150*Math.max(0,(mission.campaign??1)-1));
    }
    if(step.next)return step.next;
    finish(step.outcome);return;
   }
   if(step.type==="end")finish(step.outcome);
   function finish(outcome:string):void {own.outcome=outcome;own.status=mission.outcomes[outcome]?.kind==="success"||(mission as Mission&{advanceOnAnyOutcome?:boolean}).advanceOnAnyOutcome?"complete":"failed";if(own.status==="complete"&&!own.completedIds.includes(mission.id))own.completedIds.push(mission.id);event(state,"mission.finished",body.id,mission.id,0,outcome);
    // An activity mission hands the city back: the campaign picks up again at its start areas.
    if(activityMission(mission,ctx)){
     own.status="idle";
     const pending=ctx.missions.find(candidate=>candidate.id===own.pendingCampaignId&&!own.completedIds.includes(candidate.id));
     delete own.pendingCampaignId;
     if(pending){start(own,pending,tick,body.id);own.outcome=outcome;}
    }}
  }
 }
 return state;
}
