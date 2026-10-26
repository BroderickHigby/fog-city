/**
 * Draft destination: src/sim/modes/taxi.ts.
 * Pure local taxi rules. The owner supplies accepted simulation observations and an immutable,
 * road-validated SF route catalog. This module never reads/mutates the campaign or moves a body.
 */
export type TaxiPhase = "pickup" | "driving" | "fare-complete" | "blocked" | "timeout" | "cancelled" | "finished" | "exited";
export type TaxiShiftTheme = "daylight" | "night" | "fog-rain";
export interface TaxiPoint { readonly x:number; readonly y:number; readonly z:number }
export interface TaxiStop extends TaxiPoint { readonly radiusM:number }
export interface TaxiRoute {
  readonly id:string;
  readonly pickupLabel:string;
  readonly destinationLabel:string;
  readonly pickupDistrict:string;
  readonly destinationDistrict:string;
  readonly pickup:TaxiStop;
  readonly destination:TaxiStop;
  /** Measured legal directed-road route length; the catalog builder must validate its path. */
  readonly roadDistanceM:number;
  readonly timeLimitTicks:number;
  readonly baseFareCents:number;
  readonly timeBonusCentsPerSecond:number;
  readonly maxTimeBonusCents:number;
  readonly xp:number;
}
export interface TaxiShift {
  readonly id:string;
  readonly label:string;
  readonly theme:TaxiShiftTheme;
  /** Authored directed itinerary. Its wrap-around should also be drivable. */
  readonly routeIds:readonly string[];
}
export interface TaxiRules {
  readonly shiftDurationTicks:number;
  readonly pickupWaitTicks:number;
  readonly safeStopTicks:number;
  readonly blockedGraceTicks:number;
  readonly maxStopSpeedMps:number;
  readonly maxLateralMps:number;
  readonly minPersonClearanceM:number;
}
export interface TaxiConfig {
  readonly version:1;
  readonly id:string;
  /** Presentation only: callers may rename the provisional title without changing sim rules. */
  readonly title?:string;
  readonly routes:readonly TaxiRoute[];
  readonly shifts:readonly TaxiShift[];
  readonly rules?:Partial<TaxiRules>;
}
export const DEFAULT_TAXI_TITLE = "Crazy Uber";
export const DEFAULT_TAXI_RULES:Readonly<TaxiRules> = Object.freeze({
  shiftDurationTicks:5*60*60,
  pickupWaitTicks:90*60,
  safeStopTicks:2*60,
  blockedGraceTicks:10*60,
  maxStopSpeedMps:.3,
  maxLateralMps:.15,
  minPersonClearanceM:.75,
});
/** The ledger is bounded; an exceptionally long/retried session ends safely at this capacity. */
export const MAX_TAXI_FARES = 256;
export const MAX_TAXI_ATTEMPTS = 10_000;
export const MAX_TAXI_TRIPS_PER_ATTEMPT = 4_096;
export interface TaxiVehiclePose extends TaxiPoint {
  readonly playerId:string;
  readonly vehicleId:string;
  readonly kind:"vehicle" | "foot";
  readonly manual:boolean;
  readonly heading:number;
  readonly speedMps:number;
  readonly lateralMps:number;
  readonly grounded:boolean;
  readonly onWater:boolean;
  /** Clearance of the accepted vehicle hull, from the simulation's person/animal query. */
  readonly personClearanceM:number;
}
export type TaxiCommandKind = "next" | "retry" | "cancel" | "exit";
export interface TaxiCommand { readonly sequence:number; readonly kind:TaxiCommandKind }
export interface TaxiContext {
  /** One contiguous simulation tick. Repeated/old ticks are idempotent; gaps are rejected. */
  readonly tick:number;
  readonly vehicle:TaxiVehiclePose | null;
  /** Result of the deterministic world/path producer for the *current* route. Unknown fails closed. */
  readonly route:{readonly id:string;readonly status:"open" | "blocked" | "unknown"};
  /** Exact live, protected passenger binding from the mode actor producer, never an input claim. */
  readonly waitingPassengerId:string | null;
  readonly interact:boolean;
  /** ID-only recorded commands; no coordinates, completion flags, fare or clock values. */
  readonly commands?:readonly TaxiCommand[];
}
interface TaxiStopProgress extends TaxiPoint { heading:number;vehicleId:string }
export interface TaxiTrip {
  id:string;
  routeId:string;
  passengerId:string;
  /** Empty while waiting; pickup locks this to the actual car that boarded the passenger. */
  vehicleId:string;
  pickupRemainingTicks:number;
  tripRemainingTicks:number;
  stopTicks:number;
  stoppedPose:TaxiStopProgress | null;
  blockedTicks:number;
  resumePhase:"pickup" | "driving";
}
export interface TaxiEvent {
  id:number;tick:number;
  kind:"taxi.started" | "taxi.passenger-waiting" | "taxi.picked-up" | "taxi.paid" | "taxi.invalid-stop" | "taxi.blocked" | "taxi.route-open" | "taxi.route-skipped" | "taxi.timeout" | "taxi.cancelled" | "taxi.finished" | "taxi.exited";
  tripId:string;routeId:string;passengerId:string;
  cashCents:number;timeBonusCents:number;xp:number;reason:string;
}
export interface TaxiState {
  version:1;kind:"taxi";id:string;playerId:string;seed:number;tick:number;
  configId:string;configHash:string;shiftId:string;phase:TaxiPhase;
  attempt:number;attemptStartedTick:number;shiftRemainingTicks:number;tripIndex:number;
  trip:TaxiTrip;
  previousInteract:boolean;commandSequence:number;nextEventId:number;
  completedFares:number;totalCashCents:number;totalXp:number;paidFareIds:string[];
  /** A bounded HUD/recovery reason. No human text or nondeterministic errors enter the state. */
  reason:string;
  events:TaxiEvent[];
}
export interface TaxiStart {
  /** Unique durable run ID provided by the local mode owner; never a timestamp/random global. */
  readonly id:string;
  readonly playerId:string;
  readonly seed:number;
  readonly tick?:number;
  readonly shiftId?:string;
}
export interface TaxiSettlement {
  id:string;playerId:string;cashCents:number;xp:number;achievements:string[];factionClockMoves:number;
}
const validId = (value:unknown):value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_:/.-]{0,79}$/.test(value) && !["constructor","prototype","__proto__"].includes(value);
const finite = (value:unknown):value is number => typeof value === "number" && Number.isFinite(value);
const integer = (value:unknown,min:number,max:number):value is number => Number.isSafeInteger(value) && (value as number)>=min && (value as number)<=max;
function distanceSquared(a:TaxiPoint,b:TaxiPoint):number {const dx=a.x-b.x,dy=a.y-b.y,dz=a.z-b.z;return dx*dx+dy*dy+dz*dz;}
function planarSquared(a:TaxiPoint,b:TaxiPoint):number {const dx=a.x-b.x,dz=a.z-b.z;return dx*dx+dz*dz;}
function headingGap(a:number,b:number):number {const pi=3.141592653589793,tau=6.283185307179586,d=(a-b)%tau;return Math.abs(d>pi?d-tau:d<-pi?d+tau:d);}
function hash(text:string):string {let value=2166136261;for(const char of text)value=Math.imul(value^char.charCodeAt(0),16777619);return (value>>>0).toString(16).padStart(8,"0");}
function rules(config:TaxiConfig):TaxiRules {return {...DEFAULT_TAXI_RULES,...config.rules};}
function sortedRoutes(config:TaxiConfig):TaxiRoute[] {return [...config.routes].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);}
function sortedShifts(config:TaxiConfig):TaxiShift[] {return [...config.shifts].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);}
function route(config:TaxiConfig,id:string):TaxiRoute {const found=config.routes.find(value=>value.id===id);if(!found)throw new Error("Unknown taxi route");return found;}
function shift(config:TaxiConfig,id:string):TaxiShift {const found=config.shifts.find(value=>value.id===id);if(!found)throw new Error("Unknown taxi shift");return found;}
function point(stop:TaxiStop):boolean {return finite(stop.x)&&finite(stop.y)&&finite(stop.z)&&finite(stop.radiusM)&&stop.radiusM>=1&&stop.radiusM<=20;}
function assertConfig(config:TaxiConfig):void {
  if(config.version!==1||!validId(config.id)||!config.routes.length||config.routes.length>128||!config.shifts.length||config.shifts.length>16)throw new Error("Invalid taxi catalog");
  if(new Set(config.routes.map(value=>value.id)).size!==config.routes.length||new Set(config.shifts.map(value=>value.id)).size!==config.shifts.length)throw new Error("Duplicate taxi catalog IDs");
  for(const value of config.routes){
    if(!validId(value.id)||!point(value.pickup)||!point(value.destination)||planarSquared(value.pickup,value.destination)<50*50
      ||!finite(value.roadDistanceM)||value.roadDistanceM<Math.sqrt(planarSquared(value.pickup,value.destination))||value.roadDistanceM>20_000
      ||!integer(value.timeLimitTicks,10*60,10*60*60)||!integer(value.baseFareCents,1,100_000)
      ||!integer(value.timeBonusCentsPerSecond,0,100)||!integer(value.maxTimeBonusCents,0,100_000)||!integer(value.xp,0,10_000))throw new Error("Invalid taxi route");
  }
  for(const value of config.shifts)if(!validId(value.id)||!["daylight","night","fog-rain"].includes(value.theme)||!value.routeIds.length
    ||new Set(value.routeIds).size!==value.routeIds.length||value.routeIds.some(id=>!config.routes.some(candidate=>candidate.id===id)))throw new Error("Invalid taxi shift");
  const limits=rules(config);
  if(!integer(limits.shiftDurationTicks,60*60,30*60*60)||!integer(limits.pickupWaitTicks,5*60,10*60*60)||!integer(limits.safeStopTicks,1,10*60)
    ||!integer(limits.blockedGraceTicks,1,60*60)||!finite(limits.maxStopSpeedMps)||limits.maxStopSpeedMps<0||limits.maxStopSpeedMps>1
    ||!finite(limits.maxLateralMps)||limits.maxLateralMps<0||limits.maxLateralMps>1||!finite(limits.minPersonClearanceM)||limits.minPersonClearanceM<.75)throw new Error("Invalid taxi rules");
}
/** Ordered, explicit simulation fields: object insertion history and presentation labels cannot change this. */
export function taxiConfigHash(config:TaxiConfig):string {
  const r=rules(config);
  return hash(JSON.stringify([config.id,sortedRoutes(config).map(value=>[value.id,value.pickup.x,value.pickup.y,value.pickup.z,value.pickup.radiusM,value.destination.x,value.destination.y,value.destination.z,value.destination.radiusM,value.roadDistanceM,value.timeLimitTicks,value.baseFareCents,value.timeBonusCentsPerSecond,value.maxTimeBonusCents,value.xp]),sortedShifts(config).map(value=>[value.id,value.theme,[...value.routeIds]]),r.shiftDurationTicks,r.pickupWaitTicks,r.safeStopTicks,r.blockedGraceTicks,r.maxStopSpeedMps,r.maxLateralMps,r.minPersonClearanceM]));
}
function tripFor(config:TaxiConfig,state:Pick<TaxiState,"id"|"seed"|"attempt"|"tripIndex"|"shiftId">):TaxiTrip {
  const itinerary=shift(config,state.shiftId).routeIds;
  // Seed selects a starting offset; the authored itinerary then visits every district route.
  const offset=(Math.imul(state.seed>>>0,1664525)+1013904223)>>>0;
  const selected=itinerary[(offset+state.attempt-1+state.tripIndex)%itinerary.length]!;
  const fareId=`${state.id}:a${state.attempt}:f${state.tripIndex}`;
  return {id:fareId,routeId:selected,passengerId:`${fareId}:passenger`,vehicleId:"",pickupRemainingTicks:rules(config).pickupWaitTicks,tripRemainingTicks:route(config,selected).timeLimitTicks,stopTicks:0,stoppedPose:null,blockedTicks:0,resumePhase:"pickup"};
}
function emit(state:TaxiState,kind:TaxiEvent["kind"],reason="",cashCents=0,timeBonusCents=0,xp=0):void {
  state.events.push({id:state.nextEventId++,tick:state.tick,kind,tripId:state.trip.id,routeId:state.trip.routeId,passengerId:state.trip.passengerId,cashCents,timeBonusCents,xp,reason});
}
function resetStop(state:TaxiState):void {state.trip.stopTicks=0;state.trip.stoppedPose=null;}
function finish(state:TaxiState,phase:"timeout"|"finished",reason:string):void {state.phase=phase;state.reason=reason;resetStop(state);emit(state,phase==="timeout"?"taxi.timeout":"taxi.finished",reason);}
export function createTaxiState(config:TaxiConfig,start:TaxiStart):TaxiState {
  assertConfig(config);
  if(!validId(start.id)||! /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(start.id)||!validId(start.playerId)||! /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(start.playerId)||!integer(start.seed,-2147483648,0xffffffff)||!integer(start.tick??0,0,Number.MAX_SAFE_INTEGER-1))throw new Error("Invalid taxi session start");
  const shifts=sortedShifts(config),selected=start.shiftId??shifts[(start.seed>>>0)%shifts.length]!.id;
  shift(config,selected);
  const state:TaxiState={version:1,kind:"taxi",id:start.id,playerId:start.playerId,seed:start.seed,tick:start.tick??0,configId:config.id,configHash:taxiConfigHash(config),shiftId:selected,phase:"pickup",attempt:1,attemptStartedTick:start.tick??0,shiftRemainingTicks:rules(config).shiftDurationTicks,tripIndex:0,trip:null as unknown as TaxiTrip,previousInteract:false,commandSequence:0,nextEventId:1,completedFares:0,totalCashCents:0,totalXp:0,paidFareIds:[],reason:"",events:[]};
  state.trip=tripFor(config,state);emit(state,"taxi.started");emit(state,"taxi.passenger-waiting");return state;
}
function acceptableVehicle(state:TaxiState,vehicle:TaxiVehiclePose|null):vehicle is TaxiVehiclePose {
  return !!vehicle&&vehicle.playerId===state.playerId&&validId(vehicle.vehicleId)&&vehicle.kind==="vehicle"&&vehicle.manual===true
    &&finite(vehicle.x)&&finite(vehicle.y)&&finite(vehicle.z)&&finite(vehicle.heading)&&finite(vehicle.speedMps)&&finite(vehicle.lateralMps)&&finite(vehicle.personClearanceM)
    &&vehicle.grounded===true&&vehicle.onWater===false;
}
function stopReason(state:TaxiState,ctx:TaxiContext,stop:TaxiStop,limits:TaxiRules):string {
  const vehicle=ctx.vehicle;
  if(!acceptableVehicle(state,vehicle))return "manual-grounded-vehicle-required";
  if(state.phase==="driving"&&vehicle.vehicleId!==state.trip.vehicleId)return "return-to-boarded-vehicle";
  if(planarSquared(vehicle,stop)>stop.radiusM*stop.radiusM||Math.abs(vehicle.y-stop.y)>2)return "outside-stop-zone";
  if(Math.abs(vehicle.speedMps)>limits.maxStopSpeedMps||Math.abs(vehicle.lateralMps)>limits.maxLateralMps)return "stop-vehicle";
  if(vehicle.personClearanceM<limits.minPersonClearanceM)return "keep-people-clear";
  if(state.phase==="pickup"&&ctx.waitingPassengerId!==state.trip.passengerId)return "waiting-passenger-required";
  return "";
}
function advanceSafeStop(state:TaxiState,vehicle:TaxiVehiclePose):void {
  const previous=state.trip.stoppedPose;
  const settled=previous&&previous.vehicleId===vehicle.vehicleId&&distanceSquared(previous,vehicle)<=.05*.05&&headingGap(previous.heading,vehicle.heading)<=.03;
  state.trip.stopTicks=settled?state.trip.stopTicks+1:1;
  if(!settled)state.trip.stoppedPose={x:vehicle.x,y:vehicle.y,z:vehicle.z,heading:vehicle.heading,vehicleId:vehicle.vehicleId};
}
function terminal(phase:TaxiPhase):boolean {return phase==="timeout"||phase==="cancelled"||phase==="finished"||phase==="exited";}
/**
 * Consume one accepted simulation tick. Only geometry/identity observations can pick up/drop off;
 * a command can never claim a fare, a stop, a destination, money, a timer or a passenger.
 */
export function stepTaxi(previous:TaxiState,config:TaxiConfig,ctx:TaxiContext):TaxiState {
  if(!integer(ctx.tick,0,Number.MAX_SAFE_INTEGER-1))throw new Error("Invalid taxi tick");
  if(ctx.tick<=previous.tick)return previous;
  if(ctx.tick!==previous.tick+1)throw new Error("Taxi ticks must be contiguous");
  if(previous.configId!==config.id||previous.configHash!==taxiConfigHash(config))throw new Error("Taxi catalog changed during session");
  if(previous.phase==="exited")return previous;
  const state:TaxiState={...previous,tick:ctx.tick,trip:{...previous.trip,stoppedPose:previous.trip.stoppedPose?{...previous.trip.stoppedPose}:null},paidFareIds:[...previous.paidFareIds],events:[],previousInteract:ctx.interact};
  const limits=rules(config),pressed=ctx.interact&&!previous.previousInteract;
  if(!terminal(state.phase))state.shiftRemainingTicks=Math.max(0,state.shiftRemainingTicks-1);
  const commands=[...ctx.commands??[]].filter(command=>integer(command.sequence,1,Number.MAX_SAFE_INTEGER)&&["next","retry","cancel","exit"].includes(command.kind)).sort((a,b)=>a.sequence-b.sequence||(a.kind<b.kind?-1:a.kind>b.kind?1:0));
  for(const command of commands){
    if(command.sequence<=state.commandSequence)continue;
    state.commandSequence=command.sequence;
    if(command.kind==="exit"){
      state.phase="exited";state.reason="player-exit";resetStop(state);emit(state,"taxi.exited",state.reason);return state;
    }
    if(command.kind==="cancel"&&!terminal(state.phase)&&state.phase!=="fare-complete"){
      state.phase="cancelled";state.reason="player-cancel";resetStop(state);emit(state,"taxi.cancelled",state.reason);return state;
    }
    if(command.kind==="retry"&&(state.phase==="timeout"||state.phase==="cancelled"||state.phase==="finished"||state.phase==="blocked")){
      if(state.paidFareIds.length>=MAX_TAXI_FARES){finish(state,"finished","ledger-capacity");return state;}
      if(state.attempt>=MAX_TAXI_ATTEMPTS){finish(state,"finished","attempt-capacity");return state;}
      state.attempt++;state.attemptStartedTick=state.tick;state.shiftRemainingTicks=limits.shiftDurationTicks;state.tripIndex=0;state.trip=tripFor(config,state);state.phase="pickup";state.reason="";emit(state,"taxi.started","retry");emit(state,"taxi.passenger-waiting");return state;
    }
    if(command.kind==="next"&&(state.phase==="fare-complete"||state.phase==="blocked"&&state.trip.resumePhase==="pickup")){
      if(state.shiftRemainingTicks<=0){finish(state,"finished","shift-timeout");return state;}
      if(state.paidFareIds.length>=MAX_TAXI_FARES){finish(state,"finished","ledger-capacity");return state;}
      if(state.tripIndex>=MAX_TAXI_TRIPS_PER_ATTEMPT-1){finish(state,"finished","trip-capacity");return state;}
      if(state.phase==="blocked")emit(state,"taxi.route-skipped","route-blocked");
      state.tripIndex++;state.trip=tripFor(config,state);state.phase="pickup";state.reason="";emit(state,"taxi.passenger-waiting");return state;
    }
  }
  if(terminal(state.phase))return state;
  if(state.phase==="fare-complete"){
    if(state.shiftRemainingTicks<=0)finish(state,"finished","shift-timeout");
    return state;
  }
  const open=ctx.route.id===state.trip.routeId&&ctx.route.status==="open";
  if(!open){
    if(state.phase!=="blocked"){state.trip.resumePhase=state.phase as "pickup"|"driving";state.trip.blockedTicks=0;state.phase="blocked";resetStop(state);emit(state,"taxi.blocked","route-blocked");}
    state.trip.blockedTicks++;state.reason=ctx.route.status==="unknown"||ctx.route.id!==state.trip.routeId?"route-validation-pending":"route-blocked";
    if(state.trip.blockedTicks>=limits.blockedGraceTicks)finish(state,"timeout","route-blocked");
    else if(state.shiftRemainingTicks<=0)finish(state,"finished","shift-timeout");
    return state;
  }
  if(state.phase==="blocked"){state.phase=state.trip.resumePhase;state.trip.blockedTicks=0;state.reason="";resetStop(state);emit(state,"taxi.route-open");}
  const currentRoute=route(config,state.trip.routeId);
  if(state.phase==="pickup")state.trip.pickupRemainingTicks=Math.max(0,state.trip.pickupRemainingTicks-1);
  else state.trip.tripRemainingTicks=Math.max(0,state.trip.tripRemainingTicks-1);
  const stop=state.phase==="pickup"?currentRoute.pickup:currentRoute.destination;
  state.reason=stopReason(state,ctx,stop,limits);
  if(state.reason)resetStop(state);else advanceSafeStop(state,ctx.vehicle!);
  if(pressed){
    if(state.reason||state.trip.stopTicks<limits.safeStopTicks){
      if(!state.reason)state.reason="hold-still-before-interact";
      emit(state,"taxi.invalid-stop",state.reason);
    }else if(state.phase==="pickup"){
      state.trip.vehicleId=ctx.vehicle!.vehicleId;state.phase="driving";state.reason="";resetStop(state);emit(state,"taxi.picked-up");
    }else{
      if(!state.paidFareIds.includes(state.trip.id)){
        const bonus=Math.min(currentRoute.maxTimeBonusCents,Math.floor(state.trip.tripRemainingTicks/60)*currentRoute.timeBonusCentsPerSecond);
        const cash=currentRoute.baseFareCents+bonus;
        state.paidFareIds.push(state.trip.id);state.completedFares++;state.totalCashCents+=cash;state.totalXp+=currentRoute.xp;
        emit(state,"taxi.paid","",cash,bonus,currentRoute.xp);
      }
      state.phase="fare-complete";state.reason="";resetStop(state);
    }
  }
  // A fare accepted exactly on the last tick earns its base fare, with zero remaining-time bonus.
  if(state.phase==="driving"&&state.trip.tripRemainingTicks<=0)finish(state,"timeout","trip-timeout");
  else if(state.phase==="pickup"&&state.trip.pickupRemainingTicks<=0)finish(state,"timeout","pickup-timeout");
  if(!terminal(state.phase)&&state.shiftRemainingTicks<=0)finish(state,"finished","shift-timeout");
  return state;
}
/** Immutable deterministic presentation; the caller supplies catalog names and original art. */
export function taxiView(state:TaxiState,config:TaxiConfig):{
  title:string;shift:TaxiShift;route:TaxiRoute;phase:TaxiPhase;target:TaxiStop|null;remainingTicks:number;shiftRemainingTicks:number;stopTicks:number;stopRequiredTicks:number;canNext:boolean;canRetry:boolean;reason:string;
}{
  const selected=route(config,state.trip.routeId),phase=state.phase==="blocked"?state.trip.resumePhase:state.phase;
  return {title:config.title??DEFAULT_TAXI_TITLE,shift:shift(config,state.shiftId),route:selected,phase:state.phase,target:phase==="pickup"?selected.pickup:phase==="driving"?selected.destination:null,remainingTicks:phase==="pickup"?state.trip.pickupRemainingTicks:state.trip.tripRemainingTicks,shiftRemainingTicks:state.shiftRemainingTicks,stopTicks:state.trip.stopTicks,stopRequiredTicks:rules(config).safeStopTicks,canNext:state.shiftRemainingTicks>0&&(state.phase==="fare-complete"||state.phase==="blocked"&&state.trip.resumePhase==="pickup"),canRetry:state.attempt<MAX_TAXI_ATTEMPTS&&state.paidFareIds.length<MAX_TAXI_FARES&&["timeout","cancelled","finished","blocked"].includes(state.phase),reason:state.reason};
}
/**
 * This stable aggregate may be offered repeatedly; the campaign owner must consume its ID once
 * through the durable settlement ledger (as applyMatchSettlement does for network modes).
 */
export function taxiSettlement(state:TaxiState):TaxiSettlement|null {
  return state.phase!=="exited"?null:{id:`${state.id}:${state.playerId}`,playerId:state.playerId,cashCents:state.totalCashCents,xp:state.totalXp,achievements:[],factionClockMoves:0};
}
