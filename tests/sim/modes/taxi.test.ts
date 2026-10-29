/** Draft destination: tests/sim/modes/taxi.test.ts. NOT EXECUTED in the frozen-source phase. */
import { describe, expect, it } from "vitest";
import { createTaxiState, DEFAULT_TAXI_TITLE, MAX_TAXI_ATTEMPTS, stepTaxi, taxiConfigHash, taxiSettlement, taxiView } from "../../../src/sim/modes/taxi.ts";
import type { TaxiConfig, TaxiContext, TaxiRoute, TaxiState, TaxiVehiclePose } from "../../../src/sim/modes/taxi.ts";

// Synthetic road coordinates only. Integration must supply measured SF road/curb placements.
const route = (id:string,x:number):TaxiRoute => ({id,pickupLabel:"Mission curb",destinationLabel:"SoMa curb",pickupDistrict:"Mission",destinationDistrict:"SoMa",pickup:{x,y:0,z:0,radiusM:3},destination:{x:x+100,y:0,z:0,radiusM:3},roadDistanceM:120,timeLimitTicks:600,baseFareCents:1000,timeBonusCentsPerSecond:10,maxTimeBonusCents:300,xp:20});
const config:TaxiConfig = {version:1,id:"sf-taxi-fixture",routes:[route("mission-soma",0),route("soma-mission",1000)],shifts:[{id:"day",label:"Day shift",theme:"daylight",routeIds:["mission-soma","soma-mission"]},{id:"night",label:"Night shift",theme:"night",routeIds:["soma-mission","mission-soma"]},{id:"weather",label:"Fog and rain",theme:"fog-rain",routeIds:["mission-soma","soma-mission"]}],rules:{safeStopTicks:3,blockedGraceTicks:3,shiftDurationTicks:3600,pickupWaitTicks:300}};
const start = (cfg=config):TaxiState => createTaxiState(cfg,{id:"taxi-run-1",playerId:"p1",seed:7,shiftId:"day"});
function vehicle(state:TaxiState,patch:Partial<TaxiVehiclePose>={}):TaxiVehiclePose {
  const selected=config.routes.find(value=>value.id===state.trip.routeId)!;
  const stop=(state.phase==="driving"||state.phase==="blocked"&&state.trip.resumePhase==="driving")?selected.destination:selected.pickup;
  return {...stop,playerId:"p1",vehicleId:"player-car",kind:"vehicle",manual:true,heading:0,speedMps:0,lateralMps:0,grounded:true,onWater:false,personClearanceM:1,...patch};
}
function tick(state:TaxiState,patch:Partial<TaxiContext>={},cfg=config):TaxiState {
  return stepTaxi(state,cfg,{tick:state.tick+1,vehicle:vehicle(state),route:{id:state.trip.routeId,status:"open"},waitingPassengerId:state.trip.passengerId,interact:false,...patch});
}
function stopAndInteract(state:TaxiState):TaxiState {for(let i=0;i<3;i++)state=tick(state);return tick(state,{interact:true});}
function completed():TaxiState {return stopAndInteract(stopAndInteract(start()));}
function json<T>(value:T):T {return JSON.parse(JSON.stringify(value)) as T;}

describe("isolated deterministic taxi rules",()=>{
  it("selects the same route and shift regardless of catalog insertion order",()=>{
    const reordered:TaxiConfig={...config,routes:[...config.routes].reverse(),shifts:[...config.shifts].reverse()};
    const request={id:"run",playerId:"p1",seed:91};
    expect(createTaxiState(config,request)).toEqual(createTaxiState(reordered,request));
    expect(taxiConfigHash(config)).toBe(taxiConfigHash(reordered));
    expect(taxiView(start(),config).title).toBe(DEFAULT_TAXI_TITLE);
    expect(taxiView(start(),{...config,title:"Fog City Taxi"}).title).toBe("Fog City Taxi");
    expect(config.shifts.map(value=>value.theme)).toEqual(["daylight","night","fog-rain"]);
  });
  it("boards the actual waiting passenger, drops off and pays base plus remaining-time bonus once",()=>{
    const initial=start();const boarded=stopAndInteract(initial);
    expect(boarded.phase).toBe("driving");expect(boarded.trip.vehicleId).toBe("player-car");
    const paid=stopAndInteract(boarded);
    expect(paid.phase).toBe("fare-complete");expect(paid.totalCashCents).toBe(1090);expect(paid.totalXp).toBe(20);
    expect(paid.events.filter(event=>event.kind==="taxi.paid")).toHaveLength(1);
    expect(paid.paidFareIds).toEqual([paid.trip.id]);
    expect(initial.phase).toBe("pickup");expect(initial.totalCashCents).toBe(0);
    const held=tick(paid,{interact:true});expect(held.totalCashCents).toBe(1090);expect(held.events).toEqual([]);
    const next=tick(held,{commands:[{sequence:1,kind:"next"}]});
    expect(next.phase).toBe("pickup");expect(next.trip.id).not.toBe(paid.trip.id);expect(next.trip.routeId).not.toBe(paid.trip.routeId);
    expect(next.totalCashCents).toBe(1090);
  });
  it.each([
    ["foot",{kind:"foot"}], ["passenger controls",{manual:false}], ["another player",{playerId:"p2"}],
    ["moving",{speedMps:1}], ["sideways",{lateralMps:1}], ["airborne",{grounded:false}],
    ["water",{onWater:true}], ["person or animal too close",{personClearanceM:.74}],
    ["wrong level",{y:3}], ["nonfinite pose",{x:NaN}],
  ] as const)("rejects a %s pickup without a fare or passenger transition",(_label,patch)=>{
    let state=start();for(let i=0;i<5;i++)state=tick(state,{vehicle:vehicle(state,patch),interact:i===4});
    expect(state.phase).toBe("pickup");expect(state.trip.stopTicks).toBe(0);expect(state.totalCashCents).toBe(0);
    expect(state.events.some(event=>event.kind==="taxi.invalid-stop")).toBe(true);
  });
  it("requires the live passenger binding and grounded accepted geometry",()=>{
    let state=start();for(let i=0;i<5;i++)state=tick(state,{waitingPassengerId:"different-passenger",interact:i===4});
    expect(state.reason).toBe("waiting-passenger-required");expect(state.phase).toBe("pickup");
    state=tick(state,{vehicle:null});expect(state.trip.stopTicks).toBe(0);
  });
  it("requires release and a fresh Interact edge after a continuous safe stop",()=>{
    let state=tick(start(),{interact:true});expect(state.reason).toBe("hold-still-before-interact");
    for(let i=0;i<5;i++)state=tick(state,{interact:true});
    expect(state.phase).toBe("pickup");state=tick(state);state=tick(state,{interact:true});
    expect(state.phase).toBe("driving");
  });
  it("cumulative slow movement and turning restart the stop timer",()=>{
    let state=start();const origin=vehicle(state).x;
    state=tick(state);state=tick(state,{vehicle:vehicle(state,{x:origin+.04})});expect(state.trip.stopTicks).toBe(2);
    state=tick(state,{vehicle:vehicle(state,{x:origin+.08})});expect(state.trip.stopTicks).toBe(1);
    state=tick(state,{vehicle:vehicle(state,{x:origin+.08,heading:.04})});expect(state.trip.stopTicks).toBe(1);
  });
  it("locks the boarded vehicle and refuses dropoff from a replacement",()=>{
    let state=stopAndInteract(start());for(let i=0;i<4;i++)state=tick(state,{vehicle:vehicle(state,{vehicleId:"replacement"}),interact:i===3});
    expect(state.phase).toBe("driving");expect(state.reason).toBe("return-to-boarded-vehicle");expect(state.totalCashCents).toBe(0);
  });
  it("times out waiting and driving without awarding a fare",()=>{
    let waiting=start();waiting={...waiting,trip:{...waiting.trip,pickupRemainingTicks:1}};
    waiting=tick(waiting,{vehicle:null});expect(waiting.phase).toBe("timeout");expect(waiting.reason).toBe("pickup-timeout");
    let driving=stopAndInteract(start());driving={...driving,trip:{...driving.trip,tripRemainingTicks:1}};
    driving=tick(driving,{vehicle:null});expect(driving.phase).toBe("timeout");expect(driving.reason).toBe("trip-timeout");expect(driving.totalCashCents).toBe(0);
  });
  it("permits a valid last-tick dropoff but pays no remaining-time bonus",()=>{
    let state=stopAndInteract(start());for(let i=0;i<3;i++)state=tick(state);
    state={...state,trip:{...state.trip,tripRemainingTicks:1}};state=tick(state,{interact:true});
    expect(state.phase).toBe("fare-complete");expect(state.totalCashCents).toBe(1000);expect(state.events.find(event=>event.kind==="taxi.paid")?.timeBonusCents).toBe(0);
  });
  it("bounds blocking, freezes the fare clock and resumes only a validated current route",()=>{
    let state=stopAndInteract(start());const remaining=state.trip.tripRemainingTicks,shiftRemaining=state.shiftRemainingTicks;
    state=tick(state,{route:{id:state.trip.routeId,status:"blocked"}});expect(state.phase).toBe("blocked");
    expect(state.trip.tripRemainingTicks).toBe(remaining);expect(state.shiftRemainingTicks).toBe(shiftRemaining-1);
    state=tick(state,{route:{id:"other-route",status:"open"}});expect(state.reason).toBe("route-validation-pending");
    state=tick(state);expect(state.phase).toBe("driving");expect(state.trip.tripRemainingTicks).toBe(remaining-1);expect(state.trip.stopTicks).toBe(1);
    for(let i=0;i<3;i++)state=tick(state,{route:{id:state.trip.routeId,status:"unknown"}});
    expect(state.phase).toBe("timeout");expect(state.reason).toBe("route-blocked");expect(state.totalCashCents).toBe(0);
  });
  it("may skip a blocked waiting passenger but cannot skip a passenger already in the car",()=>{
    let waiting=start();waiting=tick(waiting,{route:{id:waiting.trip.routeId,status:"blocked"}});const priorId=waiting.trip.id;
    waiting=tick(waiting,{commands:[{sequence:1,kind:"next"}]});expect(waiting.phase).toBe("pickup");expect(waiting.trip.id).not.toBe(priorId);
    let boarded=stopAndInteract(start());boarded=tick(boarded,{route:{id:boarded.trip.routeId,status:"blocked"}});const boardedId=boarded.trip.id;
    boarded=tick(boarded,{route:{id:boarded.trip.routeId,status:"blocked"},commands:[{sequence:1,kind:"next"}]});
    expect(boarded.phase).toBe("blocked");expect(boarded.trip.id).toBe(boardedId);
  });
  it("retry creates a new attempt, preserves earned-ledger entries, and replays cannot pay or reset twice",()=>{
    const paid=completed();let state=tick(paid,{commands:[{sequence:1,kind:"next"}]});
    state=tick(state,{commands:[{sequence:2,kind:"cancel"}]});expect(state.phase).toBe("cancelled");
    const priorId=state.trip.id;state=tick(state,{commands:[{sequence:3,kind:"retry"}]});
    expect(state.attempt).toBe(2);expect(state.trip.id).not.toBe(priorId);expect(state.paidFareIds).toEqual(paid.paidFareIds);expect(state.totalCashCents).toBe(paid.totalCashCents);
    const retryId=state.trip.id;state=tick(state,{commands:[{sequence:3,kind:"retry"}]});expect(state.attempt).toBe(2);expect(state.trip.id).toBe(retryId);
    expect(stepTaxi(state,config,{tick:state.tick,vehicle:null,route:{id:"wrong",status:"unknown"},waitingPassengerId:null,interact:true,commands:[{sequence:4,kind:"exit"}]})).toBe(state);
  });
  it("ends the shift on its final tick and caps repeated failed attempts",()=>{
    let state=start();state={...state,shiftRemainingTicks:1};state=tick(state,{vehicle:null});expect(state.phase).toBe("finished");expect(state.reason).toBe("shift-timeout");
    state={...state,attempt:MAX_TAXI_ATTEMPTS};state=tick(state,{commands:[{sequence:1,kind:"retry"}]});expect(state.reason).toBe("attempt-capacity");expect(taxiView(state,config).canRetry).toBe(false);
  });
  it("exposes only a stable aggregate settlement after exit",()=>{
    let state=completed();expect(taxiSettlement(state)).toBeNull();state=tick(state,{commands:[{sequence:1,kind:"exit"}]});
    const settlement=taxiSettlement(state);expect(settlement).toEqual({id:"taxi-run-1:p1",playerId:"p1",cashCents:1090,xp:20,achievements:[],factionClockMoves:0});
    expect(taxiSettlement(json(state))).toEqual(settlement);expect(tick(state,{commands:[{sequence:2,kind:"retry"}]})).toBe(state);
    // The durable campaign settlement ledger, not this reducer, consumes this stable ID once.
  });
  it("continues identically after JSON save/restore and never mutates inputs",()=>{
    let original=stopAndInteract(start());original=tick(original);let restored=json(original);
    const snapshot=JSON.stringify(original),catalogSnapshot=JSON.stringify(config);
    for(let i=0;i<10;i++){const interact=i===4;original=tick(original,{interact});restored=tick(restored,{interact});expect(restored).toEqual(original);}
    expect(JSON.stringify(config)).toBe(catalogSnapshot);expect(JSON.parse(snapshot).phase).toBe("driving");
    const prior=original,priorSnapshot=JSON.stringify(prior);tick(prior);expect(JSON.stringify(prior)).toBe(priorSnapshot);
  });
  it("rejects tick gaps, reward/geometry corruption and mid-run simulation config drift",()=>{
    const state=start(),ctx:TaxiContext={tick:state.tick+2,vehicle:null,route:{id:state.trip.routeId,status:"open"},waitingPassengerId:null,interact:false};
    expect(()=>stepTaxi(state,config,ctx)).toThrow("contiguous");
    expect(()=>start({...config,routes:[{...config.routes[0]!,baseFareCents:-1}]})).toThrow();
    expect(()=>start({...config,routes:[{...config.routes[0]!,destination:config.routes[0]!.pickup}]})).toThrow();
    expect(()=>tick(state,{}, {...config,rules:{...config.rules,safeStopTicks:4}})).toThrow("catalog changed");
    expect(()=>createTaxiState(config,{id:"x".repeat(41),playerId:"p1",seed:1})).toThrow();
  });
});
