/** Draft destination: src/modes/taxi-session.ts. No DOM or clock; caller owns controls/rendering. */
import type { SimState, Spawn } from "../sim/contract.ts";
import { SIM_VERSION, sortedIds } from "../sim/contract.ts";
import { createInitialState } from "../sim/step.ts";
import { groundWater, type World } from "../sim/world.ts";
import { CAR } from "../sim/car.ts";
import { agentCircles, AGENT_SPEC, ROBOTAXI_BODY } from "../sim/agents.ts";
import { agentDodgeClass, boxDistance } from "../sim/dodge.ts";
import { dcos, dsin } from "../sim/dmath.ts";
import { agentsRuntimeOf } from "../sim/agents/runtime.ts";
import { canonicalJson, hashState } from "../sim/serialize.ts";
import { applyMatchSettlement } from "../sim/modes/settlement.ts";
import { createTaxiState, stepTaxi, taxiSettlement, taxiView } from "../sim/modes/taxi.ts";
import type { TaxiCommand, TaxiConfig, TaxiContext, TaxiPoint, TaxiStart, TaxiState, TaxiVehiclePose } from "../sim/modes/taxi.ts";

export interface TaxiSession {
  version:1;
  kind:"taxi-session";
  /** Complete city checkpoint. Never advanced while this instance owns the screen. */
  campaign:SimState;
  /** Separate simulation with no campaign wallet, missions or progression copied in. */
  instance:SimState;
  config:TaxiConfig;
  taxi:TaxiState;
  /** Prepared exit result; repeated exit/reload offers the same settlement once. */
  restored:SimState|null;
}
export interface TaxiSessionInput {
  interact:boolean;
  commands?:readonly TaxiCommand[];
  /** Deterministic road/path producer result, never a client supplied completion claim. */
  route:TaxiContext["route"];
}
function clone<T>(value:T):T {return JSON.parse(canonicalJson(value)) as T;}
/** Only a fresh local simulation is created; no campaign field is used as an in-mode balance. */
export function createTaxiSession(world:World,campaign:Readonly<SimState>,config:TaxiConfig,start:TaxiStart,spawn:Spawn):TaxiSession {
  if(!campaign.players[start.playerId])throw new Error("Taxi player must belong to the saved campaign");
  if(start.tick!==undefined&&start.tick!==0)throw new Error("A taxi instance starts at tick zero");
  const taxi=createTaxiState(config,{...start,tick:0});
  return {version:1,kind:"taxi-session",campaign:clone(campaign),instance:createInitialState(world,start.seed,[start.playerId],spawn),config:clone(config),taxi,restored:null};
}
/** Read the actual accepted manually driven vehicle; autonomous rides cannot qualify. */
export function acceptedTaxiVehicle(world:World,state:Readonly<SimState>,playerId:string):TaxiVehiclePose|null {
  const player=state.players[playerId];if(!player||player.mode!=="vehicle")return null;
  const ride=player.ride;
  const agent=ride?(state.ext.agents?.list??[]).find(value=>value.id===ride.agentId):undefined;
  if(ride&&(!ride.manual||!agent?.manualCar))return null;
  const car=ride?agent!.manualCar!:player.car;
  const halfLength=ride?(agent!.halfLength??ROBOTAXI_BODY.halfLength):CAR.halfLength;
  const halfWidth=ride?(agent!.halfWidth??ROBOTAXI_BODY.halfWidth):CAR.halfWidth;
  const fx=dsin(car.heading),fz=-dcos(car.heading);let clearance=100_000;
  for(const body of [...state.ext.agents?.list??[]].sort((a,b)=>a.id-b.id)){
    const kind=agentDodgeClass(body);
    if(kind===null||kind==="errandRobot"||kind==="sidewalkBot")continue;
    // Protected bodies on a distinct floor do not occupy this car's vertical hull band.
    if(body.y>=car.y+2||body.y+(body.height??1.7)<=car.y)continue;
    for(const circle of agentCircles(body))clearance=Math.min(clearance,boxDistance(circle.x,circle.z,car.x,car.z,fx,fz,halfLength,halfWidth)-circle.r);
  }
  for(const id of sortedIds(state.players)){
    if(id===playerId)continue;const other=state.players[id]!,foot=other.foot;
    if(other.mode!=="foot"||!foot||foot.y>=car.y+2||foot.y+1.7<=car.y)continue;
    clearance=Math.min(clearance,boxDistance(foot.x,foot.z,car.x,car.z,fx,fz,halfLength,halfWidth)-.35);
  }
  return {playerId,vehicleId:ride?`agent-${ride.agentId}`:`${playerId}-car`,kind:"vehicle",manual:true,x:car.x,y:car.y,z:car.z,heading:car.heading,speedMps:car.speed,lateralMps:car.lateral,grounded:car.grounded,onWater:groundWater(world,car.x,car.z),personClearanceM:clearance};
}
export const TAXI_PASSENGER_CURB_REACH_M=8;
export const TAXI_PASSENGER_ANCHOR_REACH_M=3;
/** Only an admitted, protected, posted human bound to this fare and its safe sidewalk anchor counts. */
export function acceptedTaxiPassenger(state:Readonly<SimState>,taxi:Readonly<TaxiState>,config:TaxiConfig,anchor:TaxiPoint|null=null):string|null {
  const actor=agentsRuntimeOf(state)?.actors[taxi.trip.passengerId];
  if(!actor||actor.retired||actor.model!=="person"||actor.protected!==true||actor.posted!==true)return null;
  const body=(state.ext.agents?.list??[]).find(value=>value.id===actor.numericId&&value.runtimeId===actor.id&&value.kind==="person"&&value.protected===true);
  if(!body)return null;const stop=config.routes.find(value=>value.id===taxi.trip.routeId)!.pickup;
  const dx=body.x-stop.x,dz=body.z-stop.z;
  if(dx*dx+dz*dz>TAXI_PASSENGER_CURB_REACH_M*TAXI_PASSENGER_CURB_REACH_M||Math.abs(body.y-stop.y)>2)return null;
  if(anchor){const ax=body.x-anchor.x,az=body.z-anchor.z;if(ax*ax+az*az>TAXI_PASSENGER_ANCHOR_REACH_M*TAXI_PASSENGER_ANCHOR_REACH_M||Math.abs(body.y-anchor.y)>2)return null;}
  return actor.id;
}
/** Call once after the ordinary physics/game-system step, with its accepted resulting state. */
export function advanceTaxiSession(previous:TaxiSession,world:World,accepted:SimState,input:TaxiSessionInput):TaxiSession {
  if(previous.restored||previous.taxi.phase==="exited")return previous;
  if(accepted.tick!==previous.instance.tick+1)throw new Error("Taxi physics ticks must be contiguous");
  const catalog=(previous as Partial<SfTaxiSession>).catalog,path=catalog?.roads.find(value=>value.id===previous.taxi.trip.routeId),anchor=path?catalog!.curbs.find(value=>value.id===path.pickup)?.passenger??null:null;
  const taxi=stepTaxi(previous.taxi,previous.config,{tick:accepted.tick,vehicle:acceptedTaxiVehicle(world,accepted,previous.taxi.playerId),waitingPassengerId:acceptedTaxiPassenger(accepted,previous.taxi,previous.config,anchor),route:input.route,interact:input.interact,...(input.commands?{commands:input.commands}:{})});
  return {...previous,instance:accepted,taxi};
}
/**
 * Restore every city field from the entry checkpoint, then apply only the authorized aggregate.
 * The city owner installs this result and saves it atomically. Do not also settle every fare.
 */
export function settleTaxiSession<T extends TaxiSession>(previous:T):T {
  if(previous.restored)return previous;const payout=taxiSettlement(previous.taxi);
  if(!payout)throw new Error("Exit the taxi run before restoring its campaign");
  const restored=applyMatchSettlement(clone(previous.campaign),payout,previous.taxi.playerId);
  return {...previous,restored};
}
export function taxiSessionView(session:TaxiSession):ReturnType<typeof taxiView> {return taxiView(session.taxi,session.config);}
/** Complete checkpoint, including the untouched city, mode clocks and once-only fare ledger. */
export function encodeTaxiSession(session:TaxiSession):string {return canonicalJson({schema:1,checksum:hashState(session),session});}

// Entry/physical adapter used by the ordinary createGameSystems + step composition.
import { allocateActorIds } from "../sim/identity.ts";
import { createGameSystems } from "../sim/game-systems.ts";
import { step } from "../sim/step.ts";
import { Action, type InputFrame, type SimEvent } from "../sim/contract.ts";
import { serviceBlockersOf, serviceEntryClear } from "../sim/agents/service-runtime.ts";
import { circleBlocked, groundHeight } from "../sim/world.ts";
import { circleHitsWall } from "../sim/boundary.ts";
import { protectedAreaAt } from "../content/places.ts";
import { toLatLon } from "../geo/project.ts";
import { DAY_TICKS } from "../sim/clock/calendar.ts";
import { rainDensity } from "../sim/fog/index.ts";
import type { AgentRuntimeOptions, RuntimeSpawn } from "../sim/agents/runtime.ts";
import { createSfTaxiCatalog, taxiRouteStatus, taxiStartSpawn } from "./taxi-routes.ts";
import type { TaxiStreetCatalog } from "./taxi-routes.ts";
import type { SimSystem } from "../sim/system-contract.ts";
import type { CombatWave } from "../sim/combat-contract.ts";

export interface SfTaxiSession extends TaxiSession {catalog:TaxiStreetCatalog;wave:CombatWave}
/** Shift environment uses the existing saved calendar and seeded fog/rain systems. */
function shiftEnvironment(state:SimState,taxi:TaxiState,config:TaxiConfig):SimState {
  const theme=config.shifts.find(value=>value.id===taxi.shiftId)!.theme;
  const candidate=(elapsedTicks:number):SimState=>({...state,ext:{...state.ext,clock:{version:1,elapsedTicks},fog:{version:1,missionCursor:0,windows:theme==="fog-rain"?[{id:`${taxi.id}-fog`,startTick:state.tick,untilTick:state.tick+(config.rules?.shiftDurationTicks??18_000),density:.65}]:[]}}});
  // The calendar advances one game second per fixed tick. These offsets preserve normal clocks.
  if(theme!=="fog-rain"){for(let day=0;day<112;day++){const value=candidate(day*DAY_TICKS+(theme==="night"?14:4)*3600);if(rainDensity(value)===0)return value;}throw new Error("No clear taxi shift in the bounded calendar window");}
  for(let day=0;day<112;day++)for(let hour=0;hour<24;hour++){
    const value=candidate(day*DAY_TICKS+hour*3600);if(rainDensity(value)>.5)return value;
  }
  throw new Error("This seed has no available rainy shift in the bounded calendar window");
}
export function createSfTaxiSession(world:World,campaign:Readonly<SimState>,start:TaxiStart,options:{wave?:CombatWave;title?:string}={}):SfTaxiSession {
  const wave=Math.max(3,options.wave??3) as CombatWave,catalog=createSfTaxiCatalog(world,wave,options.title),taxi=createTaxiState(catalog.config,{...start,tick:0});
  const session=createTaxiSession(world,campaign,catalog.config,start,taxiStartSpawn(world,catalog,taxi.trip.routeId));
  return {...session,catalog,wave,instance:shiftEnvironment(session.instance,session.taxi,session.config)};
}
function passengerSpawn(world:World,session:SfTaxiSession,state:Readonly<SimState>):Omit<RuntimeSpawn,"numericId">|null {
  const path=session.catalog.roads.find(value=>value.id===session.taxi.trip.routeId),curb=path&&session.catalog.curbs.find(value=>value.id===path.pickup);if(!curb)return null;
  const point=curb.passenger,ll=toLatLon(point.x,point.z);
  if(groundWater(world,point.x,point.z)||protectedAreaAt([ll.lat,ll.lon])||circleBlocked(world,point.x,point.z,.45)||circleHitsWall(world.walls,point.x,point.z,.45))return null;
  const clear=serviceBlockersOf(state).every(body=>body.halfLength!==undefined&&body.halfWidth!==undefined
    ?boxDistance(point.x,point.z,body.x,body.z,dsin(body.heading??0),-dcos(body.heading??0),body.halfLength,body.halfWidth)>=.35+.75
    :(body.x-point.x)*(body.x-point.x)+(body.z-point.z)*(body.z-point.z)>=(.35+(body.radius??.4)+.2)**2);
  if(!clear)return null;
  return {id:session.taxi.trip.passengerId,model:"person",firmware:"none",x:point.x,y:groundHeight(world,point.x,point.z),z:point.z,heading:curb.heading,radius:.35,height:1.7,protected:true,posted:true,significant:true,ownerId:session.taxi.playerId};
}
/** Prepares actor IDs/retirements before ordinary physical admission; never places an accepted body. */
export function prepareSfTaxiSession(previous:SfTaxiSession,world:World):{session:SfTaxiSession;agents:Partial<AgentRuntimeOptions>} {
  let state=previous.instance;const runtime=agentsRuntimeOf(state);
  const waiting=previous.taxi.phase==="pickup"||previous.taxi.phase==="blocked"&&previous.taxi.trip.resumePhase==="pickup";
  const wanted=waiting?previous.taxi.trip.passengerId:"";let actors=runtime?.actors;
  if(runtime)for(const id of sortedIds(runtime.actors)){
    const actor=runtime.actors[id]!;
    if(!actor.retired&&actor.ownerId===previous.taxi.playerId&&id.startsWith(`${previous.taxi.id}:a`)&&id.endsWith(":passenger")&&id!==wanted){if(actors===runtime.actors)actors={...actors};actors![id]={...actor,retired:true};}
  }
  if(runtime&&actors!==runtime.actors)state={...state,ext:{...state.ext,robots:{...runtime,actors:actors!}}};
  const old=wanted?agentsRuntimeOf(state)?.actors[wanted]:undefined;
  const spawns:RuntimeSpawn[]=[];
  if(waiting&&!old){const spawn=passengerSpawn(world,previous,state);if(spawn){const allocated=allocateActorIds(state,[spawn.id]);state=allocated.state;spawns.push({...spawn,numericId:allocated.ids[spawn.id]!});}}
  return {session:{...previous,instance:state},agents:{spawns,engagePlayers:false,services:false,director:undefined}};
}
/**
 * Complete backend tick: actor preparation → normal core/game systems → accepted taxi reducer.
 * Use one cached systems composition per session; the caller may pass one created with the
 * prepare result's agents provider when it needs extra renderer/game ownership.
 */
export function stepSfTaxiSession(previous:SfTaxiSession,world:World,inputs:InputFrame,commands:readonly TaxiCommand[]=[],events:readonly SimEvent[]=[]):SfTaxiSession {
  if(previous.taxi.phase==="exited"||previous.restored)return previous;
  const prepared=prepareSfTaxiSession(previous,world);
  return stepPreparedTaxiSession(prepared.session,world,inputs,commands,events,createGameSystems({wave:previous.wave,agents:()=>prepared.agents,modes:[]}));
}
function stepPreparedTaxiSession(session:SfTaxiSession,world:World,inputs:InputFrame,commands:readonly TaxiCommand[],events:readonly SimEvent[],systems:readonly SimSystem[]):SfTaxiSession {
  const accepted=step(world,session.instance,inputs,events,systems);
  const advanced=advanceTaxiSession(session,world,accepted,{interact:!!((inputs[session.taxi.playerId]?.actions??0)&Action.interact),commands,route:{id:session.taxi.trip.routeId,status:taxiPhysicalRouteStatus(session,world,accepted)}}) as SfTaxiSession;
  // Retry is a new isolated attempt. Restart its physical instance on its new supported lane;
  // the campaign checkpoint and earned fare ledger remain untouched and simulation tick stays contiguous.
  if(advanced.taxi.attempt!==session.taxi.attempt){
    const fresh=createInitialState(world,advanced.taxi.seed,[advanced.taxi.playerId],taxiStartSpawn(world,advanced.catalog,advanced.taxi.trip.routeId));fresh.tick=accepted.tick;
    return {...advanced,instance:shiftEnvironment(fresh,advanced.taxi,advanced.config)};
  }
  return advanced;
}
/** Browser host: create once per mounted local-mode owner to retain normal gameplay caches. */
export function createSfTaxiStepper(world:World):(session:SfTaxiSession,inputs:InputFrame,commands?:readonly TaxiCommand[],events?:readonly SimEvent[])=>SfTaxiSession {
  let agents:Partial<AgentRuntimeOptions>={},wave=-1,systems:readonly SimSystem[]=[];
  return (previous,inputs,commands=[],events=[])=>{
    if(previous.taxi.phase==="exited"||previous.restored)return previous;
    const prepared=prepareSfTaxiSession(previous,world);agents=prepared.agents;
    if(previous.wave!==wave){wave=previous.wave;systems=createGameSystems({wave:previous.wave,agents:()=>agents,modes:[]});}
    return stepPreparedTaxiSession(prepared.session,world,inputs,commands,events,systems);
  };
}
/** A stationary solid car occupying the actual stop is a recovery state, never permission to overlap. */
export function taxiPhysicalRouteStatus(session:SfTaxiSession,world:World,state:Readonly<SimState>):"open"|"blocked"|"unknown" {
  const status=taxiRouteStatus(world,session.catalog,session.taxi.trip.routeId);if(status!=="open")return status;
  const route=session.catalog.roads.find(value=>value.id===session.taxi.trip.routeId)!;
  const phase=session.taxi.phase==="blocked"?session.taxi.trip.resumePhase:session.taxi.phase;
  const curb=session.catalog.curbs.find(value=>value.id===(phase==="driving"?route.destination:route.pickup))!;
  const own=state.players[session.taxi.playerId],ownAgent=own?.ride?.manual?own.ride.agentId:-1;
  const cars=(state.ext.agents?.list??[]).filter(body=>body.id!==ownAgent&&AGENT_SPEC[body.kind].road&&Math.abs(body.speed)<.1).map(body=>({...body,halfLength:body.halfLength??ROBOTAXI_BODY.halfLength,halfWidth:body.halfWidth??ROBOTAXI_BODY.halfWidth}));
  const blockers=[...cars,...sortedIds(state.players).filter(id=>id!==session.taxi.playerId&&Math.abs(state.players[id]!.car.speed)<.1).map(id=>({...state.players[id]!.car,halfLength:CAR.halfLength,halfWidth:CAR.halfWidth}))];
  return serviceEntryClear(world,{...curb.stop,heading:curb.heading},blockers,CAR.halfLength,CAR.halfWidth,1.8)?"open":"blocked";
}

const CHECKPOINT_LIMIT = 12*1024*1024;
function jsonRecord(value:unknown):value is Record<string,unknown> {return !!value&&typeof value==="object"&&!Array.isArray(value);}
function safeCheckpointJson(value:unknown):boolean {
  let count=0;
  const visit=(item:unknown,depth:number):boolean=>{
    if(++count>1_500_000||depth>80)return false;
    if(item===null||typeof item==="string"||typeof item==="boolean")return true;
    if(typeof item==="number")return Number.isFinite(item);
    if(Array.isArray(item))return item.every(child=>visit(child,depth+1));
    if(!jsonRecord(item))return false;
    return Object.keys(item).sort().every(key=>!["__proto__","constructor","prototype"].includes(key)&&visit(item[key],depth+1));
  };
  return visit(value,0);
}
function simulationCheckpoint(value:unknown,playerId:string):value is SimState {
  if(!jsonRecord(value)||value.version!==SIM_VERSION||!Number.isSafeInteger(value.tick)||(value.tick as number)<0||!Number.isSafeInteger(value.seed)||!Array.isArray(value.rng)||value.rng.length!==4||!value.rng.every(Number.isSafeInteger)||!jsonRecord(value.players)||!value.players[playerId]||!jsonRecord(value.ext))return false;
  for(const id of Object.keys(value.players).sort()){
    const player=value.players[id];if(!jsonRecord(player)||player.id!==id||!["foot","vehicle"].includes(String(player.mode))||typeof player.exitPending!=="boolean"||!jsonRecord(player.car))return false;
    const car=player.car;
    if(!["x","y","z","heading","speed","steer","lateral","yawRate","vy","grip","pitch","roll","impactSpeed","landingSpeed"].every(key=>typeof car[key]==="number"&&Number.isFinite(car[key])))return false;
    if(!["hits","airTicks","sinceContact","personBumps","nearMisses"].every(key=>Number.isSafeInteger(car[key]))||typeof car.grounded!=="boolean")return false;
    if(player.mode==="foot"&&!jsonRecord(player.foot))return false;
  }
  return true;
}
/** Local checkpoint integrity + world/catalog checks; malformed or stale data fails closed. */
export function decodeSfTaxiSession(text:string,world:World):SfTaxiSession|null {
  if(text.length>CHECKPOINT_LIMIT)return null;
  try{
    const envelope:unknown=JSON.parse(text);if(!jsonRecord(envelope)||envelope.schema!==1||typeof envelope.checksum!=="string"||!jsonRecord(envelope.session)||!safeCheckpointJson(envelope.session)||hashState(envelope.session)!==envelope.checksum)return null;
    const value=envelope.session as unknown as SfTaxiSession;
    if(value.version!==1||value.kind!=="taxi-session"||!value.catalog||value.catalog.version!==1||![1,2,3,4,5].includes(value.wave)||!value.taxi||value.taxi.kind!=="taxi"||value.taxi.version!==1)return null;
    const initial=createTaxiState(value.config,{id:value.taxi.id,playerId:value.taxi.playerId,seed:value.taxi.seed,shiftId:value.taxi.shiftId});
    if(initial.configHash!==value.taxi.configHash||initial.configHash!==createTaxiState(value.catalog.config,{id:value.taxi.id,playerId:value.taxi.playerId,seed:value.taxi.seed,shiftId:value.taxi.shiftId}).configHash)return null;
    if(!simulationCheckpoint(value.instance,value.taxi.playerId)||!simulationCheckpoint(value.campaign,value.taxi.playerId)||value.restored!==null&&!simulationCheckpoint(value.restored,value.taxi.playerId)||value.instance.tick!==value.taxi.tick)return null;
    if(!["pickup","driving","fare-complete","blocked","timeout","cancelled","finished","exited"].includes(value.taxi.phase)||!Number.isSafeInteger(value.taxi.attempt)||value.taxi.attempt<1||value.taxi.attempt>10_000||!Number.isSafeInteger(value.taxi.tripIndex)||value.taxi.tripIndex<0||value.taxi.tripIndex>=4096||value.taxi.trip?.id!==`${value.taxi.id}:a${value.taxi.attempt}:f${value.taxi.tripIndex}`||value.taxi.trip.passengerId!==`${value.taxi.trip.id}:passenger`)return null;
    if(!Array.isArray(value.taxi.paidFareIds)||new Set(value.taxi.paidFareIds).size!==value.taxi.paidFareIds.length||value.taxi.paidFareIds.length>256||value.taxi.completedFares!==value.taxi.paidFareIds.length||!Number.isSafeInteger(value.taxi.totalCashCents)||value.taxi.totalCashCents<0||!Number.isSafeInteger(value.taxi.totalXp)||value.taxi.totalXp<0)return null;
    if(![value.taxi.commandSequence,value.taxi.nextEventId,value.taxi.shiftRemainingTicks,value.taxi.trip.pickupRemainingTicks,value.taxi.trip.tripRemainingTicks,value.taxi.trip.stopTicks,value.taxi.trip.blockedTicks].every(number=>Number.isSafeInteger(number)&&number>=0)||typeof value.taxi.previousInteract!=="boolean")return null;
    if(!Array.isArray(value.catalog.roads)||!Array.isArray(value.catalog.curbs)||value.catalog.roads.length!==value.config.routes.length||value.catalog.roads.some(route=>taxiRouteStatus(world,value.catalog,route.id)!=="open")||!value.config.routes.some(route=>route.id===value.taxi.trip.routeId))return null;
    return value;
  }catch{return null;}
}
