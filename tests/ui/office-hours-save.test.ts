import { describe,expect,it } from "vitest";
import { buildWorld,createInitialState,createGameSystems,step } from "../../src/sim/index.ts";
import {captureProgression,restoreProgression,validateSavedProgression} from "../../src/save/progression.ts";
import {gameTime} from "../../src/sim/clock/calendar.ts";
import {DEFAULT_CATALOG} from "../../src/sim/player/catalog.ts";
import {canStartActivity} from "../../src/sim/activities/system.ts";
const world=buildWorld([]),systems=createGameSystems({wave:3});
const fresh=()=>step(world,createInitialState(world,1,["p"],{x:0,z:0,heading:0}),{p:{throttle:0,steer:0,brake:1,actions:0}},[],systems);
describe("durable Office Hours booking allowance",()=>{
 it("keeps the day's used bookings, cooldown and unique booking sequence through ordinary save/reload",()=>{
  const state=fresh(),own=state.ext.activities!.players.p!;
  own.officeHoursBookings={day:gameTime(state).dayIndex,count:2};own.officeHoursSequence=17;own.cooldowns={"office-hours":state.tick+500};
  const saved=captureProgression(state,"p"),restored=restoreProgression(fresh(),JSON.parse(JSON.stringify(saved)),"p"),after=restored.ext.activities!.players.p!;
  expect(after.officeHoursBookings).toEqual({day:gameTime(restored).dayIndex,count:2});
  expect(after.officeHoursSequence).toBe(17);expect(after.cooldowns!["office-hours"]).toBe(restored.tick+500);
  const door=DEFAULT_CATALOG.activities.find(a=>a.id==="office-hours")!,done=["demoed-correctly"];
  expect(canStartActivity(door,after,door,restored.tick+600,3,done,gameTime(restored).dayIndex)).toBe(false);
  expect(canStartActivity(door,after,door,restored.tick+600,3,done,gameTime(restored).dayIndex+1)).toBe(true);
 });
 it("starts a new allowance when the saved day already changed and accepts old saves without booking fields",()=>{
  const state=fresh(),own=state.ext.activities!.players.p!;
  own.officeHoursBookings={day:gameTime(state).dayIndex-1,count:2};own.officeHoursSequence=4;
  const restored=restoreProgression(fresh(),captureProgression(state,"p"),"p");
  expect(restored.ext.activities!.players.p!.officeHoursBookings!.count).toBe(0);
  const legacy=captureProgression(fresh(),"p");expect(()=>restoreProgression(fresh(),legacy,"p")).not.toThrow();
 });
 it("rejects malformed booking counts and unbounded cooldowns",()=>{
  const saved=captureProgression(fresh(),"p") as Record<string,unknown>;
  for(const patch of [{officeHoursBookings:{day:0,count:3}},{officeHoursSequence:-1},{officeHoursCooldownTicks:43201}]){
   expect(()=>validateSavedProgression({...saved,activities:{completedIds:[],...patch}} as never)).toThrow();
  }
 });
});
