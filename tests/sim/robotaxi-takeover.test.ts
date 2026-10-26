import { describe,expect,it } from "vitest";
import { Action,createInitialState,makeFoot,step,canonicalJson,hashState,dodgeExtOf,makeCar,vehicleOfAgent,type SimState,type InputFrame } from "../../src/sim/index.ts";
import { RIDE,takeoverTaxi,canTakeOverTaxi,distanceToTaxi,hailableTaxi } from "../../src/sim/ride.ts";
import { commandeerFacts,createPlayerSystems } from "../../src/sim/player/adapter.ts";
import { gridCity } from "./fixtures.ts";

const world=gridCity(),idle={throttle:0,steer:0,brake:0,actions:0};
const H={p:{...idle,actions:Action.horn}},F={p:{...idle,actions:Action.enterExit}},IDLE={p:idle};
function besideTaxi():SimState {
 const s=createInitialState(world,5,["p"],{x:150,z:0,heading:Math.PI/2});
 const taxi=s.ext.agents!.list.find(a=>a.kind==="robotaxi"&&a.id%8!==7)!;
 taxi.speed=0;
 s.ext.agents!.list=[taxi];
 s.players.p!.mode="foot";
 s.players.p!.foot=makeFoot(taxi.x-Math.cos(taxi.heading)*1.7,0,taxi.z-Math.sin(taxi.heading)*1.7,taxi.heading);
 return s;
}
function drive(s:SimState,n:number,input={...idle,throttle:1}):SimState {
 for(let i=0;i<n;i++) s=step(world,s,{p:input});return s;
}

describe("robotaxi commandeering",()=>{
 it("H drives the same stopped taxi with normal acceleration and steering while the own car stays parked",()=>{
  const start=besideTaxi(),frozen=canonicalJson(start),id=start.ext.agents!.list[0]!.id,own={...start.players.p!.car};
  let s=step(world,start,H);
  expect(s.players.p!.ride).toMatchObject({agentId:id,manual:true,goal:null,exitPending:false});
  expect(s.ext.agents!.list.find(a=>a.id===id)!.manualCar).toBeTruthy();
  const at={...s.players.p!.ride!};
  s=drive(s,120);
  expect(Math.hypot(s.players.p!.ride!.x-at.x,s.players.p!.ride!.z-at.z)).toBeGreaterThan(8);
  expect(s.players.p!.ride!.speed).toBeGreaterThan(5);
  s=drive(s,30,{...idle,throttle:1,steer:.5});
  expect(Math.abs(s.players.p!.ride!.heading-at.heading)).toBeGreaterThan(.01);
  const taxi=s.ext.agents!.list.find(a=>a.id===id)!;
  expect(s.players.p!.ride).toMatchObject({x:taxi.x,y:taxi.y,z:taxi.z,heading:taxi.heading,speed:taxi.speed});
  expect(taxi.manualCar).toMatchObject({x:taxi.x,y:taxi.y,z:taxi.z,heading:taxi.heading,speed:taxi.speed});
  expect(s.players.p!.car.x).toBe(own.x);expect(s.players.p!.car.z).toBe(own.z);
  expect(canonicalJson(start)).toBe(frozen);
 });

 it("H takes over the current autonomous passenger ride without losing its identity or forward velocity",()=>{
  const start=besideTaxi();let s=step(world,start,F),id=s.players.p!.ride!.agentId;
  s=drive(s,120,idle);
  expect(s.players.p!.ride!.speed).toBeGreaterThan(1);
  const old={...s.players.p!.ride!};s=step(world,s,H);
  expect(s.players.p!.ride).toMatchObject({agentId:id,manual:true});
  expect(s.players.p!.ride!.speed).toBeGreaterThan(1);
  expect(Math.hypot(s.players.p!.ride!.x-old.x,s.players.p!.ride!.z-old.z)).toBeLessThan(1);
  const again=step(world,s,H);expect(again.players.p!.ride).toMatchObject({agentId:id,manual:true,exitPending:false});
 });

 it("F brakes, lets the driver out safely, parks at the real pose and allows H to drive it again",()=>{
  let s=drive(step(world,besideTaxi(),H),90),id=s.players.p!.ride!.agentId;
  s=step(world,s,F);
  expect(s.players.p!.ride?.exitPending??true).toBe(true);
  for(let i=0;i<300&&s.players.p!.ride;i++) s=step(world,s,IDLE);
  expect(s.players.p!.mode).toBe("foot");
  expect(s.players.p!.ride).toBeNull();
  const parked=s.ext.agents!.list.find(a=>a.id===id)!;
  expect(parked.manualCar).toBeTruthy();expect(parked.speed).toBe(0);
  expect(distanceToTaxi(parked,s.players.p!.foot!.x,s.players.p!.foot!.z)).toBeGreaterThan(.3);
  const at={x:parked.x,z:parked.z,heading:parked.heading};
  s=drive(s,60,idle);
  expect(s.ext.agents!.list.find(a=>a.id===id)).toMatchObject(at);
  s=step(world,s,H);expect(s.players.p!.ride).toMatchObject({agentId:id,manual:true});
  expect(dodgeExtOf(s).contacts).toBe(0);
 });

 it("rejects moving, civilian, rogue, mission/service, occupied and someone else's hailed taxis",()=>{
  for(const change of [
   (s:SimState)=>{s.ext.agents!.list[0]!.speed=RIDE.boardSpeed+1;},
   (s:SimState)=>{s.ext.agents!.list[0]!.id=7;},
   (s:SimState)=>{s.ext.agents!.list[0]!.runtimeId="service";},
   (s:SimState)=>{s.ext.robots={actors:{r:{legacyId:s.ext.agents!.list[0]!.id,firmware:"bad"}}} as unknown as SimState["ext"]["robots"];},
   (s:SimState)=>{s.ext.robots={actors:{r:{legacyId:s.ext.agents!.list[0]!.id,significant:true}}} as unknown as SimState["ext"]["robots"];},
   (s:SimState)=>{s.ext.robots={actors:{r:{legacyId:s.ext.agents!.list[0]!.id}},missionBindings:{mission:"r"}} as unknown as SimState["ext"]["robots"];},
   (s:SimState)=>{const a=s.ext.agents!.list[0]!;s.players.other={...s.players.p!,id:"other",mode:"vehicle",foot:null,ride:{agentId:a.id,x:a.x,y:a.y,z:a.z,heading:a.heading,speed:0,goal:null,exitPending:false}};},
   (s:SimState)=>{s.players.other={...s.players.p!,id:"other",hail:{agentId:s.ext.agents!.list[0]!.id,untilTick:100}};},
  ]) {
   const s=besideTaxi();change(s);const foot=s.players.p!.foot!;
   expect(takeoverTaxi(world,s,foot.x,foot.z,"p")).toBeNull();
   expect(step(world,s,H,[],[]).players.p!.ride??null).toBeNull();
  }
 });

 it("hailing skips a manually parked taxi and still calls a regular passing taxi",()=>{
  const s=besideTaxi(),parked=s.ext.agents!.list[0]!;
  parked.manualCar=makeCar(parked.x,parked.z,parked.heading,parked.y);
  // Ten metres ahead on the same clear road: too far to board the parked car directly.
  s.players.p!.foot=makeFoot(parked.x,0,parked.z+10,parked.heading);
  const foot=s.players.p!.foot!;
  expect(hailableTaxi(world,s,foot.x,foot.z,"p")).toBeNull();
  const {manualCar:_manual,...normal}=parked;
  const passing={...normal,id:2,z:foot.z+12,speed:8};
  s.ext.agents!.list.push(passing);
  expect(hailableTaxi(world,s,foot.x,foot.z,"p")?.id).toBe(passing.id);
  expect(step(world,s,F).players.p!.hail?.agentId).toBe(passing.id);
 });

 it("two simultaneous takeovers resolve by player ID and a departed driver leaves a braking taxi",()=>{
  const start=besideTaxi();start.players.a={...start.players.p!,id:"a",foot:{...start.players.p!.foot!}};
  const frame:InputFrame={p:H.p,a:H.p};
  let s=step(world,start,frame);
  expect(s.players.a!.ride?.manual).toBe(true);expect(s.players.p!.ride??null).toBeNull();
  const id=s.players.a!.ride!.agentId;s=step(world,s,{a:{...idle,throttle:1}});
  s=step(world,s,IDLE,[{tick:s.tick+1,kind:"player.leave",playerId:"a"}]);
  for(let i=0;i<120;i++) s=step(world,s,IDLE);
  const a=s.ext.agents!.list.find(a=>a.id===id)!;expect(a.speed).toBe(0);expect(a.manualCar).toBeTruthy();
 });

 it("a takeover fact charges one VC star and one reputation, and subsequent horn presses charge nothing",()=>{
  const systems=createPlayerSystems();let s=besideTaxi(),before=s;
  s=step(world,s,H,[],systems);
  expect(commandeerFacts({previous:before,state:s})).toHaveLength(1);
  expect(s.ext.heat!.players.p!.vcQuarters).toBe(4);expect(s.ext.economy!.players.p!.reputation).toBe(49);
  before=s;s=step(world,s,H,[],systems);
  expect(commandeerFacts({previous:before,state:s})).toHaveLength(0);
  expect(s.ext.heat!.players.p!.vcQuarters).toBe(4);expect(s.ext.economy!.players.p!.reputation).toBe(49);
 });

 it("manual forward and reverse driving keeps stationary adults and protected people clear",()=>{
  for(const reverse of [false,true]) for(const protectedPerson of [false,true]) {
   let s=step(world,besideTaxi(),H),id=s.players.p!.ride!.agentId,taxi=s.ext.agents!.list.find(a=>a.id===id)!;
   const heading=taxi.heading,fx=Math.sin(heading),fz=-Math.cos(heading),dir=reverse?-1:1;
   taxi.manualCar={...taxi.manualCar!,speed:dir*12};taxi.speed=dir*12;s.players.p!.ride!.speed=dir*12;
   const person={...taxi,id:1001,kind:"person" as const,runtimeId:"test-person",protected:protectedPerson,child:protectedPerson,x:taxi.x+fx*dir*12,z:taxi.z+fz*dir*12,heading:0,pitch:0,speed:0,manualCar:undefined};
   delete person.manualCar;s.ext.agents!.list.push(person);
   for(let i=0;i<90;i++) {
    s=step(world,s,{p:{...idle,throttle:dir}});
    const a=s.ext.agents!.list.find(a=>a.id===id)!,p=s.ext.agents!.list.find(a=>a.id===1001)!;
    expect(distanceToTaxi(a,p.x,p.z)).toBeGreaterThan(.29);
   }
   expect(dodgeExtOf(s).contacts).toBe(0);expect(dodgeExtOf(s).failures).toBe(0);
  }
 });

 it("a manual taxi physically stops at buildings with its full drawn body and keeps a physical dodge prediction off lane",()=>{
  let s=step(world,besideTaxi(),H),id=s.players.p!.ride!.agentId,taxi=s.ext.agents!.list.find(a=>a.id===id)!;
  // A free physical pose facing the building wall at x=12; the lane metadata intentionally remains old.
  taxi.x=0;taxi.z=40;taxi.heading=Math.PI/2;taxi.speed=15;taxi.manualCar={...taxi.manualCar!,x:0,z:40,heading:Math.PI/2,speed:15};
  s.players.p!.ride={...s.players.p!.ride!,x:0,z:40,heading:Math.PI/2,speed:15};
  const v=vehicleOfAgent(taxi,null,1/60,world);
  expect(v.key).toBe(`a:${id}`);expect(v.route).toBeNull();expect(v.vx).toBeGreaterThan(14);
  s=drive(s,120);
  taxi=s.ext.agents!.list.find(a=>a.id===id)!;
  expect(taxi.x+2.5).toBeLessThanOrEqual(12.01);
  expect(taxi.manualCar!.hits).toBeGreaterThan(0);
  expect(taxi.manualCar).toMatchObject({x:taxi.x,y:taxi.y,z:taxi.z,speed:taxi.speed});
 });

 it("incoming car impacts update taxi physics without a lane snap on the next tick",()=>{
  let s=step(world,besideTaxi(),H),id=s.players.p!.ride!.agentId,taxi=s.ext.agents!.list.find(a=>a.id===id)!;
  taxi.x=40;taxi.z=0;taxi.heading=Math.PI/2;taxi.speed=0;taxi.manualCar={...makeCar(40,0,Math.PI/2),speed:0};
  s.players.p!.ride={...s.players.p!.ride!,x:40,z:0,heading:Math.PI/2,speed:0};
  s.players.other={id:"other",mode:"vehicle",car:{...makeCar(34,0,Math.PI/2),speed:20},foot:null,exitPending:false};
  let hit=false;
  for(let i=0;i<30;i++) {
   const before=s.ext.agents!.list.find(a=>a.id===id)!;
   s=step(world,s,{p:idle,other:{...idle,throttle:1}});
   taxi=s.ext.agents!.list.find(a=>a.id===id)!;
   if(s.ext.impacts && (s.ext.impacts as {events?:{b:string}[]}).events?.some(e=>e.b===`a:${id}`)) hit=true;
   expect(Math.hypot(taxi.x-before.x,taxi.z-before.z)).toBeLessThan(2);
   expect(taxi.knock).toBeUndefined();
   expect(taxi.manualCar).toMatchObject({x:taxi.x,y:taxi.y,z:taxi.z,heading:taxi.heading,speed:taxi.speed});
  }
  expect(hit).toBe(true);expect(taxi.x).toBeGreaterThan(40);
  expect(dodgeExtOf(s).contacts).toBe(0);
 });

 it("does not mutate deeply frozen state while driving, exiting or applying incoming impacts",()=>{
  const freeze=(value:unknown):void=>{if(value&&typeof value==="object"){Object.freeze(value);for(const child of Object.values(value))freeze(child);}};
  const s=drive(step(world,besideTaxi(),H),20),before=canonicalJson(s);freeze(s);
  expect(()=>step(world,s,{p:{...idle,throttle:1,steer:.5}})).not.toThrow();
  expect(()=>step(world,s,F)).not.toThrow();
  expect(canonicalJson(s)).toBe(before);
 });

 it("mid-drive JSON save and replay preserve exact controls and physical parking",()=>{
  let a=drive(step(world,besideTaxi(),H),60),b=JSON.parse(JSON.stringify(a)) as SimState;
  for(let i=0;i<150;i++) {const frame={p:{...idle,throttle:i<60?1:0,steer:i<30?.3:0,brake:i>=60?1:0,actions:i===100?Action.enterExit:0}};a=step(world,a,frame);b=step(world,b,frame);}
  expect(hashState(a)).toBe(hashState(b));expect(dodgeExtOf(a).contacts).toBe(0);
 });
});
