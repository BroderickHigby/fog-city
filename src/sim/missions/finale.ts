import { Action } from "../contract.ts";
import { dcos,dsin } from "../dmath.ts";
import { toLocal } from "../../geo/project.ts";
import type { Mission,ObjectiveStep } from "../../content/missions.ts";
import type { GameplayContext,Position } from "../player/types.ts";
import { distanceSquared } from "../player/common.ts";
import type { ObservationRequest } from "./observed.ts";

export interface FinaleState {generation:number;requested:string[];rusted:string[];previousInteract:boolean;commandSequence:number;watchTicks:number;sawEntrance:boolean;lastWatchTick:number;lastFootfall:number;freedRequested:boolean}
export function createFinale():FinaleState{return {generation:-1,requested:[],rusted:[],previousInteract:false,commandSequence:0,watchTicks:0,sawEntrance:false,lastWatchTick:-2,lastFootfall:-300,freedRequested:false};}
/** Scripted set-piece progression still requires observed physical actors and real rust. */
export function stepFinale(previous:FinaleState|undefined,mission:Mission,step:ObjectiveStep,ctx:GameplayContext,playerId:string,tick:number,stepStartedTick:number):{state:FinaleState;complete:boolean;requests:ObservationRequest[]} {
 const state={...(previous??createFinale()),requested:[...(previous?.requested??[])],rusted:[...(previous?.rusted??[])]},requests:ObservationRequest[]=[];
 if(!Number.isSafeInteger(state.generation)||state.generation<0)state.generation=tick;
 const prefix=`mission:${mission.id}:`,id=(role:string)=>prefix+role,actors=ctx.actorBodies??[],body=ctx.bodies.find(p=>p.id===playerId);
 if(!body)return {state,requests,complete:false};
 const place=(stepId:string):Position=>{const s=mission.steps.find(s=>s.id===stepId);if(s?.type==="goto")return {...toLocal(s.target.lat,s.target.lon),y:body.y};if(s?.type==="trigger")return {...toLocal(s.event.place.lat,s.event.place.lon),y:body.y};return {x:body.x,y:body.y,z:body.z};};
 const request=(kind:string,targetId:string,detail:unknown,key=kind+":"+targetId)=>{if(!state.requested.includes(key)){state.requested.push(key);requests.push({kind,targetId,detail:JSON.stringify(detail)});}};
 const expected=step.objective.kind==="event"?step.objective.event:"",phase=expected==="boss.pitchSurvived"?"waterfront":expected==="boss.kneesRusted"||expected==="boss.robotsFreed"?"bridge":"start",anchor=place(phase);
 const jointRoles=phase==="bridge"?["knee-left","knee-right"]:["ankle-left","ankle-right"];
 const phaseActors=phase==="waterfront"?[0,1,2].map(n=>({id:id(`paper-${n}`),role:"paper-drone",model:"drone",firmware:"bad",offset:{x:(n-1)*6,z:-8},radius:.8,height:2.5})):
  jointRoles.map((role,n)=>({id:id(role),role:"weakpoint",model:"walker",firmware:"bad",offset:{x:n===0?-4:4,z:6},radius:1.4,height:3,rustScale:.3}));
 request("mission.scene-request",mission.id,{id:`${mission.id}:${state.generation}:${phase}`,missionId:mission.id,phase,anchor,actors:[
  {id:id("walker"),role:"giant-walker",model:"walker",firmware:"bad",offset:{x:0,z:18},radius:8,height:500,protected:true,scriptedGeometry:true},
  {id:id("fireboat"),role:"fireboat",model:"van",firmware:"good",offset:{x:0,z:3},radius:2.5,height:4,protected:true,watercraft:true},
  ...phaseActors,
 ]},`scene:${phase}`);
 const interacting=!!((ctx.actions?.[playerId]??0)&Action.interact),keys=ctx.commands.filter(c=>c.playerId===playerId&&c.kind==="mission-ack"&&c.sequence>state.commandSequence).sort((a,b)=>a.sequence-b.sequence),pressed=interacting&&!state.previousInteract||keys.length>0;
 state.previousInteract=interacting;for(const key of keys)state.commandSequence=Math.max(state.commandSequence,key.sequence);
 const walker=actors.find(a=>a.id===id("walker")),boat=actors.find(a=>a.id===id("fireboat"));let complete=false;
 if(expected==="boss.entranceSeen"){
  const heading=ctx.lookHeadingByPlayer?.[playerId],dx=(walker?.x??0)-body.x,dz=(walker?.z??0)-body.z,forward=heading===undefined?0:dx*dsin(heading)-dz*dcos(heading);
  const visible=!!walker&&walker.height>=400&&!!ctx.visibleActorIds?.[playerId]?.includes(walker.id)&&forward>0&&forward*forward>=(dx*dx+dz*dz)*.5&&!!((ctx.actions?.[playerId]??0)&Action.watch);
  state.watchTicks=visible?(state.lastWatchTick===tick-1?state.watchTicks+1:1):0;state.lastWatchTick=tick;
  if(state.watchTicks>=180){state.sawEntrance=true;complete=true;}
 }
 if(expected==="boss.fireboatBoarded"){
  if(boat&&distanceSquared(body,boat)<=25&&pressed)request("mission.control-request",boat.id,{id:`${mission.id}:${state.generation}:${playerId}:fireboat`,playerId,actorId:boat.id,action:"enter",origin:{x:body.x,y:body.y,z:body.z}});
  complete=!!boat&&ctx.controlledActorIds?.[playerId]===boat.id&&distanceSquared(body,boat)<=4;
 }
 const rusted=(role:string)=>{const targetId=id(role),phase=ctx.actorPhases?.[targetId];if(state.rusted.includes(targetId))return true;const done=!!actors.find(a=>a.id===targetId)&&(ctx.damageOwnerIds?.[targetId]===playerId)&&((ctx.rustByActor?.[targetId]??0)>=1||phase==="heap"||phase==="seized"||phase==="disabled");if(done)state.rusted.push(targetId);return done;};
 if(expected==="boss.anklesRusted")complete=state.sawEntrance&&!!walker&&rusted("ankle-left")&&rusted("ankle-right");
 if(expected==="boss.pitchSurvived")complete=!!walker&&distanceSquared(walker,anchor)<=40000&&tick-stepStartedTick>=1200&&[0,1,2].every(n=>rusted(`paper-${n}`));
 if(expected==="boss.kneesRusted")complete=!!walker&&distanceSquared(walker,anchor)<=40000&&rusted("knee-left")&&rusted("knee-right");
 if(expected==="boss.robotsFreed"){
  const freed=Array.from({length:6},(_,n)=>id(`freed-${n}`));
  if(rusted("knee-left")&&rusted("knee-right")){state.freedRequested=true;request("mission.restore-fleet-request",mission.id,{actorIds:freed,bodyId:id("walker"),removeShell:true});}
  complete=state.freedRequested&&freed.every(target=>actors.some(a=>a.id===target&&a.firmware==="good"))&&(!walker||ctx.actorPhases?.[walker.id]==="cleared");
 }
 // The core must revalidate this clearance when applying the one-tick request.
 if(walker&&walker.height>=400&&tick-state.lastFootfall>=300&&expected!=="boss.robotsFreed"){
  const centre={x:walker.x+(Math.floor(tick/300)%2===0?-12:12),y:walker.y,z:walker.z+6},radius=20;
  const overlaps=(position:{x:number;z:number},bodyRadius:number)=>{const x=position.x-centre.x,z=position.z-centre.z,r=radius+bodyRadius;return x*x+z*z<=r*r;};
  const occupied=actors.some(a=>(a.kind==="person"||a.kind==="animal")&&overlaps(a,a.radius))||ctx.bodies.some(p=>overlaps(p,p.mode==="vehicle"?3:.5));
  if(occupied)request("mission.evacuate-request",walker.id,{tick,centre,radius,untilTick:tick+300},`evacuate:${Math.floor(tick/300)}`);
  else {state.lastFootfall=tick;requests.push({kind:"mission.footfall-request",targetId:walker.id,detail:JSON.stringify({tick,centre,radius,requiresClearance:true})});}
 }
 return {state,complete,requests};
}
