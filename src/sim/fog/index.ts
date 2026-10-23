import type { SimState } from "../contract.ts";
import type { SimSystem } from "../system-contract.ts";
import type { World } from "../world.ts";
import { gameTime, DAY_TICKS } from "../clock/calendar.ts";
import { clamp } from "../dmath.ts";
import { hash32 } from "../rng.ts";
import { toLatLon } from "../../geo/project.ts";

export interface WeatherWindow { id:string; startTick:number; untilTick:number; density:number }
export interface FogState { version:1; missionCursor:number; windows:WeatherWindow[] }
export interface DailyWeather { strength:number; rain:boolean; kingTide:boolean }
/** A day gets one seeded forecast. Reading weather never advances simulation RNG. */
export function dailyWeather(state:Readonly<SimState>):DailyWeather {
  const time=gameTime(state),daily=hash32(state.seed,time.dayIndex,0x57454154);
  return {strength:.65+(daily%351)/1000,rain:time.season==="winter"&&daily%3===0,
    kingTide:time.dayIndex%7===hash32(state.seed,Math.floor(time.dayIndex/7),0x54494445)%7};
}
function overnight(hour:number,start:number):number {
  if(hour>=start)return clamp((hour-start)/2,0,1);
  if(hour<9)return 1;
  return clamp((11-hour)/2,0,1);
}
/** Per-position marine layer: west first, Marina later, downtown only on some nights. */
export function fogDensity(_world:World,state:Readonly<SimState>,x:number,z:number):number {
  if(!Number.isFinite(x)||!Number.isFinite(z))return 0;
  const time=gameTime(state),forecast=dailyWeather(state),p=toLatLon(x,z),hour=time.hour+time.minute/60+time.second/3600;
  const west=clamp((-122.425-p.lon)/.028,0,1);
  const marina=clamp((p.lat-37.787)/.018,0,1)*clamp((-122.41-p.lon)/.015,0,1);
  const downtown=hash32(state.seed,time.dayIndex,0x444f574e)%3===0?overnight(hour,21)*.7:0;
  let density=Math.max(west*overnight(hour,17),marina*overnight(hour,19),downtown*(1-west)*.8)*forecast.strength;
  // Mission windows are recorded deterministic effects, not host-clock overrides.
  for(const front of Array.isArray(state.ext.fog?.windows)?state.ext.fog.windows:[])if(Number.isFinite(front.density)&&front.startTick<=state.tick&&front.untilTick>state.tick)density=Math.max(density,front.density);
  for(const zone of state.ext.combat?.gadgets??[])if(zone.kind==="microclimate"&&zone.untilTick>state.tick){
    const dx=x-zone.x,dz=z-zone.z;if(dx*dx+dz*dz<=zone.radius*zone.radius)density=1;
  }
  return clamp(density,0,1);
}
export function rainDensity(state:Readonly<SimState>):number {
  if(!dailyWeather(state).rain)return 0;
  const time=gameTime(state),start=hash32(state.seed,time.dayIndex,0x5241494e)%18;
  return time.hour>=start&&time.hour<start+6?1:0;
}
/** Consumes authored weather requests once; daylight skips are part of the saved clock. */
export function createFogSystem():SimSystem {
  return {key:"fog",step:({state})=>{
    const raw=state.ext.fog;
    const old=raw?.version===1&&Array.isArray(raw.windows)&&Number.isSafeInteger(raw.missionCursor)?raw:{version:1,missionCursor:0,windows:[]};
    let cursor=old.missionCursor,next=state;
    const windows=old.windows.filter(front=>Number.isFinite(front.density)&&Number.isSafeInteger(front.startTick)&&Number.isSafeInteger(front.untilTick)&&front.untilTick>state.tick);
    for(const event of [...state.ext.missions?.events??[]].sort((a,b)=>a.id-b.id)){
      if(event.id<=cursor)continue;cursor=event.id;
      if(event.kind!=="mission.weather-request")continue;
      let value:unknown;try{value=JSON.parse(event.detail);}catch{continue;}
      if(!value||typeof value!=="object")continue;
      const request=value as {fog?:unknown;durationTicks?:unknown;night?:unknown};
      if(typeof request.fog!=="number"||!Number.isFinite(request.fog)||typeof request.durationTicks!=="number"||!Number.isSafeInteger(request.durationTicks)||request.durationTicks<1||request.durationTicks>7*DAY_TICKS)continue;
      windows.push({id:`${event.targetId}:${event.id}`,startTick:state.tick,untilTick:state.tick+request.durationTicks,density:clamp(request.fog,0,1)});
      if(request.night===true){
        const time=gameTime(next);if(time.hour>=6&&time.hour<19){
          const skip=22*3600-(time.hour*3600+time.minute*60+time.second);
          next={...next,ext:{...next.ext,clock:{version:1,elapsedTicks:(next.ext.clock?.elapsedTicks??next.tick)+skip}}};
        }
      }
    }
    return {...next,ext:{...next.ext,fog:{version:1,missionCursor:cursor,windows}}};
  }};
}
