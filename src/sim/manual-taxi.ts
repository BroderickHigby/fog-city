// A commandeered taxi keeps its ambient identity and body. Only its lane follower is replaced
// by ordinary vehicle physics. Its owner's car remains parked; on exit/leave the taxi brakes
// and stays at its physical pose, including off road (no jump back to its old lane).
import { Action, NEUTRAL_INPUT, sortedIds, type PlayerId, type SimInput, type SimState } from "./contract.ts";
import { ROBOTAXI_BODY, agentCircles, type AgentState } from "./agents.ts";
import { carCircles, makeCar, stepCar, type CarContact } from "./car.ts";
import { agentImpactBody, carImpactBody, impactsOf } from "./impacts.ts";
import { agentDodgeClass } from "./dodge.ts";
import { dcos, dsin, clamp } from "./dmath.ts";
import type { Circle } from "./collide.ts";
import { movementLimit } from "./combat/system.ts";
import { tractionAt } from "./fog/index.ts";
import { propsNear } from "./props.ts";
import { ridesByAgent } from "./ride.ts";
import type { World } from "./world.ts";

export function commandeerTaxi(a: Readonly<AgentState>): AgentState {
  const { pass: _pass, trafficRoute: _route, knock: _knock, ...rest }=a;
  return { ...rest, node:"",conn:null,next:"",wait:0,ghost:0,mode:"wait",
    manualCar:a.manualCar??{...makeCar(a.x,a.z,a.heading,a.y),speed:a.speed,pitch:a.pitch} };
}

/** Impact impulses belong to the taxi's physics memory too; a manual taxi never realigns to a lane. */
export function syncManualTaxiImpacts(state:SimState):SimState {
  const ext=state.ext.agents;
  if(!ext || !ext.list.some(a=>a.manualCar && a.knock)) return state;
  return {...state,ext:{...state.ext,agents:{...ext,list:ext.list.map(a=>{
    if(!a.manualCar || !a.knock) return a;
    const {knock,...rest}=a,fx=dsin(a.heading),fz=-dcos(a.heading);
    const manualCar={...a.manualCar,x:a.x,y:a.y,z:a.z,heading:a.heading,speed:knock.vx*fx+knock.vz*fz,lateral:knock.vx*-fz+knock.vz*fx,yawRate:knock.yaw};
    return {...rest,manualCar,speed:manualCar.speed};
  })}}};
}

/** Move every driven/parked manual taxi once, with all other bodies read from the same old tick. */
export function stepManualTaxis(world:World,before:Readonly<SimState>,state:SimState,inputs:Readonly<Record<PlayerId,SimInput>>):{state:SimState;contacts:Map<number,CarContact[]>} {
  const contacts=new Map<number,CarContact[]>(),ext=state.ext.agents;
  if(!ext?.list.some(a=>a.manualCar)) return {state,contacts};
  const riders=ridesByAgent(before),broken=impactsOf(before)?.props;
  const list=ext.list.map(a=>{
    if(!a.manualCar) return a;
    const old=before.ext.agents?.list.find(o=>o.id===a.id)??a;
    const car={...a.manualCar,x:old.x,y:old.y,z:old.z,heading:old.heading,speed:old.speed};
    const rider=riders.get(a.id),driver=rider?.manual ? rider.playerId : null;
    const raw=driver ? inputs[driver]??NEUTRAL_INPUT : NEUTRAL_INPUT;
    const stop=!driver || rider!.exitPending || (raw.actions&Action.enterExit)!==0 || (before.ext.combat?.targets[`agent:${a.id}`]?.pullOverTick??0)>state.tick;
    const limit=before.ext.combat ? movementLimit(before.ext.combat,{id:`agent:${a.id}`}) : null;
    const controls=stop ? {...NEUTRAL_INPUT,brake:1} : {...raw,throttle:raw.throttle*(limit?.scale??1)};
    const cap=limit?.maxSpeed??Infinity;
    const source=cap<Infinity ? {...car,speed:clamp(car.speed,-cap,cap),lateral:cap===0?0:car.lateral} : car;
    const obstacles:Circle[]=[];
    const near=(x:number,z:number)=>{const dx=x-car.x,dz=z-car.z;return dx*dx+dz*dz<1600;};
    for(const other of before.ext.agents?.list??[]) {
      if(other.id===a.id || !near(other.x,other.z)) continue;
      const cls=agentDodgeClass(other);
      if(cls!==null && cls!=="errandRobot" && cls!=="sidewalkBot") continue;
      const body=agentImpactBody(other,before.ext.combat);
      for(const c of agentCircles(other)) obstacles.push({...c,person:false,...(body?{body}:{})});
    }
    for(const id of sortedIds(before.players)) {
      const other=before.players[id]!.car;
      if(!near(other.x,other.z)) continue;
      const body=carImpactBody(id,other);
      for(const c of carCircles(other)) obstacles.push({...c,body});
    }
    for(const q of propsNear(world,car.x,car.z,4)) if(!broken?.[q.id]) obstacles.push({x:q.x,z:q.z,r:q.r,person:false,body:{key:`prop:${q.id}`,mass:q.mass,x:q.x,z:q.z,vx:0,vz:0,breakSpeed:q.breakSpeed}});
    const hits:CarContact[]=[];
    let manualCar=stepCar(world,source,cap===0?{...NEUTRAL_INPUT,brake:1}:controls,obstacles,tractionAt(world,before,car.x,car.z),hits,{halfLength:a.halfLength??ROBOTAXI_BODY.halfLength,halfWidth:a.halfWidth??ROBOTAXI_BODY.halfWidth,bodyHeight:a.height??ROBOTAXI_BODY.height});
    if(cap<Infinity) manualCar={...manualCar,speed:clamp(manualCar.speed,-cap,cap)};
    contacts.set(a.id,hits);
    return {...a,manualCar,x:manualCar.x,y:manualCar.y,z:manualCar.z,heading:manualCar.heading,pitch:manualCar.pitch,speed:manualCar.speed,mode:Math.abs(manualCar.speed)<.05?"wait" as const:"go" as const};
  });
  return {state:{...state,ext:{...state.ext,agents:{...ext,list}}},contacts};
}
