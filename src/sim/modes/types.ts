import type { CombatEvent } from "../combat-contract.ts";

export type ModeId="botSweep"|"cleanStreets"|"fogRoyale"|"hideInTheCrowd"|"vibesNight";
export interface MatchPlayer {
  id:string; team:number; runway:number; score:number; interruptedUpdates:number;
  downUntil:number; respawnAt:number; reviveTicks:number; reviverId:string;
  eliminated:boolean; bridgeUsed:boolean; duelUsed:boolean; fleeceUntil:number;
}
export interface MatchEvent {id:number;tick:number;kind:string;playerId:string;targetId:string;amount:number;detail:string}
export interface MatchResult {winners:string[];reason:string;elapsedTicks:number}
export interface MatchState {
  version:1;id:string;mode:ModeId;seed:number;tick:number;elapsedTicks:number;durationTicks:number;
  phase:"active"|"finished";players:Record<string,MatchPlayer>;remainingBad:string[];relayId:string;
  lives:number;nextEventId:number;lastCombatTick:number;events:MatchEvent[];result:MatchResult|null;
}
export interface MatchConfig {
  id:string;mode:ModeId;seed:number;players:readonly string[];badRobotIds?:readonly string[];relayId?:string;tick?:number;
  /** Optional shorter clock for a host-chosen variant; never longer than the mode's own limit. */
  durationTicks?:number;
}
export interface MatchPosition {x:number;y:number;z:number}
export interface MatchInput {reviveTarget?:string}
export interface MatchContext {
  /** Global sim tick; omitted for standalone, one-tick drivers. */
  tick?:number;
  positions:Readonly<Record<string,MatchPosition>>;
  inputs?:Readonly<Record<string,MatchInput>>;
  combatEvents?:readonly CombatEvent[];
  armouredIds?:readonly string[];
  paused?:boolean;
  /** A recorded host/server decision to end the match now (SimEvent "mode.end"). */
  endRequested?:boolean;
}
export interface MatchPayout {xp:number;cashCents:number;achievements:string[];factionClockMoves:number}
