import { facts } from "../player/common.ts";
import type { GameplayContext } from "../player/types.ts";

export interface FactionRecord {pauser:number;accelerator:number}
export interface DoomClockState {months:number;lastDay:number;resets:number;winters:number;pausedUntil:number;winterUntilDay:number;factions:Record<string,FactionRecord>;factCursors:Record<string,number>}
export interface DoomChange {kind:"world.agi-achieved"|"world.ai-winter"|"faction.changed";playerId:string;amount:number}
export function createDoomClock():DoomClockState{return {months:24,lastDay:-1,resets:0,winters:0,pausedUntil:0,winterUntilDay:-1,factions:{},factCursors:{}};}
/** A day of hype advances one month; completed contracts move three months. */
export function stepDoomClock(previous:DoomClockState,ctx:GameplayContext,tick:number):{state:DoomClockState;events:DoomChange[]} {
 const state:DoomClockState={...previous,factions:{},factCursors:{...previous.factCursors}},events:DoomChange[]=[];
 for(const id of Object.keys(previous.factions).sort())state.factions[id]={...previous.factions[id]!};
 const day=Number.isSafeInteger(ctx.day)&&ctx.day>=0?ctx.day:Math.max(0,previous.lastDay);
 if(previous.lastDay>=0&&day>previous.lastDay)state.months-=day-previous.lastDay;
 state.lastDay=Math.max(day,previous.lastDay);
 for(const fact of facts(ctx,tick,state.factCursors)){
  if(fact.kind==="world.agi-trigger")state.months=0;
  if(fact.kind!=="faction.pauser-completed"&&fact.kind!=="faction.accelerator-completed")continue;
  const own=state.factions[fact.playerId]??{pauser:0,accelerator:0};state.factions[fact.playerId]=own;
  const pauser=fact.kind==="faction.pauser-completed";if(pauser)own.pauser++;else own.accelerator++;
  state.months+=pauser?3:-3;events.push({kind:"faction.changed",playerId:fact.playerId,amount:pauser?3:-3});
 }
 if(state.months<=0){state.months=24;state.resets++;state.pausedUntil=tick+180;events.push({kind:"world.agi-achieved",playerId:"",amount:state.resets});}
 if(state.months>=48){state.months=24;state.winters++;state.winterUntilDay=day+1;events.push({kind:"world.ai-winter",playerId:"",amount:state.winters});}
 return {state,events};
}
export function factionFor(clock:DoomClockState,playerId:string):"pauser"|"accelerator"|"unaffiliated" {
 const own=clock.factions[playerId];return !own||own.pauser===own.accelerator?"unaffiliated":own.pauser>own.accelerator?"pauser":"accelerator";
}
export function doomEffects(clock:DoomClockState,day:number,tick:number){
 const crunch=clock.months<12,cooling=clock.months>36,winter=day<clock.winterUntilDay;
 return {bountyMultiplier:crunch?1.25:cooling?.8:1,badRateMultiplier:crunch?1.5:cooling?.7:1,robotSpeedMultiplier:winter?.9:1,associatesAnswer:!winter,adMultiplier:crunch?2:1,paused:tick<clock.pausedUntil};
}
