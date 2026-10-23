import { Action } from "../contract.ts";
import type { Mission,ObjectiveStep,Place } from "../../content/missions.ts";
import { toLocal } from "../../geo/project.ts";
import { distanceSquared } from "../player/common.ts";
import type { GameplayContext,GameplayFact,Position } from "../player/types.ts";

export interface MissionObservedState {
 missionId:string;stepId:string;scannedFalsePositives:string[];watched:string[];melted:string[];coned:string[];
 dirty:boolean;pitchCount:number;lastPitchTick:number;airshowTick:number;commandSequence:number;previousInteract:boolean;
 lastPosition:Position|null;travelled:number;requested:string[];recoveryPosition:Position|null;recoveryId:string;
}
export interface ObservationRequest {kind:string;targetId:string;detail:string}
const OBSERVED_EVENTS = new Set([
 "botCheck.falsePositiveSeen", "demo.robotPresented", "pitch.windowOpened", "pitch.windowCompleted",
 "vehicle.recovered", "fog.nightWindowOpened", "fog.betaFleetLured",
]);
export function createMissionObserved():MissionObservedState{return {missionId:"",stepId:"",scannedFalsePositives:[],watched:[],melted:[],coned:[],dirty:false,pitchCount:0,lastPitchTick:-600,airshowTick:-1,commandSequence:0,previousInteract:false,lastPosition:null,travelled:0,requested:[],recoveryPosition:null,recoveryId:""};}
function location(mission:Mission):Place|undefined {
 const start=mission.steps.find(step=>step.id===(mission.start??mission.steps[0]?.id));return start?.type==="trigger"?start.event.place:undefined;
}
/** Named story facts are measured here; arbitrary completion commands are never accepted. */
export function observeMission(previous:MissionObservedState|undefined,mission:Mission,step:ObjectiveStep,ctx:GameplayContext,playerId:string,tick:number,stepStartedTick:number,incoming:readonly GameplayFact[]):{state:MissionObservedState;handled:boolean;complete:boolean;requests:ObservationRequest[]} {
 const old=previous?.missionId===mission.id?previous:createMissionObserved();
 const state:MissionObservedState={...old,missionId:mission.id,stepId:step.id,scannedFalsePositives:[...old.scannedFalsePositives],watched:[...old.watched],melted:[...old.melted],coned:[...old.coned],requested:[...old.requested],lastPosition:old.lastPosition?{...old.lastPosition}:null,recoveryPosition:old.recoveryPosition?{...old.recoveryPosition}:null};
 const expected=step.objective.kind==="event"?step.objective.event:undefined;
 const handled=expected!==undefined&&OBSERVED_EVENTS.has(expected);
 const body=ctx.bodies.find(body=>body.id===playerId),observation=ctx.observations.find(o=>o.playerId===playerId),requests:ObservationRequest[]=[];
 if(!body)return {state,handled,complete:false,requests};
 const actorId=(alias:string)=>observation?.actorBindings?.[alias]??`mission:${mission.id}:${alias}`;
 const actors=ctx.actorBodies??[];
 const relevant=new Set(Object.keys(mission.actors??{}).sort().flatMap(alias=>[actorId(alias),...(mission.actors?.[alias]?.members??[]).map(actorId)]));
 const append=(list:string[],id:string)=>{if(!list.includes(id))list.push(id);};
 for(const fact of incoming){
  if(fact.playerId!==playerId)continue;
  if(fact.kind==="person.wet"||fact.kind==="economy.penalty")state.dirty=true;
  if(!fact.actorId||!relevant.has(fact.actorId))continue;
  if(fact.kind==="scan.result"&&fact.detail==="bad"&&fact.actorId&&ctx.actors.find(a=>a.id===fact.actorId)?.firmware==="good")append(state.scannedFalsePositives,fact.actorId);
  if(fact.kind==="robot.heap"&&fact.actorId)append(state.melted,fact.actorId);
  if(fact.kind==="cone.placed"&&fact.actorId)append(state.coned,fact.actorId);
 }
 if(observation?.watchingActorId&&relevant.has(observation.watchingActorId)&&(observation.watchedTicks??0)>=180)append(state.watched,observation.watchingActorId);
 if(old.stepId!==step.id){state.travelled=0;state.lastPosition={x:body.x,y:body.y,z:body.z};state.previousInteract=false;}
 if(state.lastPosition){const delta=distanceSquared(body,state.lastPosition);if(delta<=100)state.travelled+=Math.sqrt(delta);}
 state.lastPosition={x:body.x,y:body.y,z:body.z};
 const interacting=!!((ctx.actions?.[playerId]??0)&Action.interact);
 const acknowledgements=ctx.commands.filter(c=>c.playerId===playerId&&c.kind==="mission-ack"&&c.sequence>state.commandSequence).sort((a,b)=>a.sequence-b.sequence);
 const pressed=interacting&&!state.previousInteract||acknowledgements.length>0;
 state.previousInteract=interacting;for(const command of acknowledgements)state.commandSequence=Math.max(state.commandSequence,command.sequence);
 const request=(kind:string,targetId:string,detail:string)=>{const key=`${kind}:${targetId}`;if(!state.requested.includes(key)){state.requested.push(key);requests.push({kind,targetId,detail});}};
 let complete=false;
 if(expected==="botCheck.falsePositiveSeen")complete=state.scannedFalsePositives.includes(actorId("courier"))&&pressed;
 if(expected==="demo.robotPresented"){
  const required=["demoBad","demoGoodA","demoGoodB"].map(actorId);
  complete=new Set(required).size===3&&required.every(id=>state.watched.includes(id))&&state.melted.includes(actorId("demoBad"))&&!state.dirty&&["demoGoodA","demoGoodB"].every(alias=>actors.some(actor=>actor.id===actorId(alias))&&(ctx.rustByActor?.[actorId(alias)]??0)<.3);
 }
 if(expected==="pitch.windowOpened"||expected==="pitch.windowCompleted"){
  const place=location(mission),point=place?{...toLocal(place.lat,place.lon),y:body.y}:null;
  const near=!!point&&distanceSquared(body,point)<=10000;
  if(state.airshowTick<0)state.airshowTick=stepStartedTick;
  request("mission.airshow-request",mission.id,JSON.stringify({periodTicks:360,loudTicks:120}));
  const quiet=(tick-state.airshowTick)%360>=120;
  if(expected==="pitch.windowOpened")complete=near&&quiet;
  else if(near&&quiet&&pressed&&tick-state.lastPitchTick>=60){state.pitchCount++;state.lastPitchTick=tick;complete=state.pitchCount>=3;}
 }
 if(expected==="vehicle.recovered"){
  const id=actorId("escapeCar"),vehicle=actors.find(a=>a.id===id);
  if(vehicle&&state.coned.includes(id)&&Math.abs(vehicle.speed)<.5&&body.mode==="foot"&&distanceSquared(body,vehicle)<=16&&pressed){
   state.recoveryId=id;state.recoveryPosition={x:vehicle.x,y:vehicle.y,z:vehicle.z};request("mission.vehicle-recovery-request",id,JSON.stringify(state.recoveryPosition));
  }
  complete=state.recoveryId===id&&!!state.recoveryPosition&&!!ctx.recoveredVehicleIds?.[playerId]?.includes(id)&&body.mode==="vehicle"&&distanceSquared(body,state.recoveryPosition)<=25;
 }
 if(expected==="fog.nightWindowOpened"){
  request("mission.weather-request",mission.id,JSON.stringify({night:true,fog:.8,durationTicks:36000}));
  complete=((ctx.hour??12)>=20||(ctx.hour??12)<6)&&(observation?.fog??0)>.6;
 }
 if(expected==="fog.betaFleetLured"){
  const members=mission.actors?.fleet?.members??[];
  const ids=members.map(actorId);
  const stage=mission.steps.find(s=>s.type==="stage"),roadX=stage?.type==="stage"?toLocal(stage.place.lat,stage.place.lon).x:body.x;
  complete=Math.abs(body.x-roadX)<=80&&members.length>0&&new Set(ids).size===members.length&&ids.every(id=>{const actor=actors.find(a=>a.id===id);return !!actor&&actor.firmware==="bad"&&distanceSquared(body,actor)<=22500;})&&(observation?.fog??0)>.6&&state.travelled+1e-6>=250;
 }
 return {state,handled,complete,requests};
}
