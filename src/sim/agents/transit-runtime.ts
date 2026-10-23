import type {SimInput,SimState} from "../contract.ts";
import {groundHeight,type World} from "../world.ts";
import {makePath,projectOnPath} from "../roads.ts";
import {createFollowerState,stepVehicleFollower,type FollowerState} from "../vehicles/follower.ts";
import {agentsRuntimeOf} from "./runtime.ts";
import type {ActorBlueprint} from "./mission-actors.ts";
import {serviceBlockersOf,serviceEntryClear,serviceRoadPoint,type ServiceBlocker} from "./service-runtime.ts";
import type {AdWrapSlot} from "./services.ts";

export interface TransitLayer {
  version:number;
  routes:readonly {id:string;line:string;mode:"bus"|"rail"|"streetcar"|"cable";direction:string;night:boolean;paths:readonly (readonly (readonly [number,number])[])[]}[];
  stops:readonly {id:string;x:number;y:number;z:number;routes:readonly string[]}[];
}
interface BusStop {id:string;x:number;z:number}
export interface BusRun {
  id:string;routeId:string;scheduledMinute:number;
  origin:{x:number;y:number;z:number;heading:number};
  stops:BusStop[];nextStop:number;dwellUntil:number;
  follower:FollowerState;ferryTick:number|null;retiredTick:number|null;adWrapSlot:AdWrapSlot;
}
export interface TransitEvent {id:string;tick:number;kind:"transit.departed"|"transit.stop"|"transit.ferry-pass"|"transit.retired";actorId:string;stopId:string;scheduledMinute:number}
export interface TransitRuntimeState {version:1;nextDepartureMinute:number;runs:Record<string,BusRun>;events:TransitEvent[];missedDepartures:number}
export interface TransitFrame {state:TransitRuntimeState;spawns:ActorBlueprint[];controls:Record<string,SimInput>;retirements:string[]}
const magnitude=(x:number,z:number)=>Math.sqrt(x*x+z*z);
const compare=(a:string,b:string)=>a<b?-1:a>b?1:0;
const ferryIds=["s4513","s7283"];
const playerBodies=(state:Readonly<SimState>)=>Object.keys(state.players).sort().map(id=>{const p=state.players[id]!;return p.mode==="foot"&&p.foot?p.foot:p.car;});

/** Source routes and stop identities remain untouched; goals project onto drivable lanes. */
function buildFerryPlan(world:World,data:TransitLayer):{routeId:string;ferry:BusStop;stops:BusStop[]}|null{
  if(data.version!==1)return null;
  for(const route of [...data.routes].sort((a,b)=>compare(a.id,b.id))){
    if(route.mode!=="bus")continue;
    const ferry=data.stops.find(stop=>ferryIds.includes(stop.id)&&stop.routes.includes(route.id));if(!ferry)continue;
    const pathSource=route.paths.find(path=>path.length>=2);if(!pathSource)continue;
    const path=makePath(pathSource.map(p=>p[0]),pathSource.map(p=>p[1]));
    const projected=data.stops.filter(stop=>stop.routes.includes(route.id)).map(stop=>({stop,along:projectOnPath(path,stop.x,stop.z).s})).sort((a,b)=>a.along-b.along||compare(a.stop.id,b.stop.id));
    const at=projected.findIndex(item=>item.stop.id===ferry.id);if(at<0)continue;
    const ordered=[...projected.slice(at),...projected.slice(0,at)],stops:BusStop[]=[];
    for(const item of ordered){if(magnitude(item.stop.x-ferry.x,item.stop.z-ferry.z)>1200)continue;const point=serviceRoadPoint(world,item.stop,0,15,0,[]);if(point&&!stops.some(stop=>magnitude(stop.x-point.x,stop.z-point.z)<3))stops.push({id:item.stop.id,x:point.x,z:point.z});}
    if(stops.length>=2&&stops[0]!.id===ferry.id)return {routeId:route.id,ferry:stops[0]!,stops};
  }
  return null;
}

const plans=new WeakMap<World,WeakMap<TransitLayer,ReturnType<typeof buildFerryPlan>>>();
function ferryPlan(world:World,data:TransitLayer):ReturnType<typeof buildFerryPlan>{
  let byData=plans.get(world);if(!byData){byData=new WeakMap();plans.set(world,byData);}
  if(!byData.has(data))byData.set(data,buildFerryPlan(world,data));
  return byData.get(data)??null;
}

export function planTransitRuntime(world:World,sim:Readonly<SimState>,data:TransitLayer|undefined,previous:TransitRuntimeState|undefined,pending:readonly ServiceBlocker[]=[]):TransitFrame{
  const minute=(sim.ext.clock as {elapsedTicks?:number}|undefined)?.elapsedTicks??sim.tick;
  const now=minute/60;
  const old=previous??{version:1 as const,nextDepartureMinute:Math.ceil(now/10)*10,runs:{},events:[],missedDepartures:0};
  const state:TransitRuntimeState={...old,runs:{},events:[]};
  for(const id of Object.keys(old.runs).sort()){const run=old.runs[id]!;if(run.retiredTick===null||sim.tick-run.retiredTick<7200)state.runs[id]={...run};}
  const frame:TransitFrame={state,spawns:[],controls:{},retirements:[]};
  if(!data)return frame;
  const actors=agentsRuntimeOf(sim),players=playerBodies(sim);
  const blockers=serviceBlockersOf(sim,pending);
  const plan=state.nextDepartureMinute<=now?ferryPlan(world,data):null;
  const emit=(kind:TransitEvent["kind"],run:BusRun,stopId="")=>state.events.push({id:`${sim.tick}:${state.events.length}`,tick:sim.tick,kind,actorId:run.id,stopId,scheduledMinute:run.scheduledMinute});
  if(state.nextDepartureMinute<=now){
    const active=Object.keys(state.runs).filter(id=>state.runs[id]!.retiredTick===null).length;
    const scheduled=state.nextDepartureMinute;
    state.missedDepartures+=Math.max(0,Math.floor((now-scheduled)/10));state.nextDepartureMinute=(Math.floor(now/10)+1)*10;
    if(plan&&active<16&&players.some(player=>magnitude(player.x-plan.ferry.x,player.z-plan.ferry.z)<=300)){
      const entry=serviceRoadPoint(world,plan.ferry,100,140,120,blockers,6.6,1.35,point=>{
        const follow=stepVehicleFollower(world,{...point,speed:0},createFollowerState({...point,speed:0}),{kind:"pursue",target:plan.ferry,stopDistance:1.5,maxSpeed:10});
        let length=0;for(let i=1;i<follow.state.route.length;i++){const a=follow.state.route[i-1]!,b=follow.state.route[i]!;length+=magnitude(a[0]-b[0],a[1]-b[1]);}
        return follow.status!=="no-route"&&length<=240;
      },3.2);
      if(entry){const id=`transit:${plan.routeId}:${scheduled}`,run:BusRun={id,routeId:plan.routeId,scheduledMinute:scheduled,origin:{x:entry.x,y:entry.y??groundHeight(world,entry.x,entry.z),z:entry.z,heading:entry.heading},stops:plan.stops,nextStop:0,dwellUntil:0,follower:createFollowerState({...entry,speed:0}),ferryTick:null,retiredTick:null,adWrapSlot:{slotId:`${id}:wrap`,surface:"left-right-rear",contentKey:null}};state.runs[id]=run;emit("transit.departed",run);}else state.missedDepartures++;
    }
  }
  for(const id of Object.keys(state.runs).sort()){
    const run=state.runs[id]!;if(run.retiredTick!==null)continue;
    const body=actors?.actors[id];
    if(!body){
      if(serviceEntryClear(world,run.origin,blockers,6.6,1.35,3.2)){
        const spawn:ActorBlueprint={id,model:"bus",firmware:"good",...run.origin,radius:1.4,height:3.2,halfLength:6.6,halfWidth:1.35,protected:true,significant:true,adWrapSlot:run.adWrapSlot};
        frame.spawns.push(spawn);blockers.push(spawn);
      }
      continue;
    }
    if(run.ferryTick!==null&&players.every(player=>magnitude(player.x-body.x,player.z-body.z)>300)){run.retiredTick=sim.tick;frame.retirements.push(id);emit("transit.retired",run);continue;}
    if(sim.tick<run.dwellUntil){frame.controls[id]={throttle:0,steer:0,brake:1,actions:0};continue;}
    const stop=run.stops[run.nextStop%run.stops.length]!;
    const follow=stepVehicleFollower(world,body,run.follower,{kind:"pursue",target:stop,stopDistance:1.5,maxSpeed:10});run.follower=follow.state;frame.controls[id]=follow.input;
    if(follow.distanceToGoal<=2&&follow.stopped){
      emit("transit.stop",run,stop.id);
      if(ferryIds.includes(stop.id)){run.ferryTick=sim.tick;emit("transit.ferry-pass",run,stop.id);}
      run.nextStop++;run.dwellUntil=sim.tick+60;
    }
  }
  return frame;
}
