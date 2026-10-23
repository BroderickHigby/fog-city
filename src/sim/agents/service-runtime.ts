import {boxBlocked} from "../collide.ts";
import type { SimInput, SimState } from "../contract.ts";
import type { ThreatSpawnRequest } from "../gameplay-contract.ts";
import { isGameplayId } from "../gameplay-contract.ts";
import { MOAT_SITES } from "../../content/places.ts";
import { toLocal } from "../../geo/project.ts";
import { datan2, dcos, dsin } from "../dmath.ts";
import { circleBlocked, groundHeight, segmentBlocked, type World } from "../world.ts";
import { lanePath, pathPoint, projectOnPath } from "../roads.ts";
import { createFollowerState, stepVehicleFollower, type FollowerState } from "../vehicles/follower.ts";
import { agentsRuntimeOf, type RuntimeActor } from "./runtime.ts";
import { planMissionActors, type ActorBlueprint } from "./mission-actors.ts";

export interface ServiceVehicle {
  id:string;
  model:"van"|"bus";
  requestId:string;
  requestTick:number;
  playerId:string;
  phase:"driving"|"returning"|"retired";
  origin:{x:number;y:number;z:number;heading:number};
  destination:{x:number;z:number};
  depot:{x:number;z:number};
  follower:FollowerState;
  deliveredTick:number|null;
  retiredTick:number|null;
}
export interface ServiceRuntimeState {
  version:1;
  tick:number;
  receiptFloor:number;
  receipts:{id:string;tick:number}[];
  vehicles:Record<string,ServiceVehicle>;
  events:ServiceEvent[];
}
export interface ServiceEvent {id:string;tick:number;kind:"service.dispatched"|"service.delivered"|"service.blocked"|"service.retired";actorId:string;requestId:string;amount:number;detail:string}
export interface ServiceRuntimeFrame {state:ServiceRuntimeState;spawns:ActorBlueprint[];controls:Record<string,SimInput>;retirements:string[];events:ServiceEvent[]}
const distance=(a:{x:number;z:number},b:{x:number;z:number})=>Math.sqrt((a.x-b.x)*(a.x-b.x)+(a.z-b.z)*(a.z-b.z));
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
export function createServiceRuntime(tick=0):ServiceRuntimeState{return {version:1,tick,receiptFloor:0,receipts:[],vehicles:{},events:[]};}

/** Accept durable shared events only; replayed or stale identities cannot redispatch a van. */
export function threatRequestsOf(sim:Readonly<SimState>):ThreatSpawnRequest[]{
  const events=(sim.ext.heat as unknown as {events?:unknown}|undefined)?.events;
  if(!Array.isArray(events))return [];
  const result:ThreatSpawnRequest[]=[];
  for(const raw of events){
    if(!raw||typeof raw!=="object")continue;
    const event=raw as {kind?:unknown;payload?:unknown};if(event.kind!=="threat.spawn"||!event.payload||typeof event.payload!=="object")continue;
    const request=event.payload as ThreatSpawnRequest;
    if(!isGameplayId(request.id)||!isGameplayId(request.playerId)||!sim.players[request.playerId]||!Number.isSafeInteger(request.requestTick)||request.requestTick<0||request.requestTick>sim.tick||!request.player||![request.player.x,request.player.z].every(Number.isFinite)||!Number.isSafeInteger(request.unitCount)||request.unitCount<1||request.unitCount>32)continue;
    if(request.kind==="van"&&request.threat===2&&request.unitCount===2||["drone","patrol","swarm","taxi"].includes(request.kind)&&[3,4,5].includes(request.threat))result.push(request);
  }
  return result.sort((a,b)=>a.requestTick-b.requestTick||compare(a.id,b.id));
}

interface RoadPoint {x:number;z:number;heading:number}
export function serviceRoadPoint(world:World,target:{x:number;z:number},minimum:number,maximum:number,preferred:number,actors:readonly {x:number;z:number;radius?:number}[],halfLength=2.7,halfWidth=1.1,accept?:(point:RoadPoint)=>boolean):RoadPoint|null{
  let best:RoadPoint|null=null,score=Infinity,key="";
  for(const edge of world.roads?.edges??[]){
    if(!edge.drivable)continue;
    for(const dir of [1,-1] as const){
      const di=dir===1?0:1;if(!edge.laneSafe[di][0])continue;
      const path=lanePath(edge,dir,0),positions:number[]=[];
      if(minimum===0)positions.push(projectOnPath(path,target.x,target.z).s);
      else for(let at=0;at<=path.len;at+=10)positions.push(at);
      for(const at of positions){
        const p=pathPoint(path,at),d=distance(p,target);if(d<minimum||d>maximum||circleBlocked(world,p.x,p.z,1.4)||actors.some(actor=>distance(actor,p)<halfLength+(actor.radius??.4)+.5))continue;
        const heading=datan2(p.tx,-p.tz),fx=dsin(heading),fz=-dcos(heading),rx=dcos(heading),rz=dsin(heading);
        if(boxBlocked(world,{x:p.x,z:p.z,heading,hl:halfLength,hw:halfWidth},groundHeight(world,p.x,p.z)+.5))continue;
        const corners=[[-1,-1],[-1,1],[1,1],[1,-1]].map(([f,r])=>({x:p.x+f!*halfLength*fx+r!*halfWidth*rx,z:p.z+f!*halfLength*fz+r!*halfWidth*rz}));
        if(corners.some(c=>circleBlocked(world,c.x,c.z,.15))||corners.some((c,i)=>segmentBlocked(world,c.x,c.z,corners[(i+1)%4]!.x,corners[(i+1)%4]!.z)))continue;
        const candidateScore=Math.abs(d-preferred),candidateKey=`${edge.id}:${dir}:${at}`;
        if(candidateScore<score||candidateScore===score&&compare(candidateKey,key)<0){const point={x:p.x,z:p.z,heading};if(accept&&!accept(point))continue;score=candidateScore;key=candidateKey;best=point;}
      }
    }
  }
  return best;
}
function depotFor(point:{x:number;z:number}):{x:number;z:number}{
  let best=point,score=Infinity;
  for(const site of MOAT_SITES){if(site.kind==="conventionCenter")continue;const p=toLocal(site.lat,site.lon),d=distance(point,p);if(d<score){best=p;score=d;}}
  return {...best};
}

/** Vehicle follower controls are applied once by core; arrivals use its observed body poses. */
export function planServiceRuntime(world:World,sim:Readonly<SimState>,previous:ServiceRuntimeState|undefined):ServiceRuntimeFrame{
  const old=previous??createServiceRuntime(sim.tick);
  const state:ServiceRuntimeState={...old,tick:sim.tick,receiptFloor:Math.max(old.receiptFloor,sim.tick-7200),events:[],receipts:old.receipts.filter(r=>r.tick>=Math.max(old.receiptFloor,sim.tick-7200)).map(r=>({...r})),vehicles:{}};
  for(const id of Object.keys(old.vehicles).sort()){const vehicle=old.vehicles[id]!;if(vehicle.retiredTick===null||sim.tick-vehicle.retiredTick<7200)state.vehicles[id]={...vehicle};}
  const frame:ServiceRuntimeFrame={state,spawns:[],controls:{},retirements:[],events:[]};
  const runtime=agentsRuntimeOf(sim),actors=runtime?Object.keys(runtime.actors).sort().map(id=>runtime.actors[id]!).filter(actor=>!actor.retired):[];
  const blockers:Array<{x:number;z:number;radius?:number}>=[...actors,...Object.keys(sim.players).sort().map(id=>({...sim.players[id]!.car,radius:3}))];
  const emit=(kind:ServiceEvent["kind"],vehicle:Pick<ServiceVehicle,"id"|"requestId">,amount=0,detail="")=>frame.events.push({id:`${sim.tick}:${frame.events.length}`,tick:sim.tick,kind,actorId:vehicle.id,requestId:vehicle.requestId,amount,detail});
  for(const request of threatRequestsOf(sim)){
    if(request.kind!=="van"||request.requestTick<state.receiptFloor||state.receipts.some(r=>r.id===request.id))continue;
    if(state.receipts.length>=128)continue;
    const id=`service:${request.id}`;
    state.receipts.push({id:request.id,tick:request.requestTick});
    if(Object.keys(state.vehicles).filter(key=>state.vehicles[key]!.phase!=="retired").length>=16){emit("service.blocked",{id,requestId:request.id},0,"capacity");continue;}
    const target=serviceRoadPoint(world,request.player,0,12,0,[]);
    const origin=target?serviceRoadPoint(world,request.player,100,140,120,blockers,2.7,1.1,point=>{
      const follow=stepVehicleFollower(world,{...point,speed:0},createFollowerState({...point,speed:0}),{kind:"pursue",target,stopDistance:1,maxSpeed:13});
      let length=0;for(let i=1;i<follow.state.route.length;i++){const a=follow.state.route[i-1]!,b=follow.state.route[i]!;length+=distance({x:a[0],z:a[1]},{x:b[0],z:b[1]});}
      return follow.status!=="no-route"&&length<=180;
    }):null;
    if(!origin||!target){emit("service.blocked",{id,requestId:request.id},0,"no-valid-road-entry");continue;}
    const test=stepVehicleFollower(world,{...origin,speed:0},createFollowerState({...origin,speed:0}),{kind:"pursue",target,stopDistance:1,maxSpeed:13});
    if(test.status==="no-route"){emit("service.blocked",{id,requestId:request.id},0,"no-directed-route");continue;}
    state.vehicles[id]={id,model:"van",requestId:request.id,requestTick:request.requestTick,playerId:request.playerId,phase:"driving",origin:{...origin,y:groundHeight(world,origin.x,origin.z)},destination:target,depot:depotFor(origin),follower:createFollowerState({...origin,speed:0}),deliveredTick:null,retiredTick:null};
    blockers.push({...origin,radius:3});
    emit("service.dispatched",state.vehicles[id]!,2);
  }
  for(const id of Object.keys(state.vehicles).sort()){
    const vehicle=state.vehicles[id]!;if(vehicle.phase==="retired")continue;
    const body=runtime?.actors[id];
    if(!body){frame.spawns.push({id,model:"van",firmware:"good",...vehicle.origin,radius:1.2,height:2.4,halfLength:2.7,halfWidth:1.1,protected:true,significant:true});continue;}
    const target=vehicle.phase==="driving"?vehicle.destination:vehicle.depot;
    const follow=stepVehicleFollower(world,body,vehicle.follower,{kind:"pursue",target,stopDistance:1,maxSpeed:13});vehicle.follower=follow.state;frame.controls[id]=follow.input;
    if(vehicle.phase==="driving"&&follow.distanceToGoal<=2&&follow.stopped){
      const plan=planMissionActors(world,sim,{missionId:`reinforce-${vehicle.requestId}`,stepId:"arrival",actorIds:["unit0","unit1"],definitions:{unit0:{kind:"badRobot"},unit1:{kind:"badRobot"}},place:{x:body.x,y:body.y,z:body.z},radius:12});
      if(plan.actors.length!==2){frame.controls[id]={throttle:0,steer:0,brake:1,actions:0};continue;}
      frame.spawns.push(...plan.actors);vehicle.deliveredTick=sim.tick;vehicle.phase="returning";
      emit("service.delivered",vehicle,2,sim.tick-vehicle.requestTick<=1200?"on-time":"late");
    }else if(vehicle.phase==="returning"){
      const offscreen=Object.keys(sim.players).sort().every(playerId=>{const player=sim.players[playerId]!,p=player.mode==="foot"&&player.foot?player.foot:player.car;return distance(body,p)>300;});
      if(offscreen||follow.status==="arrived"){vehicle.phase="retired";vehicle.retiredTick=sim.tick;frame.retirements.push(id);emit("service.retired",vehicle);}
    }
  }
  state.events=frame.events;
  return frame;
}
