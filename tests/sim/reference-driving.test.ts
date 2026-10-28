import { describe, expect, it } from "vitest";
import { CAR, SIM_VERSION, canonicalJson, createInitialState, createGameSystems, hashState, makeCar, step, stepCar, upgradeState, type AgentState, type CarState, type InputFrame, type SimInput, type SimState } from "../../src/sim/index.ts";
import { REFERENCE_DRIVE, referenceDriveSpeed } from "../../src/sim/reference-driving.ts";
import { vehicleOfCar, zoneDistance } from "../../src/sim/dodge.ts";
import reference from "../golden/reference-driving-be65d0a.json";
import saved18 from "../golden/legacy-saves/v18-pre-reference-driving.json";
import { deepFreeze } from "../helpers.ts";
import { emptyWorld, loadDevWorldWithRoads, terrainWorld } from "./fixtures.ts";

const world=emptyWorld(),idle:SimInput={throttle:0,steer:0,brake:0,actions:0};
const drive=(c:CarState,input:SimInput,traction=1)=>stepCar(world,c,input,[],traction,[],CAR,19);
const run=(c:CarState,ticks:number,input:SimInput,traction=1)=>{for(let t=0;t<ticks;t++)c=drive(c,input,traction);return c;};

describe("SIM19 city-road reference handling",()=>{
  it.each(reference.scenarios)("matches the pinned original controller trajectory: $name",scenario=>{
    expect(reference.sourceCommit).toBe("be65d0ab61b24718b6da8886b7d7bed2d68ac178");
    let c:CarState={...makeCar(0,0,0),...scenario.initial};
    for(let tick=1;tick<=scenario.ticks;tick++){
      c=drive(c,scenario.input);
      const pin=scenario.checkpoints.find(p=>p.tick===tick);
      if(pin)for(const field of ["x","z","heading","speed","lateral","yawRate","steer"] as const)expect(Math.abs(c[field]-pin[field]),`${scenario.name} tick${tick} ${field}; deterministic dmath versus native upstream Math`).toBeLessThan(5e-6);
    }
  });
  it("coasts down at city-road pace while opposite pedal brakes before reversing",()=>{
    const start={...makeCar(0,0,0),speed:50/3.6};
    const coast=run(start,300,idle);expect(coast.speed*3.6).toBeCloseTo(33.07,0);
    let legacy=start;for(let i=0;i<300;i++)legacy=stepCar(world,legacy,idle);
    expect(legacy.speed-coast.speed).toBeGreaterThan(2);
    const stopped=run(start,90,{...idle,throttle:-1});expect(stopped.speed).toBeGreaterThanOrEqual(0);expect(stopped.speed).toBeLessThan(.2);
    expect(-stopped.z).toBeGreaterThan(9.8);expect(-stopped.z).toBeLessThan(10.6);
    expect(run(stopped,90,{...idle,throttle:-1}).speed).toBeLessThan(-5);
    expect(referenceDriveSpeed(44,1,0,1/120)).toBeGreaterThan(36); // Existing collision momentum above powered limit decays; it is not clipped away.
  });
  it("has parking lock, calm high-speed steering and symmetric reverse steering",()=>{
    const slow=run({...makeCar(0,0,0),speed:5},60,{...idle,steer:1});
    const fast=run({...makeCar(0,0,0),speed:25},60,{...idle,steer:1});
    const reverse=run({...makeCar(0,0,0),speed:-5},60,{...idle,steer:1});
    expect(fast.steer).toBeLessThan(slow.steer/3);expect(Math.abs(fast.speed*fast.yawRate)).toBeLessThanOrEqual(REFERENCE_DRIVE.grip+.01);
    expect(slow.heading).toBeGreaterThan(0);expect(reverse.heading).toBeLessThan(0);expect(reverse.heading).toBeCloseTo(-slow.heading,5);
    expect(run(makeCar(0,0,0),60,{...idle,steer:1}).heading).toBe(0);
    for(const direction of [-1,1])expect(run({...makeCar(0,0,0),speed:-direction*10,lateral:2,yawRate:direction},180,{...idle,throttle:direction,steer:1}).speed*direction).toBeGreaterThan(5);
  });
  it("retains wet-road grip limits, slower stopping and a recoverable handbrake",()=>{
    const start={...makeCar(0,0,0),speed:20};
    const dry=run(start,300,{...idle,brake:1}),wet=run(start,300,{...idle,brake:1},.5);
    expect(dry.speed).toBe(0);expect(wet.speed).toBe(0);expect(-wet.z).toBeGreaterThan(-dry.z*1.5);
    expect(Math.abs(run(start,30,{...idle,steer:1},.5).yawRate)).toBeLessThan(Math.abs(run(start,30,{...idle,steer:1}).yawRate));
    const slide=run(start,20,{...idle,steer:1,brake:1});expect(slide.grip).toBeLessThan(.5);expect(slide.speed).toBeLessThan(start.speed);expect(Math.abs(slide.lateral)).toBeGreaterThan(0);
    expect(run(slide,90,{...idle,throttle:.4}).grip).toBeGreaterThan(.95);
  });
  it("preserves impact momentum while tire correction dissipates slip without adding unpowered energy",()=>{
    expect(run({...makeCar(0,0,0),speed:8},6,idle).speed).toBeGreaterThan(7.7);
    const sideways={...makeCar(0,0,0),lateral:8};expect(Math.abs(run(sideways,6,idle).lateral)).toBeGreaterThan(6.9);expect(Math.abs(run(sideways,120,idle).lateral)).toBeLessThan(.1);
    let c={...makeCar(0,0,0),speed:20,lateral:3,yawRate:1},energy=c.speed*c.speed+c.lateral*c.lateral;
    for(let i=0;i<240;i++){c=drive(c,{...idle,steer:1});const next=c.speed*c.speed+c.lateral*c.lateral;expect(next).toBeLessThanOrEqual(energy+1e-9);energy=next;}
  });
  it("keeps SF hill gravity and a stationary car's parking hold",()=>{
    const hill=terrainWorld((_x,z)=>-.15*z,100,5),start={...makeCar(0,0,0),speed:10};
    let uphill=start,downhill={...start,heading:Math.PI};
    for(let i=0;i<60;i++){uphill=stepCar(hill,uphill,idle,[],1,[],CAR,19);downhill=stepCar(hill,downhill,idle,[],1,[],CAR,19);}
    expect(downhill.speed).toBeGreaterThan(uphill.speed+2);
    expect(stepCar(hill,makeCar(0,0,0),idle,[],1,[],CAR,19).speed).toBe(0);
    expect(uphill.y).toBeGreaterThan(0);expect(downhill.y).toBeLessThan(0);
  });
  it("stays inside the existing pedestrian escape reach for steering, slip and impact yaw",()=>{
    for(const speed of [-10,0,5,25,55])for(const lateral of [-4,4])for(const yawRate of [-2,0,2])for(const steer of [-1,1])for(const throttle of [-1,0,1])for(const brake of [0,1]){
      const c={...makeCar(0,0,0),speed,lateral,yawRate},next=drive(c,{...idle,steer,throttle,brake});
      const reach=vehicleOfCar("p",c,null,world),fx=Math.sin(next.heading),fz=-Math.cos(next.heading),rx=-fz,rz=fx;
      for(const fore of [-CAR.halfLength,CAR.halfLength])for(const side of [-CAR.halfWidth,CAR.halfWidth])expect(zoneDistance(reach,next.x+fore*fx+side*rx,next.z+fore*fz+side*rz)).toBeLessThanOrEqual(1e-8);
    }
  });
  it("the normal game step keeps the19 driving profile while18 and standalone callers retain legacy handling",()=>{
    let state=createInitialState(world,7,["p"],{x:0,z:0,heading:0});expect(state.version).toBe(26);
    const initial={...state,players:{p:{...state.players.p!,car:{...state.players.p!.car,speed:50/3.6}}}};
    state=initial;let old:SimState={...initial,version:18};
    for(let t=0;t<300;t++){state=step(world,state,{p:idle},[],[]);old=step(world,old,{p:idle},[],[]);}
    expect(state.players.p!.car.speed*3.6).toBeCloseTo(33.07,0);expect(old.players.p!.car.speed).toBeGreaterThan(state.players.p!.car.speed+2);
    expect(stepCar(world,initial.players.p!.car,idle)).toEqual(stepCar(world,initial.players.p!.car,idle,[],1,[],CAR,18));
  });
  it("a normally controlled H taxi uses the same19 profile and keeps both body memories aligned",()=>{
    const base=createInitialState(world,7,["p"],{x:100,z:100,heading:0});
    const car={...makeCar(0,0,0),speed:50/3.6};
    const taxi={id:1001,kind:"robotaxi",x:0,y:0,z:0,heading:0,pitch:0,speed:car.speed,vmax:12,edge:"",dir:1,lane:0,s:0,next:"",ndir:1,nlane:0,conn:null,node:"",resume:0,lat:0,wait:0,dwell:0,ghost:0,mode:"go",rng:7,dodge:null,manualCar:car} as AgentState;
    let state:SimState={...base,players:{p:{...base.players.p!,ride:{agentId:taxi.id,manual:true,x:0,y:0,z:0,heading:0,speed:car.speed,goal:null,exitPending:false}}},ext:{...base.ext,agents:{nextId:1002,list:[taxi]}}};
    for(let t=0;t<300;t++)state=step(world,state,{p:idle},[],[]);
    const driven=state.ext.agents!.list.find(a=>a.id===taxi.id)!;expect(driven.speed*3.6).toBeCloseTo(33.07,0);expect(driven.manualCar!.speed).toBe(driven.speed);expect(driven.manualCar!.z).toBe(driven.z);expect(state.players.p!.ride!.z).toBe(driven.z);
  });
});

describe("actual18 save and replay preservation",()=>{
  it("preserves every actual18 saved field on upgrade and its unupgraded continuation hashes",()=>{
    expect(saved18.sourceCommit).toBe("a904848f0fd5aeebde4b6cd0a0a5ff7572dd07b4");expect(saved18.simVersion).toBe(18);
    const old=deepFreeze(saved18.state) as unknown as SimState,before=canonicalJson(old);expect(hashState(old)).toBe(saved18.hash);
    const current=upgradeState(old);expect(current).toEqual({...old,version:SIM_VERSION});expect(current.players).toBe(old.players);expect(current.ext).toBe(old.ext);expect(canonicalJson(old)).toBe(before);
    const {world}=loadDevWorldWithRoads(),systems=createGameSystems({wave:3});let state=JSON.parse(before) as SimState;const hashes:string[]=[];
    for(const [i,frame]of saved18.frames.entries()){state=step(world,state,frame.inputs as InputFrame,frame.events,systems);if(i%30===29)hashes.push(hashState(state));}
    expect(hashes).toEqual(saved18.originalHashesEvery30);
  });
  it("continues19 identically across JSON save/restore and player insertion order",()=>{
    const {world}=loadDevWorldWithRoads(),systems=createGameSystems({wave:3});
    const run=(restore:boolean)=>{let s=upgradeState(JSON.parse(JSON.stringify(saved18.state)) as SimState);for(const[i,f]of saved18.frames.entries()){s=step(world,s,f.inputs as InputFrame,f.events,systems);if(restore&&i===59)s=JSON.parse(canonicalJson(s)) as SimState;}return s;};
    expect(run(true)).toEqual(run(false));
    const base=createInitialState(world,7,["a","b"],{x:0,z:0,heading:0}),reverse={...base,players:{b:base.players.b!,a:base.players.a!}},input={a:{...idle,throttle:1},b:{...idle,throttle:1,steer:.6}};
    expect(step(world,base,input,[],[])).toEqual(step(world,reverse,{b:input.b,a:input.a},[],[]));
  });
});
