import { describe, expect, it } from "vitest";
import { createInitialState, makeCar, makeFoot, type AgentState, type SimState } from "../../src/sim/index.ts";
import { carVelocity, impactsOf, resolveVehicleContacts } from "../../src/sim/impacts.ts";
import { hullBandsMeet, hullContact, hullAt, sweepHulls, vehiclePairs, type VehicleHull } from "../../src/sim/vehicle-contacts.ts";
import { emptyWorld } from "./fixtures.ts";
import { boxBlocked } from "../../src/sim/collide.ts";
import { propIndex } from "../../src/sim/props.ts";

const hull=(key:string,x:number,z:number,heading=0,y=0):VehicleHull=>({key,x,z,heading,y,hl:2.2,hw:.95,height:1.5});
const taxi=(id:number,x:number,z:number,heading=0):AgentState=>({id,kind:"robotaxi",x,y:0,z,heading,pitch:0,speed:0,vmax:10,
  edge:"old",dir:1,lane:0,s:12,next:"next",ndir:1,nlane:0,conn:null,node:"",resume:0,lat:0,wait:0,dwell:0,ghost:0,mode:"go",rng:7,dodge:null});
const world=emptyWorld();
function state():SimState {
  const initial=createInitialState(world,3,["a","b"],{x:100,z:100,heading:0});
  return {...initial,version:18,players:{a:{...initial.players.a!,car:makeCar(0,0,0)},b:{...initial.players.b!,car:makeCar(0,-5,Math.PI)}}};
}
const rect=(c:{x:number;y:number;z:number;heading:number},key="p"):VehicleHull=>({...hull(key,c.x,c.z,c.heading,c.y)});

describe("full vehicle hull contacts",()=>{
  it("finds a crossing during the tick even when both final hulls are separate",()=>{
    const a={before:hull("a",-8,0,Math.PI/2),after:hull("a",8,0,Math.PI/2)};
    const b={before:hull("b",0,-8,Math.PI),after:hull("b",0,8,Math.PI)};
    expect(hullContact(a.after,b.after).gap).toBeGreaterThan(0);
    const hit=sweepHulls(a,b)!;expect(hit).not.toBeNull();expect(hit.t).toBeGreaterThan(0);expect(hit.t).toBeLessThan(.5);
    expect(hullContact(hullAt(a,hit.t),hullAt(b,hit.t)).gap).toBeGreaterThanOrEqual(-1e-7);
  });
  it("catches an oblique corner and leaves adjacent lanes and height-separated decks clear",()=>{
    const a={before:hull("a",0,0,Math.PI/4),after:hull("a",0,-3,Math.PI/4)},b={before:hull("b",2,-4),after:hull("b",2,-4)};
    expect(sweepHulls(a,b)).not.toBeNull();
    expect(sweepHulls({before:hull("a",0,0),after:hull("a",0,-20)},{before:hull("b",2.1,-10),after:hull("b",2.1,10)})).toBeNull();
    const high={before:hull("b",0,-10,Math.PI,5),after:hull("b",0,10,Math.PI,5)};
    expect(sweepHulls({before:hull("a",0,0),after:hull("a",0,-20)},high)).toBeNull();
    expect(hullBandsMeet(hull("a",0,0),high.before)).toBe(false);
  });
  it("allows touching vehicles to separate or travel together",()=>{
    const a={before:hull("a",0,0),after:hull("a",0,-1)},b={before:hull("b",0,-4.401),after:hull("b",0,-5.401)};
    expect(sweepHulls(a,b)).toBeNull();
    expect(sweepHulls({...a,after:hull("a",0,1)},b)).toBeNull();
  });
  it("keeps spatial candidate coverage across cells and long sweeps",()=>{
    const motions=[{before:hull("a",-1000,0),after:hull("a",1000,0)},
      {before:hull("b",15.9,0),after:hull("b",16.1,0)},{before:hull("c",18,0),after:hull("c",18,0)}];
    expect(vehiclePairs(motions)).toEqual([[0,1],[0,2],[1,2]]);
  });
});

describe("final vehicle contact seam",()=>{
  it("exchanges both driving players' momentum, dents once and preserves source state",()=>{
    const before=state(),after={...before,tick:1,players:{a:{...before.players.a!,car:{...before.players.a!.car,z:-.6,speed:30}},
      b:{...before.players.b!,car:{...before.players.b!.car,z:-4.4,speed:30}}}};
    const frozen=JSON.stringify(after),result=resolveVehicleContacts(world,before,after);
    expect(hullContact(rect(result.players.a!.car),rect(result.players.b!.car)).gap).toBeGreaterThanOrEqual(-1e-6);
    expect(carVelocity(result.players.a!.car).vz).toBeGreaterThan(-1);
    expect(carVelocity(result.players.b!.car).vz).toBeLessThan(1);
    expect(impactsOf(result)!.events).toHaveLength(1);expect(result.players.a!.car.hits).toBe(1);expect(result.players.b!.car.hits).toBe(1);
    expect(impactsOf(result)!.cars.a!.condition).toBeLessThan(100);expect(impactsOf(result)!.cars.b!.condition).toBeLessThan(100);
    expect(JSON.stringify(after)).toBe(frozen);
    expect(impactsOf(resolveVehicleContacts(world,before,result))!.events).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it("has an exact legacy no-op and is independent of player/agent insertion order",()=>{
    const before=state(),after={...before,tick:1,players:{a:{...before.players.a!,car:{...before.players.a!.car,z:-.6,speed:30}},b:{...before.players.b!,car:{...before.players.b!.car,z:-4.4,speed:30}}}};
    const legacy={...after,version:17};expect(resolveVehicleContacts(world,before,legacy)).toBe(legacy);
    const reverse={...after,players:{b:after.players.b,a:after.players.a}};
    expect(resolveVehicleContacts(world,before,reverse)).toEqual(resolveVehicleContacts(world,before,after));
  });
  it("keeps manual and service controller memory coherent after contact",()=>{
    const base=state();base.players={a:{...base.players.a!,car:makeCar(100,100,0)},b:{...base.players.b!,car:makeCar(110,100,0)}};
    const a={...taxi(10,0,0),speed:30,manualCar:{...makeCar(0,0,0),speed:30}},b={...taxi(20,0,-5,Math.PI),speed:30,vehicle:{...makeCar(0,-5,Math.PI),speed:30}};
    const before={...base,ext:{...base.ext,agents:{nextId:21,list:[a,b]}}},after={...before,tick:1,ext:{...before.ext,agents:{nextId:21,list:[{...a,z:-.6,manualCar:{...a.manualCar,z:-.6}},{...b,z:-4.4,vehicle:{...b.vehicle,z:-4.4}}]}}};
    const result=resolveVehicleContacts(world,before,after),[manual,service]=result.ext.agents!.list;
    for(const actor of [manual!,service!]){const c=actor.manualCar??actor.vehicle!;expect(c.x).toBe(actor.x);expect(c.z).toBe(actor.z);expect(c.heading).toBe(actor.heading);expect(c.speed).toBeCloseTo(actor.speed,9);}
    expect(hullContact({...rect(manual!),hl:2.5,hw:1},{...rect(service!),hl:2.5,hw:1}).gap).toBeGreaterThanOrEqual(-1e-6);
  });
  it("restores a refused NPC's full path cursor and bounds overlap recovery away from feet",()=>{
    const base=state();base.players.b={...base.players.b!,car:makeCar(100,100,0)};
    const npc=taxi(10,0,-5,Math.PI),before={...base,ext:{...base.ext,agents:{nextId:11,list:[npc]}}};
    const after={...before,tick:1,players:{...base.players,a:{...base.players.a!,car:{...base.players.a!.car,z:-.5,speed:10}}},
      ext:{...before.ext,agents:{nextId:11,list:[{...npc,z:-4.5,s:14,edge:"new",next:"later",conn:[1,2,3,4,5,6,7,8],trafficRoute:[{edge:"later",dir:1 as const,lane:0}]}]}}};
    const result=resolveVehicleContacts(world,before,after),out=result.ext.agents!.list[0]!;
    expect(out.s).toBe(npc.s);expect(out.edge).toBe(npc.edge);expect(out.conn).toBeNull();expect(out.trafficRoute).toBeUndefined();
    const overlap=state();overlap.players.b={...overlap.players.b!,car:makeCar(0,-3.9,Math.PI),mode:"foot",foot:makeFoot(0,0,-6.45,0)};
    const recovery=resolveVehicleContacts(world,overlap,{...overlap,tick:1});
    expect(recovery.players.b!.foot).toEqual(overlap.players.b!.foot);
    expect(Math.abs(recovery.players.a!.car.z-overlap.players.a!.car.z)).toBeLessThanOrEqual(.5+1e-9);
    expect(Math.abs(recovery.players.b!.car.z-overlap.players.b!.car.z)).toBeLessThanOrEqual(.5+1e-9);
    expect(hullContact(rect(recovery.players.a!.car),rect(recovery.players.b!.car)).gap).toBeGreaterThan(hullContact(rect(overlap.players.a!.car),rect(overlap.players.b!.car)).gap);
  });
  it("does not impulse a later target after an earlier third body shortens the trajectory",()=>{
    const initial=state(),before={...initial,players:{
      a:{...initial.players.a!,car:makeCar(0,0,0)},b:{...initial.players.b!,car:makeCar(0,-12,0)},
      c:{...initial.players.b!,id:"c",car:makeCar(0,-6,0)},
    }},after={...before,tick:1,players:{...before.players,a:{...before.players.a,car:{...before.players.a.car,z:-10,speed:30}}}};
    const result=resolveVehicleContacts(world,before,after);
    expect(result.players.b!.car.speed).toBe(0);expect(impactsOf(result)?.events.some(e=>e.a==="p:b"||e.b==="p:b")).toBe(false);
    expect(result.players.a!.car.z).toBeGreaterThan(-2);expect(impactsOf(result)!.events).toHaveLength(1);
  });
  it("preserves world velocity when a collision shortens the proposed turn",()=>{
    const initial=state(),before={...initial,players:{a:{...initial.players.a!,car:makeCar(0,0,0)},b:{...initial.players.b!,car:makeCar(2.5,-3,0)}}};
    const after:SimState={...before,tick:1,players:{...before.players,a:{...before.players.a!,car:{...before.players.a!.car,heading:Math.PI/2,speed:10,lateral:3}}},
      ext:{...before.ext,impacts:{version:1,nextId:2,cars:{},events:[{id:1,tick:1,kind:"car-car",a:"p:a",b:"p:b",x:1,y:0,z:-1,speed:0,dv:0}]}}};
    const wanted=carVelocity(after.players.a!.car),result=resolveVehicleContacts(world,before,after),actual=carVelocity(result.players.a!.car);
    expect(result.players.a!.car.heading).toBeLessThan(Math.PI/2);
    expect(actual.vx).toBeCloseTo(wanted.vx,7);expect(actual.vz).toBeCloseTo(wanted.vz,7);expect(impactsOf(result)!.events).toHaveLength(1);
  });
  it("never recovers an inherited vehicle overlap into an intact mature tree",()=>{
    const treeWorld={...world,props:[{id:"tree:recovery",kind:"tree" as const,x:0,z:2.6,height:10}]};
    const before=state();before.players.b={...before.players.b!,car:makeCar(0,-3.9,0)};
    const tree=propIndex(treeWorld).byId.get("tree:recovery")!;
    const blocked=(s:SimState)=>boxBlocked(treeWorld,rect(s.players.a!.car),.3,[{x:tree.x,z:tree.z,r:tree.r,person:false}],1.5);
    expect(tree.breakSpeed).toBe(Infinity);expect(blocked(before)).toBe(false);
    const result=resolveVehicleContacts(treeWorld,before,{...before,tick:1});
    expect(blocked(result)).toBe(false);
    expect(hullContact(rect(result.players.a!.car),rect(result.players.b!.car)).gap)
      .toBeGreaterThan(hullContact(rect(before.players.a!.car),rect(before.players.b!.car)).gap);
  });
  it("does not block bounded recovery on a broken tree or above its height band",()=>{
    const treeWorld={...world,props:[{id:"tree:recovery",kind:"tree" as const,x:0,z:2.6,height:10}]};
    const before=state();before.players.b={...before.players.b!,car:makeCar(0,-3.9,0)};
    const broken:SimState={...before,ext:{...before.ext,impacts:{version:1,nextId:1,events:[],cars:{},
      props:{"tree:recovery":{kind:"tree",tick:0,state:"fallen",dir:0}}}}};
    const high:SimState={...before,players:{a:{...before.players.a!,car:{...before.players.a!.car,y:12}},
      b:{...before.players.b!,car:{...before.players.b!.car,y:12}}}};
    for(const initial of [broken,high]){
      const result=resolveVehicleContacts(treeWorld,initial,{...initial,tick:1});
      expect(result.players.a!.car.z).toBeGreaterThan(.2);
      expect(result.players.a!.car.y).toBe(initial.players.a!.car.y);
    }
  });
  it("caps each body's recovery across a dense cluster of inherited overlaps",()=>{
    const initial=state(),before={...initial,players:{
      a:{...initial.players.a!,car:makeCar(0,0,0)},b:{...initial.players.b!,car:makeCar(0,-3.8,0)},
      c:{...initial.players.b!,id:"c",car:makeCar(0,3.8,0)},d:{...initial.players.b!,id:"d",car:makeCar(1.7,0,0)},
    }};
    const result=resolveVehicleContacts(world,before,{...before,tick:1});
    for(const id of Object.keys(before.players) as Array<keyof typeof before.players>){const a=before.players[id]!.car,b=result.players[id]!.car;expect(Math.hypot(a.x-b.x,a.z-b.z)).toBeLessThanOrEqual(.5+1e-9);}
  });
});
