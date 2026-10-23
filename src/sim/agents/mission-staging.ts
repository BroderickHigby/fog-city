import {MISSIONS} from "../../content/catalog.ts";
import type {Mission} from "../../content/missions.ts";
import {toLocal} from "../../geo/project.ts";
import type {SimState} from "../contract.ts";
import {agentsRuntimeOf} from "./runtime.ts";
import {decodeMissionStage,type MissionStage} from "./mission-actors.ts";

export interface PendingMissionStage {
 playerId:string;
 missionStartedTick:number;
 waitStepId:string;
 stage:MissionStage;
 nextTick:number;
 attempts:number;
}
export type PendingMissionStages=Record<string,PendingMissionStage>;
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
export function stageActorAliases(stage:MissionStage):string[]{
 const found=new Set<string>(),visiting=new Set<string>();
 const visit=(alias:string)=>{if(visiting.has(alias))return;visiting.add(alias);const definition=stage.definitions[alias];if(definition?.kind==="crew"&&definition.members?.length)for(const member of definition.members)visit(member);else if(definition)found.add(alias);};
 for(const alias of stage.actorIds)visit(alias);
 return [...found].sort(compare);
}
export function missionStageAccepted(sim:Readonly<SimState>,stage:MissionStage):boolean{
 const runtime=agentsRuntimeOf(sim),aliases=stageActorAliases(stage);
 return aliases.length>0&&aliases.every(alias=>{const actor=runtime?.actors[`mission:${stage.missionId}:${alias}`];return actor&&(actor.retired||(sim.ext.agents?.list??[]).some(body=>body.id===actor.numericId&&body.runtimeId===actor.id));});
}
/** Retry only a bounded set of pending descriptions, never unaccepted runtime actors. */
export function pendingMissionStages(sim:Readonly<SimState>,previous:PendingMissionStages|undefined):PendingMissionStages{
 const runtime=agentsRuntimeOf(sim),result:PendingMissionStages={};
 for(const key of Object.keys(previous??{}).sort(compare)){
  const old=previous![key]!,progress=sim.ext.missions?.players[old.playerId];
  if(!sim.players[old.playerId]||!progress||missionStageAccepted(sim,old.stage))continue;
  if(progress){
   if(progress.status!=="active"||progress.missionId!==old.stage.missionId||progress.startedTick!==old.missionStartedTick)continue;
   if(progress.stepId!==old.waitStepId){
    const step=MISSIONS.find(m=>m.id===progress.missionId)?.steps.find(s=>s.id===progress.stepId);
    if(step?.type!=="objective"||!step.objective.actor||!stageActorAliases(old.stage).includes(step.objective.actor))continue;
   }
  }
  result[key]={...old};
 }
 const add=(playerId:string,stage:MissionStage)=>{
  if(!sim.players[playerId]||missionStageAccepted(sim,stage))return;
  const key=`${playerId}:${stage.missionId}:${stage.stepId}`,progress=sim.ext.missions?.players[playerId];
  if(progress&&(progress.status!=="active"||progress.missionId!==stage.missionId))return;
  if(result[key])return;
  // A newer authored stage supersedes a blocked earlier stage for this player.
  for(const id of Object.keys(result).sort(compare))if(result[id]!.playerId===playerId&&result[id]!.stage.missionId===stage.missionId)delete result[id];
  if(Object.keys(result).length>=64)return;
  result[key]={playerId,stage,missionStartedTick:progress?.startedTick??sim.tick,waitStepId:progress?.stepId??"",nextTick:sim.tick,attempts:0};
 };
 for(const event of sim.ext.missions?.events??[]){const stage=decodeMissionStage(event);if(stage)add(event.playerId,stage);}
 // Old snapshots can contain the binding from a dropped one-shot stage. Recover
 // only a uniquely authored stage for the current active objective and that binding.
 for(const playerId of Object.keys(sim.ext.missions?.players??{}).sort(compare)){
  const progress=sim.ext.missions!.players[playerId]!;if(progress.status!=="active")continue;
  const mission=MISSIONS.find(m=>m.id===progress.missionId),step=mission?.steps.find(s=>s.id===progress.stepId);
  if(!mission||step?.type!=="objective"||!step.objective.actor)continue;
  const alias=step.objective.actor,id=`mission:${mission.id}:${alias}`;
  if(runtime?.actors[id]||runtime?.missionBindings[`${mission.id}:${alias}`]!==id)continue;
  const stages=mission.steps.filter(s=>s.type==="stage").map(s=>authoredStage(mission,s)).filter(stage=>stageActorAliases(stage).includes(alias));
  if(stages.length===1)add(playerId,stages[0]!);
 }
 return result;
}
function authoredStage(mission:Mission,step:Extract<Mission["steps"][number],{type:"stage"}>):MissionStage{
 return {missionId:mission.id,stepId:step.id,actorIds:step.actors,definitions:mission.actors??{},place:{...toLocal(step.place.lat,step.place.lon),y:0},radius:step.place.radiusM};
}
