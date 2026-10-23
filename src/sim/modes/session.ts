import { createInitialState } from "../step.ts";
import { sortedIds, type SimState, type Spawn } from "../contract.ts";
import type { JsonObject } from "../extensions.ts";
import type { World } from "../world.ts";
import { createMatchState, matchPayout } from "./match.ts";
import type { MatchConfig, MatchPayout, MatchState } from "./types.ts";

/** Financial balances, missions and free-roam runway deliberately do not carry in. */
export interface MatchLoadout { nozzle:string;gadget:string;gear:string;perks:string[];streaks:string[];cosmetics:string[] }
export interface MatchPayoutEvent extends MatchPayout { id:string;playerId:string }
export interface ModeSession {
  version:1;match:MatchState;loadouts:Record<string,MatchLoadout>;
  settled:boolean;payouts:MatchPayoutEvent[];
}

export function encodeSession(session:ModeSession):JsonObject {
  return JSON.parse(JSON.stringify(session)) as JsonObject;
}
export function modeSessionOf(state:Readonly<SimState>):ModeSession|undefined {
  const value=state.ext.modes as unknown as ModeSession|undefined;
  if(!value || value.version!==1 || value.match?.version!==1 || !Array.isArray(value.payouts) || !value.loadouts)return undefined;
  return value;
}

/** A fresh simulation instance; the saved free-roam state is never mutated or referenced. */
export function createMatchSession(world:World,config:MatchConfig,spawn:Spawn,loadouts:Readonly<Record<string,MatchLoadout>>={}):SimState {
  const match=createMatchState({...config,tick:0});
  const state=createInitialState(world,config.seed,sortedIds(match.players),spawn);
  const carry:Record<string,MatchLoadout>={};
  for(const id of sortedIds(match.players)) {
    const item=loadouts[id];if(!item)continue;
    if(item.perks.length>3 || item.streaks.length>3 || item.cosmetics.length>32)throw new Error("Invalid match loadout");
    carry[id]={...item,perks:[...item.perks],streaks:[...item.streaks],cosmetics:[...item.cosmetics]};
  }
  state.ext.modes=encodeSession({version:1,match,loadouts:carry,settled:false,payouts:[]});
  return state;
}

/** Settlement IDs let the profile owner consume each payout once, even after replay. */
export function settleSession(session:ModeSession):ModeSession {
  if(session.settled || session.match.phase!=="finished")return session;
  const payouts=sortedIds(session.match.players).map(playerId=>({id:`${session.match.id}:${playerId}`,playerId,...matchPayout(session.match,playerId)}));
  return {...session,settled:true,payouts};
}
