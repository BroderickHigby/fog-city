import {describe,it,expect} from "vitest";
import {buildWorld,createInitialState,DAY_TICKS,WEEK_TICKS,fogDensity,rainDensity,dailyWeather,createFogSystem,createClockSystem,gameTime,step,type SimState} from "../../src/sim/index.ts";
import {toLocal} from "../../src/geo/project.ts";
import {createMissions} from "../../src/sim/missions/system.ts";
const world=buildWorld([]);
const atHour=(hour:number,day=0):SimState=>{const state=createInitialState(world,42,[],{x:0,z:0,heading:0});return {...state,ext:{clock:{version:1 as const,elapsedTicks:day*DAY_TICKS+(hour>=8?hour-8:hour+16)*3600}}};};
const west=toLocal(37.76,-122.5),marina=toLocal(37.803,-122.435),east=toLocal(37.757,-122.39);
describe("seeded per-position weather",()=>{
 it("arrives from the west, reaches Marina later and thins by late morning",()=>{
  expect(fogDensity(world,atHour(19),west.x,west.z)).toBeGreaterThan(.6);
  expect(fogDensity(world,atHour(18),marina.x,marina.z)).toBeLessThan(fogDensity(world,atHour(22),marina.x,marina.z));
  expect(fogDensity(world,atHour(22),west.x,west.z)).toBeGreaterThan(fogDensity(world,atHour(22),east.x,east.z));
  expect(fogDensity(world,atHour(12),west.x,west.z)).toBe(0);
 });
 it("keeps weather deterministic, winter-only rain and one tide day each week",()=>{
  let wet=0,tides=0;
  for(let day=0;day<28;day++){
   const state=atHour(12,day),before=JSON.stringify(state);
   expect(dailyWeather(state)).toEqual(dailyWeather(state));expect(dailyWeather(state).rain).toBe(false);
   if(dailyWeather(state).kingTide)tides++;
   expect(JSON.stringify(state)).toBe(before);
  }
  expect(tides).toBe(4);
  for(let day=28;day<56;day++)if(dailyWeather(atHour(12,day)).rain)wet++;
  expect(wet).toBeGreaterThan(3);expect(wet).toBeLessThan(17);
  expect(rainDensity(atHour(12))).toBe(0);
 });
 it("records authored night windows once and expires them without host time",()=>{
  let state=atHour(12);
  state={...state,ext:{...state.ext,missions:{...createMissions(),events:[{id:1,tick:0,kind:"mission.weather-request",playerId:"p",targetId:"marine-layer",amount:0,detail:JSON.stringify({night:true,fog:.8,durationTicks:10})}]}}};
  const systems=[createClockSystem(),createFogSystem()];
  state=step(world,state,{},[],systems);
  expect(gameTime(state).hour).toBe(22);expect(state.ext.fog!.windows).toHaveLength(1);
  expect(fogDensity(world,state,east.x,east.z)).toBeGreaterThanOrEqual(.8);
  for(let tick=0;tick<11;tick++)state=step(world,state,{},[],systems);
  expect(state.ext.fog!.windows).toHaveLength(0);
 });
});
