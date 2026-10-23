import { clamp } from "../dmath.ts";
import { toLocal } from "../../geo/project.ts";
import type { Mission,Place,Step } from "../../content/missions.ts";
import { commands,distanceSquared,event,facts,sortedBodies,validId } from "../player/common.ts";
import type { GameplayContext,GameplayFact,HeatState,MissionProgress,MissionState,PlayerGameplayState } from "../player/types.ts";

export function createMissionProgress():MissionProgress{return {missionId:"",stepId:"",status:"idle",startedTick:0,stepStartedTick:0,deadlineTick:0,questionIndex:0,objectiveCount:0,objectiveIds:[],meters:{},completedIds:[],rewardedIds:[],retryFrom:"",outcome:"",commandSequence:0,visits:0};}
export function createMissions(tick=0):MissionState{return {version:1,tick,nextId:1,players:{},factCursors:{},events:[]};}
export function missionPlace(place:Place):{x:number;y:number;z:number}{return {...toLocal(place.lat,place.lon),y:0};}
function near(ctx:GameplayContext,id:string,place:Place):boolean {const body=ctx.bodies.find(b=>b.id===id);return !!body&&distanceSquared({...body,y:0},missionPlace(place))<=(place.radiusM??25)*(place.radiusM??25);}
function initial(mission:Mission):string{return mission.start??mission.steps[0]?.id??"";}
function enter(progress:MissionProgress,stepId:string,tick:number):void {progress.stepId=stepId;progress.stepStartedTick=tick;progress.deadlineTick=0;progress.objectiveCount=0;progress.objectiveIds=[];progress.questionIndex=0;progress.visits++;}
function start(progress:MissionProgress,mission:Mission,tick:number):void {progress.missionId=mission.id;progress.status="active";progress.startedTick=tick;progress.meters={};progress.outcome="";progress.visits=0;for(const key of Object.keys(mission.meters).sort())if(validId(key))progress.meters[key]=mission.meters[key]!.start;enter(progress,initial(mission),tick);}

/** A real graph interpreter. All completions come from authoritative facts or measured state. */
export function stepMissions(previous:MissionState,ctx:GameplayContext,tick:number,heat:HeatState,player:PlayerGameplayState):MissionState {
 const state:MissionState={...previous,tick,players:{},factCursors:{...previous.factCursors},events:[]};
 const incoming=facts(ctx,tick,state.factCursors);
 for(const body of sortedBodies(ctx)){
  const old=previous.players[body.id]??createMissionProgress();const own:MissionProgress={...old,meters:{...old.meters},completedIds:[...old.completedIds],rewardedIds:[...old.rewardedIds],objectiveIds:[...old.objectiveIds]};state.players[body.id]=own;
  const eligible=ctx.missions.filter(m=>(m.wave??2)<=ctx.wave).sort((a,b)=>(a.campaign??0)-(b.campaign??0)||(a.id<b.id?-1:1));
  const requests=commands(ctx,body.id,["mission-start","mission-retry","mission-ack","mission-answer","startup-define"],own.commandSequence);
  for(const command of requests){
   if(command.kind==="mission-start"&&(own.status==="idle"||own.status==="complete"||own.status==="failed")){
    const wanted=eligible.find(m=>m.id===command.targetId&&!own.completedIds.includes(m.id));
    const earlier=wanted&&eligible.some(m=>(m.campaign??0)>0&&(m.campaign??0)<(wanted.campaign??0)&&!own.completedIds.includes(m.id));
    if(wanted&&!earlier)start(own,wanted,tick);
   }
   if(command.kind==="mission-retry"&&own.status==="retry"&&tick>=own.deadlineTick){own.status="active";enter(own,own.retryFrom,tick);}
  }
  if(own.status==="idle"){
   const mission=eligible.find(m=>!own.completedIds.includes(m.id));const first=mission?.steps.find(s=>s.id===initial(mission));
   if(mission&&first?.type==="trigger"&&first.event.kind==="enterArea"&&near(ctx,body.id,first.event.place))start(own,mission,tick);
  }
  const mission=eligible.find(m=>m.id===own.missionId);
  if(mission&&own.status==="active")for(let transitions=0;transitions<24;transitions++){
   const step=mission.steps.find(s=>s.id===own.stepId);if(!step||own.visits>4096){own.status="failed";event(state,"mission.invalid",body.id,own.missionId);break;}
   const next=advance(step,mission,own,incoming.filter(f=>f.playerId===body.id));if(!next)break;enter(own,next,tick);
  }
  own.commandSequence=Math.max(own.commandSequence,...requests.map(c=>c.sequence),0);
  if(player.events.some(e=>e.playerId===body.id&&e.kind==="player.acqui-hired")){own.status="retry";own.retryFrom=mission?initial(mission):"";own.deadlineTick=tick+1;}
  function advance(step:Step,mission:Mission,own:MissionProgress,incoming:GameplayFact[]):string|undefined {
   if(step.type==="trigger"){
    if(step.event.clock&&ctx.hour!==undefined&&ctx.minute!==undefined){const [hour,minute]=step.event.clock.split(":").map(Number);if(ctx.hour*60+ctx.minute<(hour??0)*60+(minute??0))return;}
    return step.event.kind==="phoneCall"?requests.some(c=>c.kind==="mission-ack"||c.kind==="mission-start")?step.next:undefined:near(ctx,body.id,step.event.place)?step.next:undefined;
   }
   if(step.type==="goto"){
    own.deadlineTick=own.stepStartedTick+Math.ceil(step.timer.limitS*60);
    if(near(ctx,body.id,step.target)&&(!step.travel||step.travel==="any"||step.travel===body.mode))return step.next;
    return tick>=own.deadlineTick?step.onTimeout:undefined;
   }
   if(step.type==="timer"){own.deadlineTick=own.stepStartedTick+Math.ceil(step.durationS*60);return tick>=own.deadlineTick?step.next:undefined;}
   if(step.type==="stage"){
    event(state,"mission.stage",body.id,mission.id,step.nearHydrantM??0,JSON.stringify({stepId:step.id,actors:step.actors,definitions:mission.actors??{},place:missionPlace(step.place),radius:step.place.radiusM}));return step.next;
   }
   if(step.type==="dialogue"){
    for(const command of requests.filter(c=>c.kind==="mission-answer"&&c.sequence>own.commandSequence)){
     const question=step.questions[own.questionIndex];const answer=question&&question.id===command.questionId?question.answers.find(a=>a.id===command.choiceId):undefined;
     if(!answer)continue;const meter=mission.meters[step.meter];if(meter)own.meters[step.meter]=clamp((own.meters[step.meter]??meter.start)+answer.delta,meter.min,meter.max);own.questionIndex++;own.commandSequence=command.sequence;
    }
    return own.questionIndex>=step.questions.length?step.next:undefined;
   }
   if(step.type==="branch"){const value=own.meters[step.meter]??0;return step.cases.find(c=>(c.min===undefined||value>=c.min)&&(c.max===undefined||value<=c.max))?.next??step.default;}
   if(step.type==="form")return ctx.validKitIds.includes(player.players[body.id]?.startupKitId??"")||requests.some(c=>c.kind==="startup-define"&&c.kitId&&ctx.validKitIds.includes(c.kitId))?step.next:undefined;
   if(step.type==="objective"){
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
     complete=own.objectiveCount>=required;
    }
    if(complete)return step.next;
    if(step.timeLimitS!==undefined){own.deadlineTick=own.stepStartedTick+Math.ceil(step.timeLimitS*60);if(tick>=own.deadlineTick){if(step.onFail)return step.onFail;own.status="failed";}}
    return;
   }
   if(step.type==="retry"){own.status="retry";own.retryFrom=step.retryFrom;own.deadlineTick=tick+Math.ceil((step.cooldownS??0)*60);own.outcome=step.outcome;event(state,"mission.retry",body.id,mission.id,own.deadlineTick,step.outcome);return;}
   if(step.type==="reward"){
    const rewardId=`${mission.id}:${step.id}`;
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
   function finish(outcome:string):void {own.outcome=outcome;own.status=mission.outcomes[outcome]?.kind==="success"||(mission as Mission&{advanceOnAnyOutcome?:boolean}).advanceOnAnyOutcome?"complete":"failed";if(own.status==="complete"&&!own.completedIds.includes(mission.id))own.completedIds.push(mission.id);event(state,"mission.finished",body.id,mission.id,0,outcome);}
  }
 }
 return state;
}
