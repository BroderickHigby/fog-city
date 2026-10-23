import { Action } from "../contract.ts";
import { toLocal } from "../../geo/project.ts";
import type { Mission,ObjectiveStep } from "../../content/missions.ts";
import { distanceSquared } from "../player/common.ts";
import type { GameplayContext } from "../player/types.ts";
import type { ObservationRequest } from "./observed.ts";

export interface TeleoperationState {requested:string[];checkpoint:number;lastInteract:boolean;commandSequence:number;exposed:boolean;exitRequested:boolean}
export function createTeleoperation():TeleoperationState{return {requested:[],checkpoint:0,lastInteract:false,commandSequence:0,exposed:false,exitRequested:false};}
/** This only requests control. Core must accept movement and echo the controlled actor ID. */
export function stepTeleoperation(previous:TeleoperationState|undefined,mission:Mission,step:ObjectiveStep,ctx:GameplayContext,playerId:string,tick:number):{state:TeleoperationState;complete:boolean;failed:boolean;requests:ObservationRequest[]} {
 const state={...(previous??createTeleoperation()),requested:[...(previous?.requested??[])]},requests:ObservationRequest[]=[];
 const prefix=`mission:${mission.id}:`,id=(role:string)=>prefix+role,actors=ctx.actorBodies??[],body=ctx.bodies.find(p=>p.id===playerId);
 if(!body)return {state,requests,complete:false,failed:false};
 const start=mission.steps.find(s=>s.type==="trigger"),anchor=start?.type==="trigger"?{...toLocal(start.event.place.lat,start.event.place.lon),y:body.y}:{x:body.x,y:body.y,z:body.z};
 const request=(kind:string,targetId:string,detail:unknown)=>{const key=`${kind}:${targetId}`;if(!state.requested.includes(key)){state.requested.push(key);requests.push({kind,targetId,detail:JSON.stringify(detail)});}};
 request("mission.scene-request",mission.id,{id:`${mission.id}:${tick}`,missionId:mission.id,anchor,actors:[
  {id:id("van"),role:"teleoperation-van",model:"van",firmware:"good",offset:{x:4,z:0},radius:1.1,height:2.2,protected:true},
  {id:id("unit"),role:"teleoperation-unit",model:"footman",firmware:"good",offset:{x:6,z:0},radius:.4,height:1.8},
  {id:id("pickup"),role:"delivery-pickup",model:"footman",firmware:"good",offset:{x:10,z:10},radius:.4,height:1.8,protected:true},
  {id:id("recipient"),role:"delivery-recipient",model:"person",firmware:"none",offset:{x:-20,z:30},radius:.4,height:1.8,protected:true},
  {id:id("server"),role:"update-server",model:"tidy",firmware:"good",offset:{x:-35,z:10},radius:.6,height:1.3,protected:true},
 ]});
 const keys=ctx.commands.filter(c=>c.playerId===playerId&&c.kind==="mission-ack"&&c.sequence>state.commandSequence).sort((a,b)=>a.sequence-b.sequence);
 const interacting=!!((ctx.actions?.[playerId]??0)&Action.interact),pressed=interacting&&!state.lastInteract||keys.length>0;
 state.lastInteract=interacting;for(const key of keys)state.commandSequence=Math.max(state.commandSequence,key.sequence);
 const controlled=ctx.controlledActorIds?.[playerId]??"",unit=actors.find(a=>a.id===id("unit")),van=actors.find(a=>a.id===id("van"));
 const operates=controlled===id("unit")&&!!unit&&distanceSquared(body,unit)<=1;
 if(operates&&((ctx.actions?.[playerId]??0)&(Action.fire|Action.scan|Action.cone)))state.exposed=true;
 if(state.exposed&&controlled===id("unit")){state.exitRequested=true;request("mission.control-request",id("unit")+":drop",{id:`${mission.id}:${playerId}:drop:${tick}`,playerId,actorId:id("unit"),action:"exit"});}
 let complete=false;
 const expected=step.objective.kind==="event"?step.objective.event:"";
 if(expected==="teleoperation.connected"){
  if(van&&unit&&body.mode==="foot"&&distanceSquared(body,van)<=16&&pressed)request("mission.control-request",id("unit"),{id:`${mission.id}:${playerId}:enter:${tick}`,playerId,actorId:id("unit"),action:"enter",origin:{x:body.x,y:body.y,z:body.z}});
  complete=operates&&state.requested.includes(`mission.control-request:${id("unit")}`);
 }
 if(expected==="teleoperation.coverTaskCompleted"&&operates&&!state.exposed){
  const target=actors.find(a=>a.id===id(state.checkpoint===0?"pickup":"recipient"));
  if(target&&Math.abs(body.speed)<=1&&distanceSquared(body,target)<=9&&pressed)state.checkpoint++;
  complete=state.checkpoint>=2;
 }
 if(expected==="teleoperation.serverFound"&&operates&&!state.exposed){const server=actors.find(a=>a.id===id("server"));complete=!!server&&distanceSquared(body,server)<=9&&Math.abs(body.speed)<=1&&pressed;}
 if(expected==="teleoperation.disconnected"){
  if(operates&&pressed){state.exitRequested=true;request("mission.control-request",id("unit")+":exit",{id:`${mission.id}:${playerId}:exit:${tick}`,playerId,actorId:id("unit"),action:"exit"});}
  complete=state.exitRequested&&controlled===""&&!!van&&distanceSquared(body,van)>144;
 }
 return {state,requests,complete,failed:state.exposed};
}
