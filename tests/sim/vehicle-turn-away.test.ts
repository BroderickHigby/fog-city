import { describe, expect, it } from "vitest";
import { CAR, createInitialState, makeCar, makeFoot, step, type SimState } from "../../src/sim/index.ts";
import { hullAt, hullContact, sweepHulls, type VehicleHull } from "../../src/sim/vehicle-contacts.ts";
import { emptyWorld } from "./fixtures.ts";

const hull=(key:string,x:number,z:number,heading=0):VehicleHull=>({key,x,y:0,z,heading,hl:CAR.halfLength,hw:CAR.halfWidth,height:CAR.bodyHeight});

/** Independent rectangular SAT: the regression checks actual hulls, not resolver output alone. */
function gap(a:VehicleHull,b:VehicleHull):number {
  const af=[Math.sin(a.heading),-Math.cos(a.heading)],ar=[-af[1]!,af[0]!];
  const bf=[Math.sin(b.heading),-Math.cos(b.heading)],br=[-bf[1]!,bf[0]!];
  return Math.max(...[af,ar,bf,br].map(axis=>{
    const dot=(v:number[])=>Math.abs(v[0]!*axis[0]!+v[1]!*axis[1]!);
    return Math.abs((a.x-b.x)*axis[0]!+(a.z-b.z)*axis[1]!)-a.hl*dot(af)-a.hw*dot(ar)-b.hl*dot(bf)-b.hw*dot(br);
  }));
}

describe("turning away from an existing vehicle contact",()=>{
  it("lets ordinary steering move past a parked corner instead of freezing at the safety skin",()=>{
    const world=emptyWorld(),initial=createInitialState(world,7,["a","b"],{x:100,z:100,heading:0});
    const car={...makeCar(1.901,-4.3,0),speed:5},parked=makeCar(0,0,0);
    let state:SimState={...initial,players:{a:{...initial.players.a!,car},b:{...initial.players.b!,car:parked,mode:"foot",foot:makeFoot(100,0,100,0)}}};
    const input={throttle:0,steer:-1,brake:0,actions:0};
    for(let tick=0;tick<60;tick++){
      state=step(world,state,{a:input});
      const a=state.players.a!.car,b=state.players.b!.car;
      expect(gap(hull("a",a.x,a.z,a.heading),hull("b",b.x,b.z,b.heading)),`tick ${state.tick}`).toBeGreaterThanOrEqual(-1e-8);
    }
    expect(state.players.a!.car.z).toBeLessThan(car.z-.5);
    expect(state.players.a!.car.heading).toBeLessThan(-.01);
    expect(state.players.b!.car.x).toBe(parked.x);
    expect(state.players.b!.car.z).toBe(parked.z);
  });

  it("still catches a rotating corner that enters the other hull from inside the safety skin",()=>{
    const a={before:hull("a",1.901,-4.3),after:hull("a",1.901,-4.3,.1)};
    const b={before:hull("b",0,0),after:hull("b",0,0)};
    expect(gap(a.before,b.before)).toBeGreaterThan(0);
    expect(gap(a.after,b.after)).toBeLessThan(0);
    const hit=sweepHulls(a,b)!;
    expect(hit).not.toBeNull();expect(hit.t).toBeGreaterThan(0);expect(hit.t).toBeLessThan(1);
    expect(gap(hullAt(a,hit.t),b.before)).toBeGreaterThanOrEqual(-1e-7);
  });

  it("does not tunnel through a full body when a close parallel contact starts moving across it",()=>{
    const a={before:hull("a",1.9001,0),after:hull("a",-6,0)};
    const b={before:hull("b",0,0),after:hull("b",0,0)};
    expect(gap(a.after,b.after)).toBeGreaterThan(0);
    const hit=sweepHulls(a,b)!;
    expect(hit).not.toBeNull();expect(hit.t).toBeGreaterThan(0);expect(hit.t).toBeLessThan(.01);
    expect(hullContact(hullAt(a,hit.t),b.before).gap).toBeGreaterThanOrEqual(-1e-7);
  });
});
