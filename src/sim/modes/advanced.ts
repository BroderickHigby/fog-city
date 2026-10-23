import { sortedIds, type SimState, type Spawn } from "../contract.ts";
import { activeBody, createInitialState } from "../step.ts";
import type { SimSystemContext } from "../system-contract.ts";
import type { World } from "../world.ts";
import type { JsonObject } from "../extensions.ts";
import { createCrowdState, stepCrowd, type CrowdConfig, type CrowdContext, type CrowdState } from "./crowd.ts";
import { createRoyale, stepRoyale, type RoyaleConfig, type RoyaleContext, type RoyaleState } from "./royale.ts";
import { createVibesState, stepVibes, type VibesCast, type VibesContext, type VibesState } from "./vibes.ts";
import { copyMatchLoadouts, type MatchLoadout, type MatchPayoutEvent } from "./session.ts";

interface BaseSlot {version:1;id:string;settled:boolean;payouts:MatchPayoutEvent[];loadouts:Record<string,MatchLoadout>}
export type AdvancedModeSlot=BaseSlot&(
  {kind:"crowd";state:CrowdState}|{kind:"royale";state:RoyaleState}|{kind:"vibes";state:VibesState}
);
export interface AdvancedModeProviders {
  crowd?:(context:SimSystemContext,state:CrowdState)=>CrowdContext;
  royale?:(context:SimSystemContext,state:RoyaleState)=>RoyaleContext;
  vibes?:(context:SimSystemContext,state:VibesState)=>VibesContext;
}
export function advancedModeOf(state:Readonly<SimState>):AdvancedModeSlot|undefined {
  const slot=state.ext.modes as unknown as AdvancedModeSlot|undefined;
  return slot?.version===1&&["crowd","royale","vibes"].includes(slot.kind)&&slot.state?.version===1?slot:undefined;
}
function encode(slot:AdvancedModeSlot):JsonObject{return JSON.parse(JSON.stringify(slot)) as JsonObject;}
function create(world:World,seed:number,players:string[],spawn:Spawn,slot:AdvancedModeSlot):SimState {
  if(!/^[A-Za-z0-9:_-]{1,96}$/.test(slot.id)||Object.hasOwn(Object.prototype,slot.id)||slot.id==="prototype")throw new Error("Invalid mode instance ID");
  const state=createInitialState(world,seed,players,spawn);state.ext.modes=encode({...slot,loadouts:copyMatchLoadouts(players,slot.loadouts)});return state;
}
const base=(id:string,loadouts:Readonly<Record<string,MatchLoadout>>):BaseSlot=>({version:1,id,settled:false,payouts:[],loadouts:{...loadouts}});
export function createCrowdInstance(world:World,id:string,config:CrowdConfig,spawn:Spawn,loadouts:Readonly<Record<string,MatchLoadout>>={}):SimState {
  const state=createCrowdState(config);return create(world,config.seed,sortedIds(state.players),spawn,{...base(id,loadouts),kind:"crowd",state});
}
export function createRoyaleInstance(world:World,config:RoyaleConfig,spawn:Spawn,loadouts:Readonly<Record<string,MatchLoadout>>={}):SimState {
  const state=createRoyale({...config,tick:0});return create(world,config.seed,sortedIds(state.players),spawn,{...base(config.id,loadouts),kind:"royale",state});
}
export function createVibesInstance(world:World,seed:number,id:string,players:readonly string[],cast:Readonly<Record<string,VibesCast>>,spawn:Spawn,loadouts:Readonly<Record<string,MatchLoadout>>={}):SimState {
  const state=createVibesState(id,players,cast);return create(world,seed,[...players],spawn,{...base(id,loadouts),kind:"vibes",state});
}
function settled(slot:AdvancedModeSlot):AdvancedModeSlot {
  if(slot.settled)return slot;
  const state=slot.state;if(state.phase!=="finished")return slot;
  const ids=slot.kind==="vibes"?slot.state.order:slot.kind==="crowd"?sortedIds(slot.state.players):sortedIds(slot.state.players);
  const payout=ids.map(playerId=>{
    const won=slot.kind==="crowd"?slot.state.winnerTeam!==null&&slot.state.players[playerId]!.team===slot.state.winnerTeam:
      slot.kind==="royale"?slot.state.result?.winners.includes(playerId)===true:slot.state.winnerId===playerId;
    const score=slot.kind==="vibes"?slot.state.demos[playerId]!.score:slot.state.players[playerId]!.score;
    return {id:`${slot.id}:${playerId}`,playerId,xp:Math.max(0,Math.floor(score/10))+(won?100:25),cashCents:Math.min(Math.max(0,Math.floor(score*25)),Math.floor(state.elapsedTicks/3600*7500)),achievements:won?[`${slot.kind}:win`]:[],factionClockMoves:won?1:0};
  });
  return {...slot,settled:true,payouts:payout};
}

/** Mode state updates only; all bodies, attacks and acceptance remain with their owners. */
export function stepAdvancedModes(context:SimSystemContext,providers:AdvancedModeProviders={}):SimState|null {
  const previous=advancedModeOf(context.previous);if(!previous)return null;
  const positions=Object.fromEntries(sortedIds(context.state.players).map(id=>[id,activeBody(context.state.players[id]!)]));
  const common={tick:context.state.tick,positions,combatEvents:context.state.ext.combat?.events??[]};
  let next:AdvancedModeSlot;
  if(previous.kind==="crowd")next={...previous,payouts:[],state:stepCrowd(previous.state,{...common,...providers.crowd?.(context,previous.state),tick:context.state.tick})};
  else if(previous.kind==="royale")next={...previous,payouts:[],state:stepRoyale(previous.state,{...common,...providers.royale?.(context,previous.state),tick:context.state.tick}).state};
  else next={...previous,payouts:[],state:stepVibes(previous.state,{...common,...providers.vibes?.(context,previous.state),tick:context.state.tick})};
  return {...context.state,ext:{...context.state.ext,modes:encode(settled(next))}};
}
