import type {SimState} from "../contract.ts";
import type {ThreatSpawnRequest} from "../gameplay-contract.ts";
import {isGameplayId} from "../gameplay-contract.ts";
import {datan2,dcos,dsin} from "../dmath.ts";
import {groundHeight,segmentBlocked,type World} from "../world.ts";
import {microclimateBlocksSight} from "../combat/microclimate.ts";
import {createFollowerState,stepVehicleFollower,type FollowerState} from "../vehicles/follower.ts";
import type {ActorBlueprint} from "./mission-actors.ts";
import {planMissionActors} from "./mission-actors.ts";
import {agentsRuntimeOf,type AgentRuntimeOptions,type RuntimeMovementGoal} from "./runtime.ts";
import {serviceRoadPoint,threatRequestsOf} from "./service-runtime.ts";
export interface ThreatUnit {id:string;kind:Exclude<ThreatSpawnRequest["kind"],"van">;playerId:string;requestId:string;bornTick:number;lastSeenTick:number;lastKnown:{x:number;z:number};follower:FollowerState|null;roadTarget?:{x:number;z:number;heading?:number};roadSample?:{x:number;z:number}}
export interface ThreatRuntimeState {version:1;tick:number;receipts:{id:string;tick:number}[];units:Record<string,ThreatUnit>}
export interface ThreatFrame {state:ThreatRuntimeState;spawns:ActorBlueprint[];goals:Record<string,RuntimeMovementGoal>;controls:NonNullable<AgentRuntimeOptions["vehicleControls"]>;retirements:string[]}
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const distance=(a:{x:number;z:number},b:{x:number;z:number})=>Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.z-b.z)*(a.z-b.z));
const goals={forcedUpdate:0,shove:0,grocerySnatch:0,handshake:0,adBlast:0,phoneHack:0};
/** Dispatch facts seed last-known positions; subsequent pursuit updates require actual sight. */
export function planThreatRuntime(world:World,sim:Readonly<SimState>,previous:ThreatRuntimeState|undefined,options:AgentRuntimeOptions,reserved:readonly ActorBlueprint[]=[]):ThreatFrame {
 const runtime=agentsRuntimeOf(sim),actors=Object.keys(runtime?.actors??{}).sort().map(id=>runtime!.actors[id]!);
 const units:Record<string,ThreatUnit>={};for(const id of Object.keys(previous?.units??{}).sort()){const old=previous!.units[id]!;if(sim.tick-old.bornTick<10800||actors.some(a=>a.id===id&&!a.retired))units[id]={...old,lastKnown:{...old.lastKnown}};}
 const receipts=(previous?.receipts??[]).filter(r=>sim.tick-r.tick<=10800).map(r=>({...r}));
 const state:ThreatRuntimeState={version:1,tick:sim.tick,receipts,units},controls:Record<string,ReturnType<typeof stepVehicleFollower>["input"]>={};
 const frame:ThreatFrame={state,spawns:[],goals:{},controls,retirements:[]};
 for(const request of threatRequestsOf(sim)){
  if(request.kind==="van"||request.requestTick<=sim.tick-600||receipts.some(r=>r.id===request.id)||receipts.length>=128)continue;
  if(request.kind==="drone"&&!options.allowFlying)continue;
  receipts.push({id:request.id,tick:request.requestTick});
  const capacity=64-Object.keys(units).filter(id=>!runtime?.actors[id]?.retired).length;
  const count=Math.min(request.unitCount,Math.max(0,capacity));
  if(request.kind==="taxi"){
   const target=serviceRoadPoint(world,request.player,0,15,0,[]);
   for(let i=0;i<count;i++){
    const id=`response:${request.id}:${i}`;if(!isGameplayId(id))continue;
    const blockers=[...actors.filter(a=>!a.retired),...reserved,...frame.spawns,...Object.keys(sim.players).sort().flatMap(id=>{const p=sim.players[id]!;return [{...p.car,radius:3},...(p.foot?[{...p.foot,radius:.4}]:[])];})];
    const point=target?serviceRoadPoint(world,request.player,35,80,50,blockers,2.2,.95,p=>{const f=stepVehicleFollower(world,{...p,speed:0},createFollowerState({...p,speed:0}),{kind:"pursue",target,maxSpeed:10});return f.status!=="no-route";}):null;
    if(!point)continue;
    frame.spawns.push({id,model:"robotaxi",firmware:"bad",...point,y:groundHeight(world,point.x,point.z),radius:1.1,height:1.5,significant:true,halfLength:2.2,halfWidth:.95});
    units[id]={id,kind:"taxi",requestId:request.id,playerId:request.playerId,bornTick:sim.tick,lastSeenTick:request.requestTick,lastKnown:{...request.player},follower:createFollowerState({...point,speed:0}),...(target?{roadTarget:target,roadSample:{...request.player}}:{})};
   }
  }else {
   const missionId=`response-${request.id}`;if(!isGameplayId(missionId))continue;
   const aliases=Array.from({length:count},(_,i)=>`unit${i}`),definitions:Record<string,{kind:"badRobot";level:number}>={};for(const id of aliases)definitions[id]={kind:"badRobot",level:2};
   const placed=planMissionActors(world,sim,{missionId,stepId:"dispatch",actorIds:aliases,definitions,place:{...request.player,y:0},radius:34},options.graph,(x,z)=>distance({x,z},request.player)>=18,[...reserved,...frame.spawns,...Object.keys(sim.players).sort().map(id=>({...sim.players[id]!.car,radius:2.5}))]);
   for(const actor of placed.actors){
    const model=request.kind==="drone"?"drone":request.kind==="patrol"?"patrol":"footman";
    frame.spawns.push({...actor,model,height:model==="drone"?.6:1.8,y:actor.y+(model==="drone"?6:0),heading:datan2(request.player.x-actor.x,-(request.player.z-actor.z)),dispatch:{playerId:request.playerId,...request.player,tick:request.requestTick},combatGoals:{...goals,...(model==="drone"?{adBlast:8}:model==="patrol"?{handshake:8,shove:2}:{shove:8})}});
    units[actor.id]={id:actor.id,kind:request.kind,requestId:request.id,playerId:request.playerId,bornTick:sim.tick,lastSeenTick:request.requestTick,lastKnown:{...request.player},follower:null};
   }
  }
 }
 for(const id of Object.keys(units).sort()){
  const unit=units[id]!,actor=runtime?.actors[id],player=sim.players[unit.playerId];
  if(!actor||actor.retired)continue;
  const body=player&&(player.mode==="foot"&&player.foot?player.foot:player.car);
  if(body){
   const dx=body.x-actor.x,dz=body.z-actor.z,d=distance(actor,body),visible=d<=40&&(d<.01||(dx*dsin(actor.heading)-dz*dcos(actor.heading))/d>=.6427876096865394)&&!segmentBlocked(world,actor.x,actor.z,body.x,body.z)&&!(sim.ext.combat&&microclimateBlocksSight(sim.ext.combat,actor,body));
   if(visible){unit.lastSeenTick=sim.tick;unit.lastKnown={x:body.x,z:body.z};}
  }
  const knows=sim.tick-unit.lastSeenTick<=600;
  if(unit.kind==="taxi"){
   if(!unit.roadTarget||!unit.roadSample||distance(unit.roadSample,unit.lastKnown)>4){unit.roadTarget=serviceRoadPoint(world,unit.lastKnown,0,15,0,[])??{...unit.lastKnown};unit.roadSample={...unit.lastKnown};}
   const target=unit.roadTarget;
   const followed=stepVehicleFollower(world,actor,unit.follower??createFollowerState(actor),{kind:"park-across-lane",target,stopDistance:3,maxSpeed:(knows?10:2)*(sim.ext.combat?.targets[id]?.movementScale??1)});unit.follower=followed.state;controls[id]=knows?followed.input:{throttle:0,steer:0,brake:1,actions:0};
  }else if(knows)frame.goals[id]={...unit.lastKnown,speed:unit.kind==="drone"?3:1.8,stopDistance:unit.kind==="drone"?5:1.1};
  if((!player||sim.tick-unit.bornTick>7200)&&!Object.keys(sim.players).some(pid=>{const p=sim.players[pid]!,b=p.mode==="foot"&&p.foot?p.foot:p.car;return distance(actor,b)<300;}))frame.retirements.push(id);
 }
 return frame;
}
